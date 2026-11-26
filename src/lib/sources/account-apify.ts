import { listedTitle, type AccountInfo, type ListedPost } from "./account";
import { douyinUrl, type AccountRef } from "./link";
import { cleanDesc } from "./xhs";
import { XHS_ACTOR } from "./xhs-apify";

/**
 * 列一个 TikTok / 抖音 / 小红书 / Instagram / YouTube / B 站账号的作品：走 Apify 上的 actor（这几个平台的作品列表都要带签名的接口才给，直接读不到）。
 * 这里只有每个 actor 的输入怎么写、输出怎么认（纯函数）；怎么跑、怎么等在 account-list.ts。
 *
 * | 平台 | actor | 计费（BRONZE 档） | 实测（2026-11-26，云端容器） |
 * |---|---|---|---|
 * | TikTok | clockworks~tiktok-profile-scraper（Store 里用量最大的 TikTok 主页采集器） | $0.002 / 条 | 3 条 23 秒 |
 * | 抖音 | zen-studio~douyin-profile-scraper（和读单条的 actor 是同一个作者，见 douyin.ts） | 每次运行 $0.001 + $0.005 / 条 | 3 条 12 秒 |
 * | 小红书 | socialdatax~socialdatax-xhs-data-api 的 list_user_notes（和不带口令读单篇的是同一个 actor，见 xhs-apify.ts） | $0.005 / 条 | 5 条 6 秒 |
 * | Instagram | apify~instagram-scraper（和读单条帖子的是同一个，见 instagram.ts），给主页链接、`resultsType: "posts"` | $0.0023 / 条 | 4 条 29 秒 |
 * | YouTube | streamers~youtube-scraper（和走 Apify 读单个视频的是同一个，见 youtube-apify.ts），给频道链接 | $0.003 / 条 | 视频 3 条 + Shorts 2 条 27 秒 |
 * | B 站 | socialdatax~socialdatax-bilibili-data-api 的 list_user_videos（和小红书那个是同一家） | $0.003 / 条 | 5 条 6 秒 |
 *
 * 都按「最近的 N 条」列（置顶的排在最前面，可能是很久以前发的）。TikTok、抖音、YouTube 每一条都带着账号信息（名字、简介、作品总数）；
 * 小红书、Instagram、B 站只带着名字（简介、作品总数这条路不给）。B 站只列投稿的视频，专栏和动态不列；视频本身按网页读
 * （本机有 yt-dlp 时按视频读，见 web.ts），B 站自己的接口从机房 IP 直接读会被风控拦（2026-11-26 实测回 412）。YouTube 的视频和 Shorts 是两栏，各要 N 条（所以最多收 2N 条的钱），
 * 合起来挑最新的 N 条；直播回放不列。小红书列出来的笔记没有访问口令，读每一篇也要走 Apify（见 fetch-post.ts）。
 * 第三方 actor 可能改名 / 下架，用 env APIFY_TIKTOK_PROFILE_ACTOR / APIFY_DOUYIN_PROFILE_ACTOR / APIFY_XHS_PROFILE_ACTOR /
 * APIFY_INSTAGRAM_PROFILE_ACTOR / APIFY_YOUTUBE_PROFILE_ACTOR / APIFY_BILIBILI_PROFILE_ACTOR 换
 * （输入、输出形状要和默认的一样）。列几百条要多久、actor 一次最多给多少条没测过。
 */

export type ProfileActor = {
  actor: () => string;
  /** 计数键（lib/usage/prices.ts 的 UNIT_USD）：按列出来的条数计 */
  countKey: string;
  /** 一条大约多少钱（给这次运行设收费上限用，按 FREE 档算，宁可高） */
  perItemUsd: number;
  /** 要 N 条时 actor 最多会给（也就是收）几倍的条数：YouTube 的视频和 Shorts 各要 N 条再合起来挑最新的，是 2；不写是 1 */
  rowsPerPost?: number;
  input: (ref: AccountRef, limit: number) => unknown;
  read: (items: unknown[], ref: AccountRef) => { info: AccountInfo | null; posts: ListedPost[] };
};

export const TIKTOK_PROFILE_COUNT_KEY = "apify_tiktok_profile_post";
export const DOUYIN_PROFILE_COUNT_KEY = "apify_douyin_profile_post";
export const XHS_PROFILE_COUNT_KEY = "apify_xhs_profile_post";
export const INSTAGRAM_PROFILE_COUNT_KEY = "apify_instagram_profile_post";
export const YOUTUBE_CHANNEL_COUNT_KEY = "apify_youtube_channel_video";
export const BILIBILI_PROFILE_COUNT_KEY = "apify_bilibili_profile_video";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const isoFromSeconds = (v: unknown): string | null => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null);

/** 同一条不重复（置顶的会在列表里出现两次）。 */
function dedupe(posts: ListedPost[]): ListedPost[] {
  const seen = new Map<string, ListedPost>();
  for (const p of posts) {
    const had = seen.get(p.externalId);
    if (!had) seen.set(p.externalId, p);
    else if (p.pinned) had.pinned = true;
  }
  return [...seen.values()];
}

