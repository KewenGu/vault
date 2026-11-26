import "server-only";
import { recordCall } from "@/lib/usage/meter";
import { accountLabel, accountLabelInText, type AccountInfo, type ListedPost } from "./account";
import { PROFILE_ACTORS } from "./account-apify";
import { fetchXProfile, fetchXTimelinePage, pickOwnPosts } from "./account-x";
import { abortActorRun, apifyToken, getActorRun, readDatasetItems, runPending, startActorRun } from "./apify";
import type { AccountRef } from "./link";
import { SourceFetchError } from "./types";

/**
 * 列一个账号的作品（存一个博主的全部作品的第一步）。各平台怎么列、花不花钱：
 *
 * | 平台 | 怎么列 | 花费 |
 * |---|---|---|
 * | X | FxTwitter 的时间线接口，一页约 20 条往回翻（account-x.ts） | 免费 |
 * | TikTok | Apify actor（account-apify.ts） | 约 $0.002 / 条 |
 * | 抖音 | Apify actor（account-apify.ts） | 约 $0.005 / 条 |
 * | 小红书 | Apify actor（account-apify.ts） | 约 $0.005 / 条 |
 * | Instagram | Apify actor（account-apify.ts） | 约 $0.003 / 条 |
 * | YouTube | Apify actor（account-apify.ts）：视频和 Shorts 各列 N 条 | 约 $0.004 / 条，最多 2N 条 |
 * | B 站 | Apify actor（account-apify.ts）：投稿的视频 | 约 $0.003 / 条 |
 *
 * 列一次要翻很多页 / 等 actor 跑完，放在一次调用里会很久，所以拆成一步一步：每调一次 listAccountStep 往前走一步，
 * 返回这一步拿到的作品、接下来的状态（原样传给下一次）、下一次之前要等几秒。后台任务（workflows/collect-creator.ts）
 * 在两步之间 sleep，每一步的结果都落了库，服务中途重启从断的那一步接着来。
 *
 * 账号不存在 / 私密 / 没配令牌抛 SourceFetchError（message 给用户看）；别的错原样抛。
 */

export type ListState =
  | { via: "x"; cursor: string | null; pages: number; got: number; reposts: number; threadReplies: number; replies: number; oldest: string | null }
  | { via: "apify"; runId: string; datasetId: string; polls: number };

export type ListStep = {
  done: boolean;
  /** 传给下一次调用；done 时是 null */
  state: ListState | null;
  /** 下一次调用之前等几秒 */
  waitS: number;
  /** 账号信息（拿到的那一步才有） */
  info: AccountInfo | null;
  /** 这一步列出来的作品 */
  posts: ListedPost[];
  /** 没列到的、没要的：记下来给用户看（done 时才有） */
  notes: string[];
};

/** X 最多翻这么多页（一页约 20 条，其中他自己发的常常只有一半） */
const X_MAX_PAGES = 150;
/** actor 最多等这么多次（每次隔 10 秒）：15 分钟 */
const APIFY_MAX_POLLS = 90;
const APIFY_TIMEOUT_S = 900;

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

async function listX(ref: AccountRef, want: number, state: Extract<ListState, { via: "x" }> | null): Promise<ListStep> {
  let info: AccountInfo | null = null;
  let s = state;
  if (!s) {
    info = await fetchXProfile(ref.externalId);
    s = { via: "x", cursor: null, pages: 0, got: 0, reposts: 0, threadReplies: 0, replies: 0, oldest: null };
  }
  const summary = (st: NonNullable<typeof s>): string[] => {
    const notes: string[] = [];
    if (st.reposts > 0) notes.push(`他转发别人的 ${st.reposts} 条没存（只存他自己发的）`);
    if (st.threadReplies > 0) notes.push(`他接在自己帖子后面发的 ${st.threadReplies} 条不单独存：读那一串的第一条时一起读进来`);
    if (st.replies > 0) notes.push(`他回别人的 ${st.replies} 条回复没存`);
    return notes;
  };
  let page;
  try {
    page = await fetchXTimelinePage(ref.externalId, s.cursor);
  } catch (e) {
    // 已经列出来一些了：到这里为止，说清楚；一条都没列到才算失败
    if (s.got === 0) throw e;
    return { done: true, state: null, waitS: 0, info, posts: [], notes: [`列到第 ${s.got} 条（${day(s.oldest)}）之后读不动了，更早的没列出来：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`, ...summary(s)] };
  }
  const own = pickOwnPosts(page.entries, ref.externalId);
  const posts = own.posts.slice(0, Math.max(0, want - s.got));
  const next = {
    ...s,
    cursor: page.cursor,
    pages: s.pages + 1,
    got: s.got + posts.length,
    reposts: s.reposts + own.reposts,
    threadReplies: s.threadReplies + own.threadReplies,
    replies: s.replies + own.replies,
    oldest: posts.at(-1)?.publishedAt ?? s.oldest,
  };
  if (next.got >= want) return { done: true, state: null, waitS: 0, info, posts, notes: summary(next) };
  if (!page.cursor || page.entries.length === 0) {
    const notes = next.got === 0 ? ["时间线上没有他自己发的帖子"] : [`时间线到 ${day(next.oldest)} 就没有了，一共列出 ${next.got} 条：可能他就发过这么多，也可能是这个接口只给到这里`];
    return { done: true, state: null, waitS: 0, info, posts, notes: [...notes, ...summary(next)] };
  }
  if (next.pages >= X_MAX_PAGES) return { done: true, state: null, waitS: 0, info, posts, notes: [`翻了 ${X_MAX_PAGES} 页，列出 ${next.got} 条（到 ${day(next.oldest)}），更早的没再翻`, ...summary(next)] };
  return { done: false, state: next, waitS: 0, info, posts, notes: [] };
}

