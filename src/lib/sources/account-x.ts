import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import { listedTitle, type AccountInfo, type ListedPost } from "./account";
import { SourceFetchError } from "./types";

/**
 * 列一个 X 账号发过的帖子，不用登录、不花钱：FxTwitter 的公开接口（和读一条帖子是同一个服务，见 x.ts）。
 *
 * - 账号信息：`api.fxtwitter.com/2/profile/<用户名>`。
 * - 时间线：`api.fxtwitter.com/2/profile/<用户名>/statuses`，一页约 20 条，按时间从新到旧，`cursor.bottom` 翻下一页。
 *   里面有他自己发的、他转发别人的（`reposted_by`）、他接在自己帖子后面的（`replying_to` 是他自己，一串帖子的后几条）。
 *   回别人的回复不在里面。
 * - 一串帖子：`api.fxtwitter.com/2/thread/<第一条的 id>`，给出作者接着发的每一条。
 *
 * 2026-11-26 在云端容器里实测：一个账号连续翻 12 页（233 条）翻得动。profile 和时间线这两个接口不太稳，对真实存在的账号
 * 有时也回 404（profile 回「User not found」，12 次里 2 次；时间线回一个空数组，有个账号 7 次里 5 次这样），隔一两秒再要就好了。
 * 所以两个都多试几次：profile 连着 5 次都说没有才当账号不存在，时间线每一页最多试 6 次。读单条帖子（/i/status）和一串帖子
 * （/2/thread）的接口那天各试了二十几次、十次，都没出过这种情况。往回最多能翻多远没测到头。
 *
 * 存的时候只要他自己发的：转发别人的不存；一串帖子只存第一条，后面几条在读这一条时并进来（x.ts 的 readXThread）。
 */