export function readTikTokProfile(items: unknown[], ref: AccountRef): { info: AccountInfo | null; posts: ListedPost[] } {
  let info: AccountInfo | null = null;
  const posts: ListedPost[] = [];
  for (const raw of items) {
    const it = obj(raw);
    const author = obj(it.authorMeta);
    const name = str(author.name);
    if (!info && name) info = { name: str(author.nickName) || name, handle: `@${name}`, bio: str(author.signature).trim(), postCount: count(author.video) };
    const id = str(it.id);
    if (!/^\d{8,24}$/.test(id)) continue;
    // 别人的视频（转发栏）不要；没带作者的当成他自己的
    if (name && name.toLowerCase() !== ref.externalId) continue;
    posts.push({
      externalId: id,
      url: `https://www.tiktok.com/@${name || ref.externalId}/video/${id}`,
      kind: it.isSlideshow === true ? "image" : "video",
      title: listedTitle(str(it.text)),
      publishedAt: isoFromSeconds(it.createTime),
      pinned: it.isPinned === true,
    });
  }
  return { info, posts: dedupe(posts) };
}

export function readDouyinProfile(items: unknown[]): { info: AccountInfo | null; posts: ListedPost[] } {
  let info: AccountInfo | null = null;
  const posts: ListedPost[] = [];
  for (const raw of items) {
    const it = obj(raw);
    const author = obj(it.authorMeta);
    const name = str(author.name);
    if (!info && name) {
      const handle = str(author.customUsername) || str(author.username);
      info = { name, handle: handle ? `抖音号 ${handle}` : "", bio: str(author.signature).trim(), postCount: count(author.awemeCount) ?? count(author.videoCount) };
    }
    const id = str(it.id);
    if (!/^\d{6,24}$/.test(id)) continue;
    const kind = str(it.type) === "imageText" ? "image" : "video";
    posts.push({ externalId: id, url: douyinUrl(id, kind), kind, title: listedTitle(str(it.title) || str(it.text)), publishedAt: isoFromSeconds(it.createTime), pinned: it.isPinned === true });
  }
  return { info, posts: dedupe(posts) };
}

export function readXhsProfile(items: unknown[], ref: AccountRef): { info: AccountInfo | null; posts: ListedPost[] } {
  let info: AccountInfo | null = null;
  const posts: ListedPost[] = [];
  for (const raw of items) {
    const it = obj(raw);
    const author = str(it.author_user_id).toLowerCase();
    // 别人的笔记不要；没带作者的当成他自己的
    if (author && author !== ref.externalId) continue;
    if (!info && str(it.author_name)) info = { name: str(it.author_name), handle: "", bio: "", postCount: null };
    const id = str(it.note_id).toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(id)) continue;
    posts.push({
      externalId: id,
      // 没有访问口令：读的时候按 id 走 Apify
      url: `https://www.xiaohongshu.com/explore/${id}`,
      kind: str(it.note_type) === "video" ? "video" : "image",
      // 正文里的话题写成 `#话题[话题]#`：先理顺再取第一行
      title: str(it.title).trim() || listedTitle(cleanDesc(str(it.summary))),
      publishedAt: isoFromSeconds(it.publish_time),
      pinned: it.is_pinned === true,
    });
  }
  return { info, posts: dedupe(posts) };
}

export function readInstagramProfile(items: unknown[], ref: AccountRef): { info: AccountInfo | null; posts: ListedPost[] } {
  let info: AccountInfo | null = null;
  const posts: ListedPost[] = [];
  for (const raw of items) {
    const it = obj(raw);
    // actor 说没读到的那一行（账号不存在、私密、没有帖子）带着 error
    if (it.error) continue;
    const owner = str(it.ownerUsername);
    if (!info && owner.toLowerCase() === ref.externalId) info = { name: str(it.ownerFullName).trim() || owner, handle: `@${owner}`, bio: "", postCount: null };
    const code = str(it.shortCode);
    if (!/^[\w-]{5,40}$/.test(code)) continue;
    // 和别人合发的帖子（作者栏是别人）也在他的主页上，照样要
    const published = Date.parse(str(it.timestamp));
    posts.push({
      externalId: code,
      url: `https://www.instagram.com/p/${code}/`,
      kind: str(it.type) === "Video" ? "video" : "image",
      title: listedTitle(str(it.caption)),
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
      pinned: it.isPinned === true,
    });
  }
  // 一条自己署名的都没有（全是合发的）：名字用链接里的用户名
  if (!info && posts.length > 0) info = { name: "", handle: ref.handle, bio: "", postCount: null };
  return { info, posts: dedupe(posts) };
}

