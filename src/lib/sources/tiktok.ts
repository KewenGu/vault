import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import { DESKTOP_UA, type LinkRef } from "./link";
import { SourceFetchError, titleFromText, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条 TikTok 视频：按电脑浏览器打开视频页（`/@<用户>/video/<id>`），页面里的
 * `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` 带着整条视频——文案、作者、播放 / 点赞 / 评论 / 收藏 / 转发数、
 * 话题、背景音乐、封面、各档码流的地址。不用登录、不花钱（2026-10-05 实测）。
 *
 * 视频地址要带页面响应发的 cookie（tt_chain_token）和 `Referer: https://www.tiktok.com/` 才能下，否则 403——
 * 所以这里把 cookie 记在 RemoteFile.headers 里，下载时带上。地址带时效，调用方读完要马上转存。
 * 读不到评论内容。机房 IP 可能被 TikTok 拦（页面里没有视频信息），那时报 SourceFetchError。
 */

const SERVICE = "TikTok(www.tiktok.com)";
const GONE = "这个 TikTok 视频读不到：可能被删了、设成了私密，或者链接不对。在 TikTok 里重新点「分享 → 复制链接」再贴一次";
const BLOCKED = "TikTok 返回的页面里没有视频内容（可能触发了验证，或者这个地区看不了）。过一会儿再试，或者把视频文案贴进来直接分析";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const posNum = (v: unknown): number | null => {
  const n = toCount(v);
  return n && n > 0 ? n : null;
};

/** 从页面 HTML 里取那段 JSON。 */
export function extractUniversalData(html: string): unknown | null {
  const m = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** cookie 只发给 tiktok.com 自己的域名（浏览器也是这样）；CDN 域名（tiktokcdn…）只带 referer。 */
function headersFor(url: string, cookie: string): Record<string, string> {
  let own = false;
  try {
    own = /(^|\.)tiktok\.com$/i.test(new URL(url).hostname);
  } catch {
    // 地址不合法：当成不是自己的域名
  }
  // UA 和打开页面时用的一致（视频地址是按那次访问签发的）
  return { "user-agent": DESKTOP_UA, referer: "https://www.tiktok.com/", ...(own && cookie ? { cookie } : {}) };
}

type Stream = { urls: string[]; bytes: number | null; width: number | null; height: number | null; h264: boolean };

/** 各档码流里挑一档：优先 h264（哪儿都能放），同一种里挑不超过上限的最大那个；都超了给最小的（下载时按大小拦下）。 */
function pickStream(video: Obj, maxBytes: number): Stream | null {
  const streams: Stream[] = arr(video.bitrateInfo)
    .map((b) => obj(b))
    .map((b) => {
      const play = obj(b.PlayAddr);
      return {
        urls: arr(play.UrlList).filter((u): u is string => typeof u === "string" && u.startsWith("http")),
        bytes: posNum(play.DataSize),
        width: posNum(play.Width),
        height: posNum(play.Height),
        h264: !/265|hevc|hvc/i.test(str(b.CodecType)),
      };
    })
    .filter((s) => s.urls.length > 0);
  const fallback = [str(video.playAddr), str(video.downloadAddr)].filter((u) => u.startsWith("http"));
  if (streams.length === 0) return fallback.length > 0 ? { urls: fallback, bytes: posNum(video.size), width: posNum(video.width), height: posNum(video.height), h264: true } : null;
  const fits = streams.filter((s) => s.bytes === null || s.bytes <= maxBytes);
  const pool = fits.length > 0 ? fits : [...streams].sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0)).slice(0, 1);
  return pool.sort((a, b) => Number(b.h264) - Number(a.h264) || (b.bytes ?? 0) - (a.bytes ?? 0))[0];
}

