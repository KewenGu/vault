import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import type { LinkRef } from "./link";
import { SourceFetchError, emptyStats, hashtagsIn, toCount, type FetchedPost } from "./types";

/**
 * B 站视频的后备：这台服务器读不了 B 站时（没有 yt-dlp，或者 yt-dlp 被 B 站拦了），走 Apify 上的 actor。
 *
 * 为什么要它：B 站按 IP 风控，云服务器的机房 IP 打开视频页就回 412（2026-11-26 用户的服务器上实测：
 * `yt-dlp` 报 `Unable to download webpage: HTTP Error 412`）。那之后视频只能按网页读到页面上的字。
 *
 * actor 是 apple_yang~bilibili-video-audio-downloader（每条结果 $0.003），输入 `{ videoUrls: [视频页的地址] }`，
 * 同步端点约 5 秒返回（2026-11-26 在云端容器里实测两条）。和别的平台一样：actor 可能改版，用 env APIFY_BILIBILI_ACTOR 换
 * （输入、输出形状要和这个一样），不用改代码。
 *
 * 拿得到：标题、简介、UP 主的名字、发布时间、播放 / 点赞 / 收藏 / 评论 / 转发数、封面、时长，和一个带声音的 mp4 的地址
 * （实测是 720p、H.264 + AAC；一条 40 分钟的视频 97 MB）。这个地址换一台机器也下得动（实测不带 Referer 也行），
 * 大约两小时后失效，要马上转存。另一个下载 actor（easyapi~bilibili-video-downloader）给的地址绑着它自己的 IP，
 * 别处下是 403，所以没用它。
 * 拿不到：评论内容、标签、UP 主的 id、别的清晰度（只有这一档，长视频会超过存档上限、留在服务器磁盘上）。
 * 分 P 的视频（地址带 `?p=`）没测过它给的是不是那一 P。
 */

const ACTOR = () => process.env.APIFY_BILIBILI_ACTOR?.trim() || "apple_yang~bilibili-video-audio-downloader";
export const BILIBILI_APIFY_COUNT_KEY = "apify_bilibili_video";

/**
 * 这个地址是不是 B 站的一个视频页；是的话给出 BV 号。带着来源参数、末尾斜杠、手机版域名的也认
 * （2026-11-26 以前存的内容，地址没有整理过）。
 */
export function bilibiliVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    return /(^|\.)bilibili\.com$/i.test(u.hostname) ? (/^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(u.pathname)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** 交给 actor 的地址：整理成 `bilibili.com/video/<BV 号>`，分 P 的留着 `?p=`。 */
function actorUrl(url: string, bvid: string): string {
  const part = Number(new URL(url).searchParams.get("p"));
  return `https://www.bilibili.com/video/${bvid}${Number.isInteger(part) && part > 1 ? `?p=${part}` : ""}`;
}

/** 能不能走这条路（配了 APIFY_TOKEN）。 */
export const canReadBilibiliViaApify = () => !!process.env.APIFY_TOKEN?.trim();

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const https = (u: string) => u.replace(/^http:\/\//i, "https://");

/**
 * actor 返回的一条 → 帖子（平台还是 web：B 站不是单独的一个来源）。没读到（空的、不是这个视频、actor 说出错了）抛 SourceFetchError。
 * why：为什么走了这条路（yt-dlp 没读到的原因；本机没有 yt-dlp 是 null），记进 notes。
 */
export function mapBilibiliItem(item: unknown, ref: Pick<LinkRef, "externalId" | "url">, why: string | null = null): FetchedPost {
  const it = (item && typeof item === "object" ? item : {}) as Obj;
  const bvid = bilibiliVideoId(ref.url);
  const title = str(it.title).trim();
  if (!bvid || str(it.bvid) !== bvid || !title || str(it.errMsg).trim()) throw new SourceFetchError("这个 B 站视频读不到：可能被删了、不公开，或者要登录才能看");
  const description = str(it.desc).trim() === "-" ? "" : str(it.desc).trim();
  const durationS = typeof it.duration === "number" && it.duration > 0 ? it.duration : null;
  const videoUrl = str(it.videoUrl).startsWith("https://") ? str(it.videoUrl) : null;
  const notes = [`这台服务器${why ? `上的 yt-dlp 没读到这个视频（${why}）` : "上没有 yt-dlp"}，这次是通过 Apify 读的`, "读不到评论内容，只有评论数"];
  if (!videoUrl) notes.push("没有拿到视频地址，只读到了封面和简介：画面和里面说的话都没读到");
  const created = typeof it.createTime === "number" && it.createTime > 0 ? new Date(it.createTime * 1000).toISOString() : null;
  return {
    platform: "web",
    externalId: ref.externalId,
    kind: "video",
    title,
    text: Array.from(description).slice(0, 30_000).join(""),
    author: { id: null, name: str(it.nickname).trim() },
    publishedAt: created,
    stats: { ...emptyStats(), views: toCount(it.view), likes: toCount(it.like), collects: toCount(it.favorite), comments: toCount(it.reply), shares: toCount(it.share) },
    hashtags: hashtagsIn(`${title}\n${description}`).slice(0, 15),
    topComments: [],
    images: str(it.img).startsWith("http") ? [{ url: https(str(it.img)) }] : [],
    video: videoUrl ? { url: videoUrl, width: null, height: null, bytes: null, durationS } : null,
    durationS,
    music: null,
    notes,
  };
}

/** 读一个 B 站视频（一次 Apify 运行，读到了记一笔 apify_bilibili_video）。没配 APIFY_TOKEN 抛 SourceFetchError。 */
export async function fetchBilibiliViaApify(ref: Pick<LinkRef, "externalId" | "url">, why: string | null = null): Promise<FetchedPost> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("走 Apify 读 B 站要配环境变量 APIFY_TOKEN");
  const bvid = bilibiliVideoId(ref.url);
  if (!bvid) throw new SourceFetchError("这不是一个 B 站视频的地址");
  const actor = ACTOR();
  // 令牌放请求头，不进 URL；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ videoUrls: [actorUrl(ref.url, bvid)] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  // 按结果计费
  recordCall(BILIBILI_APIFY_COUNT_KEY, items.length);
  return mapBilibiliItem(items[0], ref, why);
}
