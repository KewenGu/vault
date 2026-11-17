import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import type { LinkRef } from "./link";
import { SourceFetchError, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条抖音视频：走 Apify 上的第三方 actor（按条计费，FREE 档 $0.007 / 条）。
 *
 * 为什么不直接读：抖音的分享页（iesdouyin.com/share/video/<id>）现在是纯前端渲染，视频信息要带 a_bogus 签名的接口才给，
 * 海外网络打开还会提示「请在抖音内观看」（2026-10-05 实测）。actor 是 Apify Store 里用量最大的抖音采集器
 * （natanielsantos~douyin-scraper，累计 150 万次运行），输入 `{ postUrls: [...] }`，同步端点约 6 秒返回。
 * 和搜索层的 Apify 采集器一样：第三方 actor 可能改名 / 下架，用 env APIFY_DOUYIN_ACTOR 换，不用改代码。
 *
 * 拿得到：文案、作者、发布时间、点赞 / 评论 / 收藏 / 转发数、话题、背景音乐、封面、视频播放地址（带时效，要马上转存）。
 * 拿不到：评论内容（分析时只能看互动数）；长文案会被平台截断（末尾带「版本过低，升级后可展示全部信息」）。
 */

const ACTOR = () => process.env.APIFY_DOUYIN_ACTOR?.trim() || "natanielsantos~douyin-scraper";
export const DOUYIN_COUNT_KEY = "apify_douyin_post";

type DouyinItem = {
  error?: boolean;
  message?: string;
  id?: string;
  text?: string;
  createTime?: number;
  authorMeta?: { id?: string; secUid?: string; name?: string };
  musicMeta?: { name?: string; author?: string; isOriginal?: boolean };
  videoMeta?: { cover?: string; originCover?: string; dinamicCover?: string; width?: number; height?: number; duration?: number; playUrl?: string };
  thumb?: string;
  statistics?: { diggCount?: number; shareCount?: number; commentCount?: number; collectCount?: number };
  hashtags?: { name?: string }[];
};

const count = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
const TRUNCATED = /…*版本过低，升级后可展示全部信息$/;

/** actor 返回的一条 → 帖子。actor 说没读到（`error: true`）或形状不对抛 SourceFetchError。 */
export function mapDouyinItem(item: unknown, externalId: string): FetchedPost {
  const it = (item && typeof item === "object" ? item : {}) as DouyinItem;
  if (it.error || !it.id) {
    throw new SourceFetchError("这个抖音视频读不到：可能被删了、设成了私密，或者链接不是一个视频。在抖音里重新点「分享 → 复制链接」再贴一次");
  }
  const raw = (it.text ?? "").trim();
  const truncated = TRUNCATED.test(raw);
  const text = raw.replace(TRUNCATED, "…");
  const v = it.videoMeta ?? {};
  // 封面候选：原图（webp）→ 360p → 裁过的小图，按顺序试到一个能下的为止
  const covers = [v.dinamicCover, v.originCover, it.thumb, v.cover].filter((u): u is string => typeof u === "string" && u.startsWith("http"));
  const images: RemoteFile[] = covers.length > 0 ? [{ url: covers[0], backupUrls: covers.slice(1), width: null, height: null }] : [];
  const durationS = typeof v.duration === "number" && v.duration > 0 ? Math.round(v.duration / 100) / 10 : null;
  const music = it.musicMeta?.name ? `${it.musicMeta.name}${it.musicMeta.isOriginal ? "（原声）" : it.musicMeta.author ? ` — ${it.musicMeta.author}` : ""}` : null;
  // 抖音没有单独的标题：文案第一行（去掉话题）当标题
  const firstLine = text.split("\n")[0].replace(/#\S+/g, "").trim();
  return {
    platform: "douyin",
    externalId: String(it.id || externalId),
    kind: "video",
    title: Array.from(firstLine).slice(0, 60).join(""),
    text,
    author: { id: it.authorMeta?.secUid || it.authorMeta?.id || null, name: it.authorMeta?.name ?? "" },
    publishedAt: typeof it.createTime === "number" && it.createTime > 0 ? new Date(it.createTime * 1000).toISOString() : null,
    stats: { views: null, likes: count(it.statistics?.diggCount), collects: count(it.statistics?.collectCount), comments: count(it.statistics?.commentCount), shares: count(it.statistics?.shareCount) },
    hashtags: (it.hashtags ?? []).map((h) => (h?.name ?? "").trim()).filter(Boolean),
    topComments: [],
    images,
    video: v.playUrl ? { url: v.playUrl, width: count(v.width), height: count(v.height), bytes: null, durationS } : null,
    music,
    notes: [...(truncated ? ["文案被平台截断了，只读到前面一部分"] : []), "这条路读不到评论内容，只有评论数", ...(v.playUrl ? [] : ["没有拿到视频地址，只读到了封面"])],
  };
}

/** 读一条抖音视频（一次 Apify 运行，记一笔 apify_douyin_post）。没配 APIFY_TOKEN 抛 SourceFetchError。 */
export async function fetchDouyinVideo(ref: LinkRef): Promise<FetchedPost> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("读抖音视频要用 Apify（环境变量 APIFY_TOKEN 没配）。可以先把视频文案贴进来直接分析");
  const actor = ACTOR();
  // 令牌放请求头，不进 URL（报错信息、日志里不会带出来）；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ postUrls: [ref.url] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  // 跑成功就计费（哪怕返回的是「没读到」）
  recordCall(DOUYIN_COUNT_KEY);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  return mapDouyinItem(items[0], ref.externalId);
}
