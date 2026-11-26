import { httpError } from "@/lib/error-text";
import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import type { Followed, Mention } from "./follow";
import { DESKTOP_UA, type LinkRef } from "./link";
import { SourceFetchError, emptyStats, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条 Reddit 帖子：走第三方存档 Arctic Shift（arctic-shift.photon-reddit.com，免费、不要密钥）。
 *
 * 为什么不直接读：Reddit 对没登录的服务器一律不给（2026-11-22 在云端容器里实测：帖子页给的是 JS 验证页，
 * `.json` 和 shreddit 的片段接口 403，Jina Reader 也只拿到「You've been blocked by network security」）。
 * 存档这条路是从 last30days-skill（MIT）的 `reddit_arctic.py` 学来的，同一台机器上读得到帖子和评论树。
 *
 * - 帖子：`/api/posts/ids?ids=<id>`，返回的是 Reddit 接口原样的帖子对象（不认识的 id 直接不在结果里）。
 * - 评论：`/api/comments/tree?link_id=t3_<id>&limit=<行数>`，一棵树（`replies.data.children` 往下套），`limit` 数的是评论的行数。
 * - 图片（i.redd.it / preview.redd.it）和视频（v.redd.it）的地址机房 IP 也下得动。视频的画面和声音是分开的两个文件：
 *   帖子里只给画面的地址，声音的要去 `DASHPlaylist.mpd` 里找，下载之后合成一个（见 workflows/process-item.ts）。
 *
 * 存档是快照：点赞数、评论数是它收录那一刻的（一般会在几小时到几天后回头再记一次），刚发的帖子可能还没收录，
 * 请求太快会回 422「slow down」。这些都记进 notes。
 *
 * 拿得到：标题、正文、作者、版块、发布时间、点赞数（score）、评论数、赞数最高的评论、图片（单图、图集、正文里插的图）、
 * 视频、帖子指向的链接（交给 follow.ts 跟着读）、转帖的原帖内容。
 * 拿不到：浏览量、转发数、投票的选项和票数；评论只留赞数最高的几条。
 */

const ARCHIVE = "https://arctic-shift.photon-reddit.com/api";
const SERVICE = "Reddit 存档(arctic-shift.photon-reddit.com)";
/** 评论树最多读这么多行（一条评论一行）。last30days 那边实测：628 条回复的帖子，读 500 行留下的高赞评论和全读一样 */
export const COMMENT_ROWS = 500;
/** 留赞数最高的这么多条评论 */
export const TOP_COMMENTS = 12;
/** 一条评论最多留这么多字（提示词里还会再截） */
const COMMENT_MAX = 1500;

type RdVideo = { fallback_url?: string; width?: number; height?: number; duration?: number; is_gif?: boolean };
type RdPreview = { images?: { source?: { url?: string; width?: number; height?: number } }[] };
type RdMeta = { status?: string; e?: string; s?: { u?: string; gif?: string; x?: number; y?: number }; p?: { u?: string; x?: number; y?: number }[] };
type RdContent = {
  selftext?: string;
  url?: string;
  is_self?: boolean;
  is_video?: boolean;
  is_gallery?: boolean;
  post_hint?: string;
  media?: { reddit_video?: RdVideo } | null;
  secure_media?: { reddit_video?: RdVideo } | null;
  preview?: RdPreview | null;
  gallery_data?: { items?: { media_id?: string; caption?: string }[] } | null;
  media_metadata?: Record<string, RdMeta> | null;
  poll_data?: unknown;
  subreddit?: string;
  author?: string;
};
type RdPost = RdContent & {
  id?: string;
  title?: string;
  author_fullname?: string;
  created_utc?: number;
  retrieved_on?: number;
  /** 存档自己记的：第二次收录的时间；标题被换成「[ Removed by moderator ]」之前的原标题 */
  _meta?: { retrieved_2nd_on?: number; edited_title?: string };
  score?: number;
  num_comments?: number;
  permalink?: string;
  link_flair_text?: string | null;
  over_18?: boolean;
  removed_by_category?: string | null;
  crosspost_parent_list?: RdContent[] | null;
};
type RdComment = { author?: string; body?: string; score?: number; stickied?: boolean; distinguished?: string | null; replies?: unknown };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** 存档给的是没转义的原文，但有的地址里还带着 `&amp;`（Reddit 接口的老写法）：只在地址上还原 */
const cleanUrl = (v: unknown): string | null => {
  const u = str(v).replace(/&amp;/g, "&");
  return /^https?:\/\//i.test(u) ? u : null;
};
const dim = (v: unknown): number | null => {
  const n = toCount(v);
  return n && n > 0 ? n : null;
};
const GONE = /^\[\s*(removed|deleted)(\s+by\s+[\w\s]+)?\s*\]$/i;

/** 评论树 → 一行一条（深度优先；「more」节点 = 没展开的回复，跳过）。 */
export function flattenComments(nodes: unknown): RdComment[] {
  const out: RdComment[] = [];
  const stack = Array.isArray(nodes) ? [...nodes].reverse() : [];
  while (stack.length > 0) {
    const node = obj(stack.pop());
    if (node.kind !== "t1") continue;
    const data = obj(node.data) as RdComment;
    out.push(data);
    const children = obj(obj(data.replies).data).children;
    if (Array.isArray(children)) stack.push(...[...children].reverse());
  }
  return out;
}

/** 值得留的评论，按赞数从高到低：删掉的、版主置顶的公告、AutoModerator 的不要。 */
export function pickComments(rows: RdComment[], max = TOP_COMMENTS): FetchedPost["topComments"] {
  return rows
    .filter((c) => {
      const body = str(c.body).trim();
      if (!body || GONE.test(body)) return false;
      if (str(c.author).toLowerCase() === "automoderator") return false;
      return !(c.stickied && c.distinguished === "moderator");
    })
    .map((c) => ({ text: Array.from(str(c.body).trim()).slice(0, COMMENT_MAX).join(""), likes: typeof c.score === "number" && Number.isFinite(c.score) ? Math.round(c.score) : null }))
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    .slice(0, max);
}

/** DASH 清单里码率最高的那条声音的文件名（`CMAF_AUDIO_128.mp4`）；没有声音返回 null（纯函数）。 */
export function pickDashAudio(mpd: string): string | null {
  let best: { name: string; bandwidth: number } | null = null;
  for (const set of mpd.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    if (!/contentType="audio"|mimeType="audio\//.test(`${set[1]}${set[2]}`)) continue;
    for (const rep of set[2].matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)) {
      const name = /<BaseURL>([^<]+)<\/BaseURL>/.exec(rep[2])?.[1].trim();
      const bandwidth = Number(/\bbandwidth="(\d+)"/.exec(rep[1])?.[1] ?? 0);
      // 只认清单同目录下的文件名：不跟去别的地址
      if (name && /^[\w.-]+$/.test(name) && (!best || bandwidth > best.bandwidth)) best = { name, bandwidth };
    }
  }
  return best?.name ?? null;
}

const REMOVED_BY: Record<string, string> = {
  moderator: "被版主移除了",
  automod_filtered: "被版块的自动审核拦下了",
  reddit: "被 Reddit 的反垃圾系统移除了",
  anti_evil_ops: "被 Reddit 官方移除了",
  community_ops: "被 Reddit 官方移除了",
  content_takedown: "因投诉被 Reddit 下架了",
  copyright_takedown: "因版权投诉被下架了",
  author: "被作者自己移除了",
  deleted: "被作者删除了",
};

/** 「发帖后多久」：存档是什么时候记下这些数字的。 */
function ageLabel(seconds: number): string {
  if (seconds < 60) return "1 分钟内";
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} 小时`;
  return `${Math.round(seconds / 86400)} 天`;
}

const IMAGE_URL = /\.(jpe?g|png|webp|gif)(\?|$)/i;

/** 这条帖子（或它转的原帖）里的图。animated = 动图只取了静止的画面。 */
function imagesOf(c: RdContent): { images: RemoteFile[]; captions: string[]; animated: number } {
  const meta = c.media_metadata ?? {};
  const preview = c.preview?.images?.[0]?.source;
  const fromMeta = (id: string): { file: RemoteFile; animated: boolean } | null => {
    const m = meta[id];
    if (!m || (m.status && m.status !== "valid")) return null;
    const still = cleanUrl(m.s?.u);
    if (still) return { file: { url: still, width: dim(m.s?.x), height: dim(m.s?.y) }, animated: false };
    // 动图：`s` 里只有 gif / mp4，静止的画面在 `p`（从小到大的几档预览）里
    const p = [...(m.p ?? [])].reverse().find((x) => cleanUrl(x.u));
    return p ? { file: { url: cleanUrl(p.u)!, width: dim(p.x), height: dim(p.y) }, animated: true } : null;
  };
  const items = c.gallery_data?.items;
  if (Array.isArray(items) && items.length > 0) {
    const images: RemoteFile[] = [];
    const captions: string[] = [];
    let animated = 0;
    for (const it of items) {
      const got = it.media_id ? fromMeta(it.media_id) : null;
      if (!got) continue;
      images.push(got.file);
      if (got.animated) animated++;
      if (str(it.caption).trim()) captions.push(`图 ${images.length}：${str(it.caption).trim()}`);
    }
    return { images, captions, animated };
  }
  const url = cleanUrl(c.url);
  if (!c.is_self && url && (c.post_hint === "image" || IMAGE_URL.test(url))) {
    const still = cleanUrl(preview?.url);
    // 动图的原文件是 gif：存静止的预览图，没有预览才试原文件
    const gif = /\.gif(\?|$)/i.test(url);
    const file: RemoteFile = gif && still ? { url: still, backupUrls: [url] } : { url, ...(still ? { backupUrls: [still] } : {}) };
    return { images: [{ ...file, width: dim(preview?.width), height: dim(preview?.height) }], captions: [], animated: gif ? 1 : 0 };
  }
  // 正文里插的图：按在正文里出现的先后排
  const text = str(c.selftext);
  const inline = Object.keys(meta)
    .map((id) => ({ id, at: text.indexOf(id), got: fromMeta(id) }))
    .filter((x): x is { id: string; at: number; got: { file: RemoteFile; animated: boolean } } => x.got !== null)
    .sort((a, b) => (a.at < 0 ? Infinity : a.at) - (b.at < 0 ? Infinity : b.at));
  return { images: inline.map((x) => x.got.file), captions: [], animated: inline.filter((x) => x.got.animated).length };
}

export type RedditRead = {
  /** 存档里的帖子对象 */
  post: unknown;
  /** 评论树（`data` 数组）；null = 没读到（和「没有评论」不是一回事），commentsError 说为什么 */
  comments: unknown[] | null;
  commentsError?: string;
  /** 视频的声音文件；undefined = 帖子没有视频或是没声音的动图，null = 清单读到了、里面没有声音，"failed" = 清单没读到 */
  audio?: RemoteFile | null | "failed";
};

/**
 * 存档读到的东西 → 帖子 + 它指向的链接（纯函数）。帖子不是存档里那一条（没有 id）抛 SourceFetchError。
 * 链接帖（帖子本身就是一个链接）的那个链接放进 mentions，由 follow.ts 跟着读。
 */
export function mapRedditPost(read: RedditRead, ref: LinkRef): Followed {
  const p = obj(read.post) as RdPost;
  if (!p.id || typeof p.title !== "string") throw new SourceFetchError("这个 Reddit 帖子读不到：存档返回的不是一条帖子");
  const origin = Array.isArray(p.crosspost_parent_list) ? p.crosspost_parent_list[0] : undefined;
  // 转帖自己没有内容，内容在原帖上（存档把原帖整个带在里面）
  const c: RdContent = origin && typeof origin === "object" ? origin : p;
  const notes: string[] = [];

  const sub = str(p.subreddit);
  const author = str(p.author);
  const hasAuthor = author !== "" && !GONE.test(author);

  // 这些数字是什么时候的
  const created = typeof p.created_utc === "number" ? p.created_utc : null;
  const seen = Math.max(typeof p.retrieved_on === "number" ? p.retrieved_on : 0, typeof p._meta?.retrieved_2nd_on === "number" ? p._meta.retrieved_2nd_on : 0);
  notes.push(
    created !== null && seen > created
      ? `Reddit 不让服务器直接读，内容来自第三方存档（Arctic Shift）：点赞数和评论数是发帖后 ${ageLabel(seen - created)}记下的，之后的变化没有`
      : "Reddit 不让服务器直接读，内容来自第三方存档（Arctic Shift）：点赞数和评论数是存档那一刻的，可能比现在的少"
  );
  if (origin) notes.push(`这是一条转帖：内容来自${str(c.subreddit) ? ` r/${str(c.subreddit)} ` : ""}的原帖，点赞数和评论是这条转帖自己的`);
  const removed = str(p.removed_by_category);
  if (removed) notes.push(`这条帖子${REMOVED_BY[removed] ?? "被移除了"}，读到的是存档里留下的内容`);

  let body = str(c.selftext).trim();
  if (GONE.test(body)) {
    body = "";
    notes.push("正文在存档收录之前就被删了，没读到");
  }
  // 被移除的帖子标题会换成「[ Removed by moderator ]」；存档收录得早的话还留着原来的
  const rawTitle = p.title.trim();
  const kept = str(p._meta?.edited_title).trim();
  const title = !GONE.test(rawTitle) ? rawTitle : kept && !GONE.test(kept) ? kept : "";
  if (!title && rawTitle) notes.push("标题在存档收录之前就被移除了");
  if (p.over_18) notes.push("帖子标了 NSFW（成人内容）");
  if (c.poll_data) notes.push("帖子里有一个投票，选项和票数没读");

  // 视频（Reddit 自己托管的）
  const rv = c.media?.reddit_video ?? c.secure_media?.reddit_video;
  const videoUrl = c.is_video !== false ? cleanUrl(rv?.fallback_url) : null;
  const cover = cleanUrl(c.preview?.images?.[0]?.source?.url);
  let video: FetchedPost["video"] = null;
  let images: RemoteFile[] = [];
  if (videoUrl) {
    const audio = read.audio && read.audio !== "failed" ? read.audio : null;
    video = { url: videoUrl, width: dim(rv?.width), height: dim(rv?.height), bytes: null, durationS: dim(rv?.duration), ...(audio ? { audio } : {}) };
    if (cover) images = [{ url: cover }];
    if (read.audio === "failed") notes.push("没找到这个视频的声音文件（Reddit 把画面和声音分开放），只有画面：说了什么读不到");
  } else {
    const got = imagesOf(c);
    images = got.images;
    if (got.captions.length > 0) body = [body, got.captions.join("\n")].filter(Boolean).join("\n\n");
    if (got.animated > 0) notes.push(`有 ${got.animated} 张动图，只存了静止的画面`);
  }

  // 链接帖：帖子本身是一个指向别处的链接
  const mentions: Mention[] = [];
  const link = cleanUrl(c.url);
  const selfLink = !link || /^https?:\/\/([\w-]+\.)?(reddit\.com\/(r\/[^/]+\/comments|gallery)\/|redd\.it\/)/i.test(link);
  if (!c.is_self && !video && images.length === 0 && link && !selfLink) {
    body = [body, `链接：${link}`].filter(Boolean).join("\n\n");
    mentions.push({ how: "link", url: link, ref: null });
  }

  // 评论
  const total = toCount(p.num_comments);
  let topComments: FetchedPost["topComments"] = [];
  if (read.comments === null) notes.push(`评论没读到（${read.commentsError || "存档接口出错"}）`);
  else {
    const rows = flattenComments(read.comments);
    topComments = pickComments(rows);
    if (rows.length === 0 && total) notes.push(`帖子报了 ${total} 条评论，存档里一条都还没有`);
    else if (rows.length > topComments.length) notes.push(`评论一共 ${Math.max(total ?? 0, rows.length)} 条，从存档里读到的 ${rows.length} 条里按赞数留了 ${topComments.length} 条`);
  }

  const flair = str(p.link_flair_text).replace(/:[\w-]+:/g, "").trim();
  const permalink = /^\/r\/[\w.-]+\/comments\/\w+\//.test(str(p.permalink)) ? `https://www.reddit.com${str(p.permalink)}` : undefined;
  const post: FetchedPost = {
    platform: "reddit",
    externalId: ref.externalId,
    ...(permalink ? { url: permalink } : {}),
    kind: video ? "video" : images.length > 0 ? "image" : "text",
    title,
    text: body,
    author: { id: str(p.author_fullname) || null, name: [hasAuthor ? `u/${author}` : "", sub ? `r/${sub}` : ""].filter(Boolean).join(" · ") },
    publishedAt: created !== null ? new Date(created * 1000).toISOString() : null,
    // 被踩到负数的帖子，Reddit 自己显示的也是 0
    stats: { ...emptyStats(), likes: typeof p.score === "number" ? Math.max(0, Math.round(p.score)) : null, comments: total },
    hashtags: flair ? [flair] : [],
    topComments,
    images,
    video,
    music: null,
    notes,
  };
  return { post, mentions };
}