const UA = "Mozilla/5.0 (compatible; SM-Intelligence/1.0)";
const SERVICE = "FxTwitter(api.fxtwitter.com)";
const API = "https://api.fxtwitter.com/2";
const PAGE_TRIES = 6;
const PROFILE_TRIES = 5;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<{ code: number; json: Obj }> {
  const res = await labeledFetch(SERVICE, url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const json = obj(await res.json().catch(() => null));
  return { code: typeof json.code === "number" ? json.code : res.status, json };
}

/**
 * 账号信息。账号不存在 / 设成了私密抛 SourceFetchError；别的错原样抛（可以重试）。
 * 这个接口对真实存在的账号也偶尔回「User not found」（见顶注），所以回 404 时多问几次，每次都这么说才当真。
 */
export async function fetchXProfile(handle: string, pause: (ms: number) => Promise<unknown> = sleep): Promise<AccountInfo> {
  let code = 0;
  let user: Obj = {};
  for (let attempt = 1; attempt <= PROFILE_TRIES; attempt++) {
    const got = await getJson(`${API}/profile/${encodeURIComponent(handle)}`);
    code = got.code;
    user = obj(got.json.user);
    if (code !== 404) break;
    if (attempt < PROFILE_TRIES) await pause(1000 * attempt);
  }
  if (code === 404) throw new SourceFetchError(`没找到 @${handle} 这个 X 账号（问了 ${PROFILE_TRIES} 次都说没有）：可能改了名、被封了，或者链接不对`);
  if (code !== 200 || !str(user.screen_name)) throw new Error(`FxTwitter ${code}：账号信息读不到，过一会儿再试`);
  if (user.protected === true) throw new SourceFetchError(`@${str(user.screen_name)} 是私密账号，帖子读不了`);
  const count = typeof user.statuses === "number" && user.statuses >= 0 ? user.statuses : null;
  return { name: str(user.name) || str(user.screen_name), handle: `@${str(user.screen_name)}`, bio: str(user.description).trim(), postCount: count };
}

/** 时间线上的一条。 */
export type XTimelineEntry = {
  id: string;
  /** 这条帖子是谁发的（小写用户名）；转发别人的时候是原作者 */
  author: string;
  /** 是博主转发的别人的帖子 */
  repost: boolean;
  /** 这是一条回复时，回的是谁（小写用户名） */
  replyTo: string | null;
  text: string;
  publishedAt: string | null;
  kind: ListedPost["kind"];
};

/** 时间线接口返回的一页 → 一条条帖子 + 翻下一页用的游标（纯函数）。 */
export function readXTimeline(json: unknown): { entries: XTimelineEntry[]; cursor: string | null } {
  const entries: XTimelineEntry[] = [];
  for (const raw of arr(obj(json).results)) {
    const t = obj(raw);
    const id = str(t.id);
    if (!/^\d{5,25}$/.test(id)) continue;
    const media = obj(t.media);
    const ts = typeof t.created_timestamp === "number" && t.created_timestamp > 0 ? t.created_timestamp : null;
    entries.push({
      id,
      author: str(obj(t.author).screen_name).toLowerCase(),
      repost: !!t.reposted_by,
      replyTo: str(obj(t.replying_to).screen_name).toLowerCase() || (typeof t.replying_to === "string" ? t.replying_to.toLowerCase() : "") || null,
      text: str(t.text),
      publishedAt: ts ? new Date(ts * 1000).toISOString() : null,
      kind: arr(media.videos).length > 0 ? "video" : arr(media.photos).length > 0 ? "image" : "text",
    });
  }
  return { entries, cursor: str(obj(obj(json).cursor).bottom) || null };
}

/** 一页里他自己发的那些 + 没要的各有几条（纯函数）。handle 是小写的用户名。 */
export function pickOwnPosts(entries: XTimelineEntry[], handle: string): { posts: ListedPost[]; reposts: number; threadReplies: number; replies: number } {
  const posts: ListedPost[] = [];
  let reposts = 0;
  let threadReplies = 0;
  let replies = 0;
  for (const e of entries) {
    if (e.repost || e.author !== handle) reposts++;
    else if (e.replyTo === handle) threadReplies++;
    else if (e.replyTo) replies++;
    else posts.push({ externalId: e.id, url: `https://x.com/${handle}/status/${e.id}`, kind: e.kind, title: listedTitle(e.text), publishedAt: e.publishedAt, pinned: false });
  }
  return { posts, reposts, threadReplies, replies };
}

/**
 * 时间线的一页。接口偶发回 404 + 空数组（见顶注）：隔一会儿再要，最多 6 次；一直不行抛普通错误（调用方记成「列到这里读不动了」）。
 * 调用前要先用 fetchXProfile 确认过账号在。
 */
export async function fetchXTimelinePage(handle: string, cursor: string | null, pause: (ms: number) => Promise<unknown> = sleep): Promise<{ entries: XTimelineEntry[]; cursor: string | null }> {
  const url = `${API}/profile/${encodeURIComponent(handle)}/statuses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
  let last = "";
  for (let attempt = 1; attempt <= PAGE_TRIES; attempt++) {
    try {
      const { code, json } = await getJson(url);
      if (code === 200) return readXTimeline(json);
      last = `接口回了 ${code}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < PAGE_TRIES) await pause(1500 * attempt);
  }
  throw new Error(`X 的时间线读不动（试了 ${PAGE_TRIES} 次，${last.slice(0, 100)}）`);
}

/** 一串帖子里作者接着发的那几条的 id（不含第一条，按顺序）。不是一串、或者读不到，返回空数组。 */
export function readXThreadIds(json: unknown, rootId: string): string[] {
  const root = obj(obj(json).status);
  const author = str(obj(root.author).screen_name).toLowerCase() || str(obj(obj(json).author).screen_name).toLowerCase();
  const ids: string[] = [];
  for (const raw of arr(obj(json).thread)) {
    const t = obj(raw);
    const id = str(t.id);
    if (!/^\d{5,25}$/.test(id) || id === rootId || ids.includes(id)) continue;
    if (author && str(obj(t.author).screen_name).toLowerCase() !== author) continue;
    ids.push(id);
  }
  return ids;
}

/** 读一串帖子后面几条的 id。读不到不算失败（只当它不是一串），但要让调用方知道没读成：返回 null。 */
export async function fetchXThreadIds(rootId: string): Promise<string[] | null> {
  try {
    const { code, json } = await getJson(`${API}/thread/${rootId}`);
    return code === 200 ? readXThreadIds(json, rootId) : null;
  } catch (e) {
    console.error(`读 X 的一串帖子失败 id=${rootId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