async function listViaApify(ref: AccountRef & { platform: keyof typeof PROFILE_ACTORS }, want: number, state: Extract<ListState, { via: "apify" }> | null): Promise<ListStep> {
  const spec = PROFILE_ACTORS[ref.platform];
  // 英文的平台名和前后的中文之间留空格
  const name = accountLabel(ref.platform);
  const label = accountLabelInText(ref.platform);
  const token = apifyToken(`列${label}账号的作品`.trim());
  // actor 最多会给多少条（YouTube 的视频和 Shorts 各要 want 条）
  const rows = want * (spec.rowsPerPost ?? 1);
  if (!state) {
    const run = await startActorRun(token, spec.actor(), spec.input(ref, want), { timeoutS: APIFY_TIMEOUT_S, maxChargeUsd: rows * spec.perItemUsd * 1.5 + 0.1 });
    return { done: false, state: { via: "apify", runId: run.id, datasetId: run.datasetId, polls: 0 }, waitS: 8, info: null, posts: [], notes: [] };
  }
  const run = await getActorRun(token, state.runId);
  const notes: string[] = [];
  if (runPending(run)) {
    if (state.polls < APIFY_MAX_POLLS) return { done: false, state: { ...state, polls: state.polls + 1 }, waitS: 10, info: null, posts: [], notes: [] };
    // 等太久：让它停下，已经列出来的照样用
    await abortActorRun(token, state.runId);
    notes.push(`列作品等了 ${Math.round((APIFY_MAX_POLLS * 10) / 60)} 分钟还没跑完，停下了：只拿到它已经列出来的`);
  } else if (run.status !== "SUCCEEDED") notes.push(`列作品的那次运行没跑完（${run.status}${run.statusMessage ? `：${run.statusMessage.slice(0, 100)}` : ""}）：只拿到它已经列出来的`);
  // 多取一点：置顶的会重复出现，账号信息也可能单独占一条
  const items = await readDatasetItems(token, state.datasetId, rows + 50);
  // 跑了就计费，按数据集里的条数
  recordCall(spec.countKey, items.length);
  const { info, posts: all, notes: skipped = [] } = spec.read(items, ref);
  if (all.length === 0) {
    if (notes.length > 0) throw new Error(notes[0].replace("：只拿到它已经列出来的", `，一条都没列出来${spec.failHint && items.length === 0 ? `。${spec.failHint}` : ""}`));
    if (!info) throw new SourceFetchError(`没读到这个${label}账号：可能不存在、设成了私密，或者链接不对。在${label}里打开他的主页，点「分享 → 复制链接」再贴一次`);
    return { done: true, state: null, waitS: 0, info, posts: [], notes: ["这个账号没有公开的作品", ...skipped] };
  }
  notes.push(...skipped);
  // 从新到旧（置顶的回到它本来的位置）；没有时间的排最后
  const posts = [...all].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, want);
  if (info?.postCount && posts.length < want && posts.length < info.postCount) {
    notes.push(`${name} 说这个账号一共 ${info.postCount} 个作品，这次只列出 ${posts.length} 个：剩下的可能是私密的、被平台藏起来的，或者 actor 没翻到`.replace(/^(抖音|小红书|B 站) /, "$1"));
  }
  return { done: true, state: null, waitS: 0, info, posts, notes };
}

/** 往前列一步。want：最多要多少条（从最新的往回数）。 */
export function listAccountStep(ref: AccountRef, want: number, state: ListState | null): Promise<ListStep> {
  if (ref.platform === "x") return listX(ref, want, state?.via === "x" ? state : null);
  return listViaApify({ ...ref, platform: ref.platform }, want, state?.via === "apify" ? state : null);
}
