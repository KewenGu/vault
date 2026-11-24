import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@/lib/auth/user";
import type { Database } from "@/lib/db/types";
import { matchesKeywords, parseKeywords, type Listing } from "@/lib/intel/candidate";
import { HN_QUERY_MAX, HN_WINDOW_DAYS, searchHn } from "@/lib/intel/hackernews";
import { REDDIT_WINDOW_DAYS, listSubreddit, parseSubreddit } from "@/lib/intel/reddit-listing";
import { getServiceClient } from "@/lib/supabase/service";
import { VaultError } from "./errors";
import {
  SIGNAL_STATUSES,
  WATCH_KINDS,
  countSignals,
  createWatch,
  deleteWatch,
  getSignal,
  getWatch,
  listDueWatches,
  listSignals,
  listWatches,
  pruneSignals,
  recordCandidates,
  setSignalStatus,
  updateWatch,
  type Signal,
  type SignalStatus,
  type Watch,
  type WatchKind,
} from "./intel-store";
import { isUuid } from "./map-nodes";
import { saveInput } from "./service";

/**
 * 情报：盯几个来源（Reddit 的版块、Hacker News 上的关键词），有分数过线的新内容就列出来，挑着存进收藏库。
 * 页面的 server action、/api/v1/intel 的接口、后台的定时检查（intel-timer.ts）都调这里。
 *
 * - 不用模型、不花钱：筛选只看分数线和关键词。发现的内容只留标题、链接和一小段开头，不进知识图谱、不拼进提示词；
 *   点了「存入」才变成收藏库里的一条，走平常的读取和理解（那一步照常计费）。
 * - 「去看一次」不抛错：来源读不到（存档出错、接口超时）记在这个来源的 lastError 上，页面上列出来，下次再试。
 * - 没存、放了 30 天的（新的没人看、忽略掉的）自动清掉；存进收藏库的留着。
 */

type Db = SupabaseClient<Database>;

/** 一个人最多盯这么多个来源 */
export const WATCH_MAX = 30;
export const DEFAULT_MIN_SCORE: Record<WatchKind, number> = { subreddit: 50, hn: 30 };
export const MIN_SCORE_MAX = 100_000;
export const KEYWORDS_MAX = 200;
/** 页面上一次列这么多条 */
export const SIGNAL_LIST = 100;
export const SIGNAL_KEEP_DAYS = 30;

export const watchLabel = (w: Pick<Watch, "kind" | "query">) => (w.kind === "subreddit" ? `r/${w.query}` : `HN：${w.query}`);

/** 去看一次的结果：found 这次分数过线的有几条，fresh 其中没见过的；notes 是没看到的；error 是没看成的原因。 */
export type CheckResult = { found: number; fresh: number; notes: string[]; error: string | null };

export type IntelDeps = {
  listSubreddit: (subreddit: string, since: Date) => Promise<Listing>;
  searchHn: (query: string, minScore: number, since: Date) => Promise<Listing>;
  now: () => Date;
};
const defaultDeps: IntelDeps = { listSubreddit: (sub, since) => listSubreddit(sub, since), searchHn, now: () => new Date() };

const DAY = 86_400_000;

/**
 * 去看一个来源：读它这几天的内容，分数过线、带关键词的记下来（见过的只更新数字）。
 * 读不到不抛错，记在来源上；只有「表还没建」这种要用户动手的原样抛。
 */
export async function runCheck(db: Db, watch: Watch, deps: IntelDeps = defaultDeps): Promise<CheckResult> {
  const now = deps.now();
  let listing: Listing;
  try {
    listing =
      watch.kind === "subreddit"
        ? await deps.listSubreddit(watch.query, new Date(now.getTime() - REDDIT_WINDOW_DAYS * DAY))
        : await deps.searchHn(watch.query, watch.minScore, new Date(now.getTime() - HN_WINDOW_DAYS * DAY));
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await updateWatch(db, watch.userId, watch.id, { lastCheckedAt: now.toISOString(), lastError: error });
    return { found: 0, fresh: 0, notes: [], error };
  }
  const keywords = watch.kind === "subreddit" ? parseKeywords(watch.keywords) : [];
  const keep = listing.candidates.filter((c) => (c.score ?? -1) >= watch.minScore && matchesKeywords(c, keywords));
  const fresh = await recordCandidates(db, watch.userId, watch.id, keep);
  await pruneSignals(db, watch.userId, new Date(now.getTime() - SIGNAL_KEEP_DAYS * DAY));
  await updateWatch(db, watch.userId, watch.id, { lastCheckedAt: now.toISOString(), lastError: null, lastNotes: listing.notes });
  return { found: keep.length, fresh, notes: listing.notes, error: null };
}

