import { listedTitle, type AccountInfo, type ListedPost } from "./account";
import { douyinUrl, type AccountRef } from "./link";

/**
 * 列一个 TikTok / 抖音账号的作品：走 Apify 上的 actor（两个平台的作品列表都要带签名的接口才给，直接读不到）。
 * 这里只有每个 actor 的输入怎么写、输出怎么认（纯函数）；怎么跑、怎么等在 account-list.ts。
 *
 * | 平台 | actor | 计费（BRONZE 档） | 实测（2026-11-26，云端容器） |
 * |---|---|---|---|
 * | TikTok | clockworks~tiktok-profile-scraper（Store 里用量最大的 TikTok 主页采集器） | $0.002 / 条 | 3 条 23 秒 |
 * | 抖音 | zen-studio~douyin-profile-scraper（和读单条的 actor 是同一个作者，见 douyin.ts） | 每次运行 $0.001 + $0.005 / 条 | 3 条 12 秒 |
 *
 * 两个都按「最近的 N 条」列（置顶的排在最前面，可能是很久以前发的）。每一条都带着账号信息（名字、简介、作品总数）。
 * 第三方 actor 可能改名 / 下架，用 env APIFY_TIKTOK_PROFILE_ACTOR / APIFY_DOUYIN_PROFILE_ACTOR 换（输入、输出形状要和这两个一样）。
 * 列几百条要多久、actor 一次最多给多少条没测过。
 */

export type ProfileActor = {
  actor: () => string;
  /** 计数键（lib/usage/prices.ts 的 UNIT_USD）：按列出来的条数计 */
  countKey: string;
  /** 一条大约多少钱（给这次运行设收费上限用，按 FREE 档算，宁可高） */
  perItemUsd: number;
  input: (ref: AccountRef, limit: number) => unknown;
  read: (items: unknown[], ref: AccountRef) => { info: AccountInfo | null; posts: ListedPost[] };
};

export const TIKTOK_PROFILE_COUNT_KEY = "apify_tiktok_profile_post";
export const DOUYIN_PROFILE_COUNT_KEY = "apify_douyin_profile_post";

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

export const PROFILE_ACTORS: Record<"tiktok" | "douyin", ProfileActor> = {
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
};
