import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import type { LinkRef } from "./link";
import { SourceFetchError, emptyStats, titleFromText, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条 Instagram 帖子 / Reels：走 Apify 官方的 actor（apify~instagram-scraper，按条计费，FREE 档 $0.0027 / 条）。
 *
 * 为什么不直接读：Instagram 的帖子页、嵌入页、GraphQL 接口没登录都只给登录墙（2026-10-05 实测，401 require_login）。
 * actor 输入 `{ directUrls: [...], resultsType: "posts" }`，同步端点约 20–40 秒返回。
 * 和抖音那条路一样：actor 可能改版，用 env APIFY_INSTAGRAM_ACTOR 换，不用改代码。
 *
 * 拿得到：文案、作者、发布时间、点赞 / 评论数、视频的播放数、话题、图片（轮播的每一张）、视频地址、背景音乐、最新的几条评论。
 * 拿不到：收藏数、转发数（Instagram 不公开）；作者隐藏点赞时点赞数也没有；轮播里的视频只存封面。
 */

const ACTOR = () => process.env.APIFY_INSTAGRAM_ACTOR?.trim() || "apify~instagram-scraper";
export const INSTAGRAM_COUNT_KEY = "apify_instagram_post";

type IgComment = { text?: string; likesCount?: number };
type IgChild = { type?: string; displayUrl?: string; videoUrl?: string; dimensionsWidth?: number; dimensionsHeight?: number };
type IgItem = IgChild & {
  error?: string;
  errorDescription?: string;
  id?: string;
  shortCode?: string;
  caption?: string;
  hashtags?: string[];
  commentsCount?: number;
  latestComments?: IgComment[];
  images?: string[];
  likesCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  videoDuration?: number;
  timestamp?: string;
  childPosts?: IgChild[];
  ownerFullName?: string;
  ownerUsername?: string;
  ownerId?: string;
  musicInfo?: { artist_name?: string; song_name?: string; uses_original_audio?: boolean };
};

const isUrl = (u: unknown): u is string => typeof u === "string" && u.startsWith("http");
const dim = (n: unknown): number | null => {
  const v = toCount(n);
  return v && v > 0 ? v : null;
};

/** actor 返回的一条 → 帖子。actor 说没读到（带 `error`）或形状不对抛 SourceFetchError。 */
export function mapInstagramItem(item: unknown, externalId: string): FetchedPost {
  const it = (item && typeof item === "object" ? item : {}) as IgItem;
  if (it.error || !it.shortCode) {
    throw new SourceFetchError("这个 Instagram 帖子读不到：可能被删了、账号是私密的，或者链接不是一个帖子。在 Instagram 里重新点「分享 → 复制链接」再贴一次");
  }
  const caption = (it.caption ?? "").trim();
  const notes: string[] = ["Instagram 不公开收藏数和转发数"];
  const children = Array.isArray(it.childPosts) ? it.childPosts : [];
  const isVideo = it.type === "Video" && isUrl(it.videoUrl);
  let images: RemoteFile[];
  if (it.type === "Sidecar" && children.length > 0) {
    images = children.filter((c) => isUrl(c.displayUrl)).map((c) => ({ url: c.displayUrl!, width: dim(c.dimensionsWidth), height: dim(c.dimensionsHeight) }));
    const clips = children.filter((c) => c.type === "Video").length;
    if (clips > 0) notes.push(`轮播里有 ${clips} 段视频，只存了它们的封面`);
  } else {
    const urls = [it.displayUrl, ...(Array.isArray(it.images) ? it.images : [])].filter(isUrl);
    images = [...new Set(urls)].slice(0, isVideo ? 1 : undefined).map((url) => ({ url, width: dim(it.dimensionsWidth), height: dim(it.dimensionsHeight) }));
  }
  if (it.type === "Video" && !isVideo) notes.push("没有拿到视频地址，只读到了封面");
  const likes = toCount(it.likesCount);
  if (likes === null) notes.push("作者隐藏了点赞数");
  const comments = (Array.isArray(it.latestComments) ? it.latestComments : [])
    .filter((c) => typeof c?.text === "string" && c.text.trim())
    .map((c) => ({ text: c.text!.trim(), likes: toCount(c.likesCount) }))
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    .slice(0, 8);
  if (comments.length > 0) notes.push("评论只读到最新的几条，不一定是最高赞的");
  const m = it.musicInfo;
  const song = m?.song_name?.trim();
  const published = Date.parse(it.timestamp ?? "");
  return {
    platform: "instagram",
    externalId: it.shortCode || externalId,
    kind: isVideo ? "video" : "image",
    title: titleFromText(caption),
    text: caption,
    author: { id: it.ownerId ? String(it.ownerId) : null, name: [it.ownerFullName?.trim(), it.ownerUsername ? `@${it.ownerUsername}` : ""].filter(Boolean).join(" ") },
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
    stats: { ...emptyStats(), views: toCount(it.videoPlayCount) ?? toCount(it.videoViewCount), likes, comments: toCount(it.commentsCount) },
    hashtags: (Array.isArray(it.hashtags) ? it.hashtags : []).filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim()),
    topComments: comments,
    images,
    video: isVideo ? { url: it.videoUrl!, width: dim(it.dimensionsWidth), height: dim(it.dimensionsHeight), bytes: null, durationS: dim(it.videoDuration) } : null,
    music: song ? `${song}${m?.artist_name?.trim() ? ` — ${m.artist_name.trim()}` : ""}` : m?.uses_original_audio ? "原声" : null,
    notes,
  };
}

/** 读一条 Instagram 帖子（一次 Apify 运行，记一笔 apify_instagram_post）。没配 APIFY_TOKEN 抛 SourceFetchError。 */
export async function fetchInstagramPost(ref: LinkRef): Promise<FetchedPost> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("读 Instagram 帖子要用 Apify（环境变量 APIFY_TOKEN 没配）。可以先把帖子文案贴进来直接分析");
  const actor = ACTOR();
  // 令牌放请求头，不进 URL；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ directUrls: [ref.url], resultsType: "posts", resultsLimit: 1, addParentData: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  // 跑成功就计费（哪怕返回的是「没读到」）
  recordCall(INSTAGRAM_COUNT_KEY);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  return mapInstagramItem(items[0], ref.externalId);
}