/** 存档里没有这条帖子（多半是刚发的，还没收录）。 */
export class RedditArchiveMiss extends SourceFetchError {
  constructor() {
    super("存档里还没有这条帖子");
    this.name = "RedditArchiveMiss";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 问一次存档，返回 `data`。它嫌快（422 / 429）时等一下再问一次。列一个用户的帖子（account-reddit.ts）也用它。 */
export async function archiveGet(path: string, wait = sleep): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await labeledFetch(SERVICE, `${ARCHIVE}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if ((res.status === 422 || res.status === 429) && attempt === 0) {
      await res.body?.cancel().catch(() => {});
      await wait(1500);
      continue;
    }
    if (!res.ok) throw await httpError(SERVICE, res);
    return obj(await res.json()).data;
  }
}

/** 视频的声音文件：去 v.redd.it 的 DASH 清单里找（帖子里只有画面的地址）。 */
async function findAudio(videoUrl: string): Promise<RemoteFile | null | "failed"> {
  try {
    const base = new URL(videoUrl);
    if (base.hostname !== "v.redd.it") return "failed";
    const res = await labeledFetch("Reddit 视频(v.redd.it)", new URL("DASHPlaylist.mpd", base).href.split("?")[0], { headers: { "user-agent": DESKTOP_UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return "failed";
    }
    const name = pickDashAudio(await res.text());
    return name ? { url: new URL(name, base).href.split("?")[0] } : null;
  } catch {
    return "failed";
  }
}

/**
 * 读一条 Reddit 帖子（连同它指向的链接，没跟着读）。存档里没有抛 RedditArchiveMiss，存档本身出错抛普通的 Error
 * （这两种调用方都还可以换网页的读法试一次，见 fetch-post.ts）。评论没读到不算失败，记进 notes。
 */
export async function readRedditPost(ref: LinkRef, wait = sleep): Promise<Followed> {
  if (!/^[0-9a-z]{4,10}$/.test(ref.externalId)) throw new SourceFetchError("这不是一个 Reddit 帖子的链接");
  const posts = await archiveGet(`/posts/ids?ids=${ref.externalId}`, wait);
  const raw = Array.isArray(posts) ? posts.find((x) => obj(x).id === ref.externalId) : undefined;
  if (!raw) throw new RedditArchiveMiss();
  let comments: unknown[] | null = null;
  let commentsError: string | undefined;
  try {
    const tree = await archiveGet(`/comments/tree?link_id=t3_${ref.externalId}&limit=${COMMENT_ROWS}`, wait);
    if (Array.isArray(tree)) comments = tree;
    else commentsError = "存档返回的不是评论";
  } catch (e) {
    commentsError = (e instanceof Error ? e.message : String(e)).slice(0, 100);
  }
  const p = obj(raw) as RdPost;
  const c: RdContent = (Array.isArray(p.crosspost_parent_list) ? p.crosspost_parent_list[0] : undefined) ?? p;
  const rv = c.media?.reddit_video ?? c.secure_media?.reddit_video;
  const videoUrl = c.is_video !== false ? cleanUrl(rv?.fallback_url) : null;
  const audio = videoUrl && !rv?.is_gif ? await findAudio(videoUrl) : undefined;
  return mapRedditPost({ post: raw, comments, commentsError, audio }, ref);
}