/** 页面里的 JSON → 帖子。视频不在 / 私密 / 页面被拦抛 SourceFetchError。`cookie` 是页面响应发的（下载视频要带）。 */
export function parseTikTokData(data: unknown, opts: { maxVideoBytes?: number; cookie?: string } = {}): FetchedPost {
  const detail = obj(obj(obj(data).__DEFAULT_SCOPE__)["webapp.video-detail"]);
  const item = obj(obj(detail.itemInfo).itemStruct);
  const id = str(item.id);
  if (!id) {
    const code = typeof detail.statusCode === "number" ? detail.statusCode : null;
    // 10204 = 视频不存在，10216 = 私密视频，10222 = 私密账号
    if (code === 10216 || code === 10222) throw new SourceFetchError("这个 TikTok 视频是私密的，读不了。可以把视频文案贴进来直接分析");
    throw new SourceFetchError(code ? GONE : BLOCKED);
  }
  const cookie = opts.cookie ?? "";
  const maxBytes = opts.maxVideoBytes ?? 50 * 1024 * 1024;
  const video = obj(item.video);
  const author = obj(item.author);
  const music = obj(item.music);
  const stats = { ...obj(item.stats), ...obj(item.statsV2) };
  const desc = str(item.desc).trim();
  const notes: string[] = ["读不到评论内容，只有评论数"];

  // 图集（photo mode）：一组图 + 背景音乐，没有视频
  const slides: RemoteFile[] = arr(obj(item.imagePost).images)
    .map((i) => obj(i))
    .map((i) => {
      const urls = arr(obj(i.imageURL).urlList).filter((u): u is string => typeof u === "string" && u.startsWith("http"));
      return { url: urls[0] ?? "", backupUrls: urls.slice(1), headers: headersFor(urls[0] ?? "", cookie), width: posNum(i.imageWidth), height: posNum(i.imageHeight) };
    })
    .filter((i) => i.url);
  const isSlides = slides.length > 0;
  const stream = isSlides ? null : pickStream(video, maxBytes);
  if (!isSlides && !stream) notes.push("没有拿到视频地址，只读到了封面");
  const covers = [str(video.originCover), str(video.cover), str(video.dynamicCover)].filter((u) => u.startsWith("http"));
  const images: RemoteFile[] = isSlides ? slides : covers.length > 0 ? [{ url: covers[0], backupUrls: covers.slice(1), headers: headersFor(covers[0], cookie) }] : [];

  const tags = arr(item.challenges)
    .map((c) => str(obj(c).title).trim())
    .filter(Boolean);
  const extraTags = arr(item.textExtra)
    .map((t) => str(obj(t).hashtagName).trim())
    .filter(Boolean);
  const created = posNum(item.createTime);
  const durationS = posNum(video.duration);
  const musicTitle = str(music.title).trim();
  return {
    platform: "tiktok",
    externalId: id,
    kind: isSlides ? "image" : "video",
    title: titleFromText(desc),
    text: desc,
    author: { id: str(author.secUid) || str(author.id) || null, name: [str(author.nickname), str(author.uniqueId) ? `@${str(author.uniqueId)}` : ""].filter(Boolean).join(" ") },
    publishedAt: created ? new Date(created * 1000).toISOString() : null,
    stats: {
      views: toCount(stats.playCount),
      likes: toCount(stats.diggCount),
      collects: toCount(stats.collectCount),
      comments: toCount(stats.commentCount),
      shares: toCount(stats.shareCount),
    },
    hashtags: [...new Set(tags.length > 0 ? tags : extraTags)],
    topComments: [],
    images,
    video: stream
      ? { url: stream.urls[0], backupUrls: stream.urls.slice(1), headers: headersFor(stream.urls[0], cookie), width: stream.width ?? posNum(video.width), height: stream.height ?? posNum(video.height), bytes: stream.bytes, durationS }
      : null,
    music: musicTitle ? `${musicTitle}${music.original === true ? "（原声）" : str(music.authorName) ? ` — ${str(music.authorName)}` : ""}` : null,
    notes,
  };
}

/** 响应里的 Set-Cookie → 请求用的 Cookie 串（只要「名字=值」）。 */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("="))
    .join("; ");
}

/** 读一条 TikTok 视频。网络错误原样抛（可以重试）；视频读不到抛 SourceFetchError。 */
export async function fetchTikTokVideo(ref: LinkRef, maxVideoBytes?: number): Promise<FetchedPost> {
  const res = await labeledFetch(SERVICE, ref.url, {
    headers: { "user-agent": DESKTOP_UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) throw new SourceFetchError(GONE);
    throw new Error(`TikTok ${res.status}：页面打不开，过一会儿再试`);
  }
  const data = extractUniversalData(await res.text());
  if (!data) throw new SourceFetchError(BLOCKED);
  const post = parseTikTokData(data, { maxVideoBytes, cookie: cookieHeader(res) });
  if (post.externalId !== ref.externalId) throw new SourceFetchError(GONE);
  return post;
}