const NOT_FOUND = "这个来源不在了";

export async function listMyWatches(session: Session): Promise<Watch[]> {
  return listWatches(session.db, session.user.id);
}

const cleanScore = (raw: unknown, fallback: number): number => {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(MIN_SCORE_MAX, Math.max(0, Math.round(n))) : fallback;
};
const cleanKeywords = (raw: unknown) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, KEYWORDS_MAX) : "");

export type WatchInput = { kind?: unknown; query?: unknown; minScore?: unknown; keywords?: unknown };

/** 加一个来源，加完马上去看一次（要等几秒到十几秒）。 */
export async function addWatch(session: Session, input: WatchInput, deps: IntelDeps = defaultDeps): Promise<{ watch: Watch; check: CheckResult }> {
  const { user, db } = session;
  const kind = WATCH_KINDS.find((k) => k === input.kind);
  if (!kind) throw new VaultError("选一种来源：Reddit 的版块，或者 Hacker News 的关键词");
  const raw = typeof input.query === "string" ? input.query.trim() : "";
  let query: string;
  if (kind === "subreddit") {
    const name = parseSubreddit(raw);
    if (!name) throw new VaultError("没认出版块名：写成 LocalLLaMA 或 r/LocalLLaMA（只有字母、数字和下划线）");
    query = name;
  } else {
    query = raw.replace(/\s+/g, " ");
    if (!query) throw new VaultError("写一个或几个关键词，比如 MCP（几个词 = 都要有；加引号 = 这几个词要连着出现）");
    if (query.length > HN_QUERY_MAX) throw new VaultError(`关键词太长，最多 ${HN_QUERY_MAX} 个字符`);
  }
  if ((await listWatches(db, user.id)).length >= WATCH_MAX) throw new VaultError(`最多盯 ${WATCH_MAX} 个来源：先删掉不看的`);
  const watch = await createWatch(db, user.id, { kind, query, keywords: kind === "subreddit" ? cleanKeywords(input.keywords) : "", minScore: cleanScore(input.minScore, DEFAULT_MIN_SCORE[kind]) });
  if (!watch) throw new VaultError(`已经在盯 ${watchLabel({ kind, query })} 了`, 409);
  return { watch, check: await runCheck(db, watch, deps) };
}

/** 改一个来源：开 / 关、分数线、关键词。 */
export async function editWatch(session: Session, id: string, edit: { enabled?: unknown; minScore?: unknown; keywords?: unknown }): Promise<void> {
  const patch = {
    ...(typeof edit.enabled === "boolean" ? { enabled: edit.enabled } : {}),
    ...(edit.minScore !== undefined ? { minScore: cleanScore(edit.minScore, 0) } : {}),
    ...(edit.keywords !== undefined ? { keywords: cleanKeywords(edit.keywords) } : {}),
  };
  const ok = isUuid(id) && (await updateWatch(session.db, session.user.id, id, patch));
  if (!ok) throw new VaultError(NOT_FOUND, 404);
}

export async function removeWatch(session: Session, id: string): Promise<void> {
  if (!isUuid(id)) throw new VaultError(NOT_FOUND, 404);
  await deleteWatch(session.db, session.user.id, id);
}

/** 现在去看一个来源。 */
export async function checkWatch(session: Session, id: string, deps: IntelDeps = defaultDeps): Promise<CheckResult> {
  const watch = isUuid(id) ? await getWatch(session.db, session.user.id, id) : null;
  if (!watch) throw new VaultError(NOT_FOUND, 404);
  return runCheck(session.db, watch, deps);
}