export function readYouTubeChannel(items: unknown[]): { info: AccountInfo | null; posts: ListedPost[] } {
  let info: AccountInfo | null = null;
  const posts: ListedPost[] = [];
  for (const raw of items) {
    const it = obj(raw);
    const channel = str(it.channelName);
    if (!info && channel) info = { name: channel, handle: str(it.channelUsername) ? `@${str(it.channelUsername)}` : "", bio: str(it.channelDescription).trim(), postCount: count(it.channelTotalVideos) };
    const id = str(it.id);
    if (!/^[\w-]{11}$/.test(id)) continue;
    const published = Date.parse(str(it.date));
    posts.push({
      externalId: id,
      // 和单独贴这条链接认出来的写法一样（link.ts 的 siteRef）
      url: str(it.type) === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
      kind: "video",
      title: Array.from(str(it.title).trim()).slice(0, 80).join(""),
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
      pinned: false,
    });
  }
  return { info, posts: dedupe(posts) };
}

export function readBilibiliProfile(items: unknown[], ref: AccountRef): { info: AccountInfo | null; posts: ListedPost[] } {
  let info: AccountInfo | null = null;
  const posts: ListedPost[] = [];
  for (const raw of items) {
    const it = obj(raw);
    const author = str(it.author_user_id);
    // 联合投稿里别人名下的不要；没带作者的当成他自己的
    if (author && author !== ref.externalId) continue;
    if (!info && str(it.author_name)) info = { name: str(it.author_name), handle: "", bio: "", postCount: null };
    const bv = str(it.content_id);
    if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) continue;
    posts.push({
      externalId: bv,
      // 和单独贴这条链接整理出来的写法一样（link.ts 的 webRef）
      url: `https://www.bilibili.com/video/${bv}`,
      kind: "video",
      title: Array.from(str(it.title).trim()).slice(0, 80).join(""),
      publishedAt: isoFromSeconds(it.publish_time),
      pinned: false,
    });
  }
  return { info, posts: dedupe(posts) };
}

export const PROFILE_ACTORS: Record<"tiktok" | "douyin" | "xiaohongshu" | "instagram" | "youtube" | "bilibili", ProfileActor> = {
  tiktok: {
    actor: () => process.env.APIFY_TIKTOK_PROFILE_ACTOR?.trim() || "clockworks~tiktok-profile-scraper",
    countKey: TIKTOK_PROFILE_COUNT_KEY,
    perItemUsd: 0.003,
    input: (ref, limit) => ({ profiles: [ref.externalId], resultsPerPage: limit, profileSorting: "latest", profileScrapeSections: ["videos"] }),
    read: readTikTokProfile,
  },
  douyin: {
    actor: () => process.env.APIFY_DOUYIN_PROFILE_ACTOR?.trim() || "zen-studio~douyin-profile-scraper",
    countKey: DOUYIN_PROFILE_COUNT_KEY,
    perItemUsd: 0.007,
    input: (ref, limit) => ({ profileUrls: [ref.url], maxPostsPerProfile: limit }),
    read: (items) => readDouyinProfile(items),
  },
  xiaohongshu: {
    actor: () => process.env.APIFY_XHS_PROFILE_ACTOR?.trim() || XHS_ACTOR(),
    countKey: XHS_PROFILE_COUNT_KEY,
    perItemUsd: 0.005,
    input: (ref, limit) => ({ operation: "list_user_notes", profile_url: ref.url, max_items: limit, auto_paginate: true }),
    read: readXhsProfile,
  },
  instagram: {
    // 和读单条帖子的是同一个 actor（instagram.ts）；那边换了这边跟着换
    actor: () => process.env.APIFY_INSTAGRAM_PROFILE_ACTOR?.trim() || process.env.APIFY_INSTAGRAM_ACTOR?.trim() || "apify~instagram-scraper",
    countKey: INSTAGRAM_PROFILE_COUNT_KEY,
    perItemUsd: 0.003,
    input: (ref, limit) => ({ directUrls: [ref.url], resultsType: "posts", resultsLimit: limit, addParentData: false }),
    read: readInstagramProfile,
  },
  youtube: {
    // 和走 Apify 读单个视频的是同一个 actor（youtube-apify.ts）；那边换了这边跟着换
    actor: () => process.env.APIFY_YOUTUBE_PROFILE_ACTOR?.trim() || process.env.APIFY_YOUTUBE_ACTOR?.trim() || "streamers~youtube-scraper",
    countKey: YOUTUBE_CHANNEL_COUNT_KEY,
    perItemUsd: 0.004,
    rowsPerPost: 2,
    // 视频和 Shorts 是两栏，各要最新的 N 条，合起来再挑最新的 N 条；直播回放不要（一场几个小时）。不要字幕：读每一条的时候再读
    input: (ref, limit) => ({ startUrls: [{ url: ref.url }], maxResults: limit, maxResultsShorts: limit, maxResultStreams: 0, sortVideosBy: "NEWEST" }),
    read: (items) => readYouTubeChannel(items),
  },
  bilibili: {
    actor: () => process.env.APIFY_BILIBILI_PROFILE_ACTOR?.trim() || "socialdatax~socialdatax-bilibili-data-api",
    countKey: BILIBILI_PROFILE_COUNT_KEY,
    perItemUsd: 0.003,
    // 只列投稿的视频（专栏、动态不列），默认按时间从新到旧
    input: (ref, limit) => ({ operation: "list_user_videos", user_id: ref.externalId, max_items: limit, auto_paginate: true }),
    read: readBilibiliProfile,
  },
};
