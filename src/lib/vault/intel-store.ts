import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, IntelSignalRecord, IntelWatchRecord, Json } from "@/lib/db/types";
import { INTEL_SOURCES, type Candidate, type IntelSource } from "@/lib/intel/candidate";
import { VaultError } from "./errors";

/**
 * 情报的两张表（intel_watches 盯着的来源、intel_signals 发现的内容）的读写。
 * 每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），后台定时去看用 service role 时只靠它。
 */

type Db = SupabaseClient<Database>;

export const WATCH_KINDS = ["subreddit", "hn"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const SIGNAL_STATUSES = ["new", "saved", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export type Watch = {
  id: string;
  userId: string;
  kind: WatchKind;
  /** 版块名（不带 r/）或 HN 的关键词 */
  query: string;
  /** 版块里再按词筛（空 = 全要） */
  keywords: string;
  minScore: number;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** 上次没看到的 */
  lastNotes: string[];
  createdAt: string;
};

export type Signal = {
  id: string;
  watchId: string;
  source: IntelSource;
  externalId: string;
  url: string;
  discussionUrl: string | null;
  title: string;
  excerpt: string;
  author: string | null;
  channel: string;
  score: number | null;
  comments: number | null;
  publishedAt: string | null;
  status: SignalStatus;
  itemId: string | null;
  foundAt: string;
};

/** 表还不存在（应用更新了、迁移还没推到 Supabase）时说清楚要做什么。 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError("数据库里还没有情报用的那两张表：把迁移 supabase/migrations/20261124000001_intel.sql 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）", 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const WATCH_COLUMNS = "id,user_id,kind,query,keywords,min_score,enabled,last_checked_at,last_error,last_notes,created_at" as const;
const SIGNAL_COLUMNS = "id,watch_id,source,external_id,url,discussion_url,title,excerpt,author,channel,score,comments,published_at,status,item_id,found_at" as const;

export function toWatch(row: Pick<IntelWatchRecord, "id" | "user_id" | "kind" | "query" | "keywords" | "min_score" | "enabled" | "last_checked_at" | "last_error" | "last_notes" | "created_at">): Watch {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind === "hn" ? "hn" : "subreddit",
    query: row.query,
    keywords: row.keywords,
    minScore: row.min_score,
    enabled: row.enabled,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    lastNotes: Array.isArray(row.last_notes) ? row.last_notes.filter((n): n is string => typeof n === "string") : [],
    createdAt: row.created_at,
  };
}

export function toSignal(row: Pick<IntelSignalRecord, "id" | "watch_id" | "source" | "external_id" | "url" | "discussion_url" | "title" | "excerpt" | "author" | "channel" | "score" | "comments" | "published_at" | "status" | "item_id" | "found_at">): Signal {
  return {
    id: row.id,
    watchId: row.watch_id,
    source: INTEL_SOURCES.find((s) => s === row.source) ?? "reddit",
    externalId: row.external_id,
    url: row.url,
    discussionUrl: row.discussion_url,
    title: row.title,
    excerpt: row.excerpt,
    author: row.author,
    channel: row.channel ?? "",
    score: row.score,
    comments: row.comments,
    publishedAt: row.published_at,
    status: SIGNAL_STATUSES.find((s) => s === row.status) ?? "new",
    itemId: row.item_id,
    foundAt: row.found_at,
  };
}

/** 这个人盯着的来源，先加的在前。 */
export async function listWatches(db: Db, userId: string): Promise<Watch[]> {
  const { data, error } = await db.from("intel_watches").select(WATCH_COLUMNS).eq("user_id", userId).order("created_at", { ascending: true }).limit(200);
  if (error) fail("读取盯着的来源失败", error);
  return (data ?? []).map(toWatch);
}

export async function getWatch(db: Db, userId: string, id: string): Promise<Watch | null> {
  const { data, error } = await db.from("intel_watches").select(WATCH_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取盯着的来源失败", error);
  return data ? toWatch(data) : null;
}

/** 加一个来源。同一个来源已经有了（不分大小写）返回 null。 */
export async function createWatch(db: Db, userId: string, input: { kind: WatchKind; query: string; keywords: string; minScore: number }): Promise<Watch | null> {
  const { data, error } = await db
    .from("intel_watches")
    .insert({ user_id: userId, kind: input.kind, query: input.query, keywords: input.keywords, min_score: input.minScore, enabled: true })
    .select(WATCH_COLUMNS)
    .single();
  if (error?.code === "23505") return null;
  if (error) fail("添加来源失败", error);
  return toWatch(data);
}

export type WatchPatch = Partial<{ keywords: string; minScore: number; enabled: boolean; lastCheckedAt: string; lastError: string | null; lastNotes: string[] }>;

/** 改一个来源（只改给了的列）。不在了（或不是这个人的）返回 false。 */
export async function updateWatch(db: Db, userId: string, id: string, patch: WatchPatch): Promise<boolean> {
  const row = {
    ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
    ...(patch.minScore !== undefined ? { min_score: patch.minScore } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.lastCheckedAt !== undefined ? { last_checked_at: patch.lastCheckedAt } : {}),
    ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
    ...(patch.lastNotes !== undefined ? { last_notes: patch.lastNotes as Json } : {}),
  };
  if (Object.keys(row).length === 0) return true;
  const { data, error } = await db.from("intel_watches").update(row).eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("保存来源失败", error);
  return (data ?? []).length > 0;
}

/** 删一个来源；它发现的内容跟着删（外键）。 */
export async function deleteWatch(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("intel_watches").delete().eq("id", id).eq("user_id", userId);
  if (error) fail("删除来源失败", error);
}

/**
 * 把一次看到的候选记下来：没见过的新加一行（状态是「新的」），见过的只更新标题、开头和数字——状态、是哪个来源先发现的不动
 * （忽略过的不会因为分数涨了又冒出来）。返回这次新加了几条。
 */
export async function recordCandidates(db: Db, userId: string, watchId: string, candidates: Candidate[]): Promise<number> {
  if (candidates.length === 0) return 0;
  let fresh = 0;
  for (const source of INTEL_SOURCES) {
    const batch = candidates.filter((c) => c.source === source);
    if (batch.length === 0) continue;
    const { data: known, error: readError } = await db
      .from("intel_signals")
      .select("external_id")
      .eq("user_id", userId)
      .eq("source", source)
      .in("external_id", batch.map((c) => c.externalId));
    if (readError) fail("读取发现的内容失败", readError);
    const have = new Set((known ?? []).map((r) => r.external_id));
    const added = batch.filter((c) => !have.has(c.externalId));
    if (added.length > 0) {
      const { error } = await db.from("intel_signals").upsert(
        added.map((c) => ({ user_id: userId, watch_id: watchId, source, external_id: c.externalId, status: "new", ...columns(c) })),
        { onConflict: "user_id,source,external_id", ignoreDuplicates: true }
      );
      if (error) fail("保存发现的内容失败", error);
      fresh += added.length;
    }
    for (const c of batch.filter((x) => have.has(x.externalId))) {
      const { error } = await db.from("intel_signals").update(columns(c)).eq("user_id", userId).eq("source", source).eq("external_id", c.externalId);
      if (error) fail("更新发现的内容失败", error);
    }
  }
  return fresh;
}

const columns = (c: Candidate) => ({
  url: c.url,
  discussion_url: c.discussionUrl,
  title: c.title,
  excerpt: c.excerpt,
  author: c.author,
  channel: c.channel,
  score: c.score,
  comments: c.comments,
  published_at: c.publishedAt,
});

/** 发现的内容，按发布时间新的在前。 */
export async function listSignals(db: Db, userId: string, opts: { status: SignalStatus; limit: number }): Promise<Signal[]> {
  const { data, error } = await db
    .from("intel_signals")
    .select(SIGNAL_COLUMNS)
    .eq("user_id", userId)
    .eq("status", opts.status)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(opts.limit);
  if (error) fail("读取发现的内容失败", error);
  return (data ?? []).map(toSignal);
}

/** 每种状态各有多少条。 */
export async function countSignals(db: Db, userId: string): Promise<Record<SignalStatus, number>> {
  const counts = { new: 0, saved: 0, dismissed: 0 };
  for (const status of SIGNAL_STATUSES) {
    const { count, error } = await db.from("intel_signals").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", status);
    if (error) fail("读取发现的内容失败", error);
    counts[status] = count ?? 0;
  }
  return counts;
}

export async function getSignal(db: Db, userId: string, id: string): Promise<Signal | null> {
  const { data, error } = await db.from("intel_signals").select(SIGNAL_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取发现的内容失败", error);
  return data ? toSignal(data) : null;
}

/** 改一条的状态（存进去了的带上那条内容的 id）。不在了返回 false。 */
export async function setSignalStatus(db: Db, userId: string, id: string, status: SignalStatus, itemId?: string | null): Promise<boolean> {
  const { data, error } = await db
    .from("intel_signals")
    .update({ status, ...(itemId !== undefined ? { item_id: itemId } : {}) })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");
  if (error) fail("保存失败", error);
  return (data ?? []).length > 0;
}

/** 清掉没存、又放了很久的（新的没人看、忽略掉的）：发现时间早于 before 的。存进收藏库的留着。 */
export async function pruneSignals(db: Db, userId: string, before: Date): Promise<void> {
  const { error } = await db.from("intel_signals").delete().eq("user_id", userId).in("status", ["new", "dismissed"]).lt("found_at", before.toISOString());
  if (error) fail("清理旧的发现失败", error);
}

/** 后台定时去看用：所有人开着的来源里，上次去看早于 before（或者还没看过）的，最久没看的在前。只用 service role 调。 */
export async function listDueWatches(db: Db, before: Date, limit: number): Promise<Watch[]> {
  const { data, error } = await db
    .from("intel_watches")
    .select(WATCH_COLUMNS)
    .eq("enabled", true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${before.toISOString()}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) fail("读取该去看的来源失败", error);
  return (data ?? []).map(toWatch);
}