/** 现在把开着的来源都看一遍（一个一个来：存档嫌快会拒绝）。 */
export async function checkAllWatches(session: Session, deps: IntelDeps = defaultDeps): Promise<{ checked: number; fresh: number; failed: number }> {
  const watches = (await listWatches(session.db, session.user.id)).filter((w) => w.enabled);
  let fresh = 0;
  let failed = 0;
  for (const watch of watches) {
    const r = await runCheck(session.db, watch, deps);
    fresh += r.fresh;
    if (r.error) failed++;
  }
  return { checked: watches.length, fresh, failed };
}

export type SignalPage = { signals: Signal[]; counts: Record<SignalStatus, number> };

export async function listMySignals(session: Session, rawStatus?: unknown): Promise<SignalPage> {
  const status = SIGNAL_STATUSES.find((s) => s === rawStatus) ?? "new";
  const [signals, counts] = await Promise.all([listSignals(session.db, session.user.id, { status, limit: SIGNAL_LIST }), countSignals(session.db, session.user.id)]);
  return { signals, counts };
}

const SIGNAL_GONE = "这一条不在了";

/** 不要这一条 / 把忽略掉的放回「新的」。存进收藏库的不走这里（要去掉，去收藏库里删那条内容）。 */
export async function markSignal(session: Session, id: string, rawStatus: unknown): Promise<void> {
  const status = rawStatus === "dismissed" ? "dismissed" : rawStatus === "new" ? "new" : null;
  if (!status) throw new VaultError("只能标成「不要」或者放回「新的」");
  const signal = isUuid(id) ? await getSignal(session.db, session.user.id, id) : null;
  if (!signal) throw new VaultError(SIGNAL_GONE, 404);
  if (signal.status === "saved") throw new VaultError("这一条已经存进收藏库了：不想要的话去收藏库里删掉那条内容");
  await setSignalStatus(session.db, session.user.id, id, status);
}

/** 把一条存进收藏库：和自己贴链接一样（读取、理解照常做、照常计费）。已经存过同一个链接的回到那条。 */
export async function saveSignal(session: Session, id: string, save: typeof saveInput = saveInput): Promise<{ itemId: string; existing: boolean }> {
  const signal = isUuid(id) ? await getSignal(session.db, session.user.id, id) : null;
  if (!signal) throw new VaultError(SIGNAL_GONE, 404);
  if (signal.status === "saved" && signal.itemId) return { itemId: signal.itemId, existing: true };
  const saved = await save(session, signal.url);
  await setSignalStatus(session.db, session.user.id, id, "saved", saved.id);
  return { itemId: saved.id, existing: saved.existing };
}

/** 后台多久把每个来源看一次（分钟）。`VAULT_INTEL_EVERY_MIN` 可以改，最少 15；0 = 不自动看，只在页面上手动点。 */
export function intelEveryMinutes(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.VAULT_INTEL_EVERY_MIN?.trim();
  if (!raw) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(15, Math.round(n));
}

/** 一轮最多看这么多个来源（一个来源几秒到十几秒；剩下的下一轮接着看） */
export const DUE_BATCH = 10;

/**
 * 后台定时调：把所有人开着的、到时间的来源看一遍（最久没看的先看）。用 service role：
 * 「找出到时间的来源」这一下是跨用户查的（这是唯一一处），之后每个来源的读写都带着它自己的 user_id。
 */
export async function checkDueWatches(opts: { db?: Db; deps?: IntelDeps; everyMinutes?: number } = {}): Promise<{ checked: number; fresh: number; failed: number }> {
  const every = opts.everyMinutes ?? intelEveryMinutes();
  if (every <= 0) return { checked: 0, fresh: 0, failed: 0 };
  const deps = opts.deps ?? defaultDeps;
  const db = opts.db ?? getServiceClient();
  const due = await listDueWatches(db, new Date(deps.now().getTime() - every * 60_000), DUE_BATCH);
  let fresh = 0;
  let failed = 0;
  for (const watch of due) {
    try {
      const r = await runCheck(db, watch, deps);
      fresh += r.fresh;
      if (r.error) failed++;
    } catch (e) {
      // 数据库那头出错（不是来源读不到）：记一笔，接着看下一个
      failed++;
      console.error(`情报：${watchLabel(watch)} 没看成: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: due.length, fresh, failed };
}
