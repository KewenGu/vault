import { labeledPublicFetch } from "@/lib/network/labeled-public-fetch";
import { labeledFetch } from "@/lib/fetch-error";
import { DESKTOP_UA, type LinkRef } from "./link";
import { cuesToText, type Cue } from "@/lib/media/transcript";
import { SourceFetchError, emptyStats, hashtagsIn, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一个 YouTube 视频（含 Shorts），不用登录、不花钱（2026-10-05 实测）：
 *
 * 1. YouTube App 用的播放接口（youtubei/v1/player，按 Android 客户端问）：标题、简介、作者、时长、播放数、关键词、
 *    字幕轨道（作者上传的 + 自动生成的，地址能直接读）、一路画面和声音合在一起的 mp4（通常是 360p）。
 * 2. 视频网页（顺手读，读不到不影响）：发布时间、点赞数。
 *
 * 字幕就是口播文字（`captions`）：有它就不用语音识别。视频按 360p 存（18 分钟约 36 MB），超过转存上限的不存，
 * 只看封面、字幕和简介。读不到评论。YouTube 对机房 IP 会要求登录验证，那时报 SourceFetchError。
 */

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" };
const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
const GONE = "这个 YouTube 视频读不到：可能被删了、设成了私享，或者链接不对";
/** 简介最多留这么多字 */
const TEXT_MAX = 30_000;
/** 字幕最多留这么多字（一小时的英文口播约 5 万字符）；拆解时再按提示词的上限截 */
const CAPTIONS_MAX = 80_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const posNum = (v: unknown): number | null => {
  const n = toCount(v);
  return n && n > 0 ? n : null;
};

/**
 * json3 格式的字幕 → 带时间的文字。一条字幕（几秒钟的话）是一个 event，`tStartMs` 是它开始的时间；
 * 接成段落、每段开头标时间（`[1:05] …`，见 transcript.ts），页面上好读、提示词里也省地方。
 */
export function captionText(json3: unknown, maxChars = CAPTIONS_MAX): string {
  const cues: Cue[] = [];
  for (const e of arr(obj(json3).events)) {
    const ev = obj(e);
    // aAppend 是自动字幕里的「换行」占位
    if (ev.aAppend) continue;
    const text = arr(ev.segs)
      .map((s) => str(obj(s).utf8))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ at: (toCount(ev.tStartMs) ?? 0) / 1000, text });
  }
  return cuesToText(cues, maxChars);
}

export type CaptionTrack = { baseUrl: string; languageCode: string; auto: boolean };

/**
 * 挑一条字幕轨道：视频原本说的语言（= 自动字幕的语言）里作者上传的那条最准；没有就用自动生成的；
 * 再没有（没有自动字幕）就按 中文 → 英文 → 第一条。
 */
export function pickCaptionTrack(raw: unknown): CaptionTrack | null {
  const tracks: CaptionTrack[] = arr(raw)
    .map((t) => obj(t))
    .filter((t) => str(t.baseUrl) && str(t.languageCode))
    .map((t) => ({ baseUrl: str(t.baseUrl), languageCode: str(t.languageCode), auto: t.kind === "asr" }));
  const base = (l: string) => l.toLowerCase().split("-")[0];
  const auto = tracks.find((t) => t.auto);
  const manual = tracks.filter((t) => !t.auto);
  return (
    (auto && manual.find((t) => base(t.languageCode) === base(auto.languageCode))) ??
    auto ??
    manual.find((t) => base(t.languageCode) === "zh") ??
    manual.find((t) => base(t.languageCode) === "en") ??
    manual[0] ??
    null
  );
}

/** 画面 + 声音合在一起的 mp4 里挑一路：不超过上限的最高清；都超了给最小的（下载时按大小拦下）。 */
export function pickFormat(raw: unknown, durationS: number | null, maxBytes: number): (RemoteFile & { durationS: number | null }) | null {
  const formats = arr(raw)
    .map((f) => obj(f))
    .filter((f) => str(f.url).startsWith("https://") && str(f.mimeType).startsWith("video/mp4"))
    .map((f) => ({
      url: str(f.url),
      width: posNum(f.width),
      height: posNum(f.height),
      bytes: posNum(f.contentLength) ?? (posNum(f.bitrate) && durationS ? Math.round((posNum(f.bitrate)! * durationS) / 8) : null),
    }));
  if (formats.length === 0) return null;
  const fits = formats.filter((f) => f.bytes === null || f.bytes <= maxBytes);
  const best = fits.length > 0 ? fits.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] : formats.sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0))[0];
  return { ...best, durationS };
}

/** 视频网页里顺手读的：发布时间、点赞数（页面改版读不到就是 null）。 */
export function parseWatchPage(html: string): { publishedAt: string | null; likes: number | null } {
  const date = Date.parse(/"publishDate":"([^"]+)"/.exec(html)?.[1] ?? "");
  return { publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null, likes: toCount(/"likeCount":"(\d+)"/.exec(html)?.[1]) };
}

/** 播放接口的返回 → 帖子（字幕、点赞数、发布时间由调用方另外读了传进来）。读不了的抛 SourceFetchError。 */
export function mapYouTubePlayer(
  player: unknown,
  extra: { publishedAt?: string | null; likes?: number | null; captions?: string | null; captionsAuto?: boolean; canYtdlp?: boolean },
  maxVideoBytes = 50 * 1024 * 1024
): FetchedPost {
  const p = obj(player);
  const details = obj(p.videoDetails);
  const id = str(details.videoId);
  const status = str(obj(p.playabilityStatus).status);
  if (!id) {
    const reason = str(obj(p.playabilityStatus).reason);
    // ERROR = 视频不存在 / 被删；别的（LOGIN_REQUIRED、UNPLAYABLE）是 YouTube 不给看：年龄限制、地区限制、要求登录验证
    if (status === "ERROR" || !status) throw new SourceFetchError(GONE);
    throw new SourceFetchError(`YouTube 不让读这个视频${reason ? `（${reason}）` : ""}。可以把视频的标题、简介贴进来直接分析`);
  }
  const durationS = posNum(details.lengthSeconds);
  const live = details.isLive === true;
  const description = str(details.shortDescription).trim();
  const title = str(details.title).trim();
  const notes: string[] = ["读不到评论"];
  const direct = live ? null : pickFormat(obj(p.streamingData).formats, durationS, maxVideoBytes);
  // 没有能直接下的地址：本机有 yt-dlp 就交给它
  const video: FetchedPost["video"] = direct ?? (!live && extra.canYtdlp ? { url: `https://www.youtube.com/watch?v=${id}`, via: "ytdlp", durationS } : null);
  if (live) notes.push("这是一场直播，没有下载视频");
  else if (!video) notes.push("没有拿到视频地址，只看了封面、字幕和简介");
  if (extra.captions && extra.captionsAuto) notes.push("字幕是 YouTube 自动生成的，可能有错字");
  if (!extra.captions) notes.push("没有读到字幕");

  // 封面：竖屏（Shorts）有专门的竖版图；横屏按清晰度从高到低试
  const vertical = !!direct && (direct.height ?? 0) > (direct.width ?? 0);
  const thumb = (name: string) => `https://i.ytimg.com/vi/${id}/${name}.jpg`;
  const listed = arr(obj(details.thumbnail).thumbnails)
    .map((t) => obj(t))
    .sort((a, b) => (posNum(b.width) ?? 0) - (posNum(a.width) ?? 0))
    .map((t) => str(t.url))
    .filter((u) => u.startsWith("https://"));
  const covers = [...(vertical ? [thumb("oar2")] : []), thumb("maxresdefault"), thumb("sddefault"), ...listed, thumb("hqdefault")];
  const keywords = arr(details.keywords).filter((k): k is string => typeof k === "string" && k.trim() !== "");
  return {
    platform: "youtube",
    externalId: id,
    kind: "video",
    title,
    text: Array.from(description).slice(0, TEXT_MAX).join(""),
    author: { id: str(details.channelId) || null, name: str(details.author) },
    publishedAt: extra.publishedAt ?? null,
    stats: { ...emptyStats(), views: toCount(details.viewCount), likes: extra.likes ?? null },
    // 标题 / 简介里的 #话题 在前，后面是作者填的关键词（搜索用的标签）
    hashtags: [...new Set([...hashtagsIn(`${title}\n${description}`), ...keywords.map((k) => k.trim())])].slice(0, 15),
    topComments: [],
    images: [{ url: covers[0], backupUrls: [...new Set(covers.slice(1))] }],
    video,
    music: null,
    captions: extra.captions ?? null,
    notes,
  };
}

async function callPlayer(id: string): Promise<unknown> {
  const res = await labeledFetch("YouTube(www.youtube.com)", PLAYER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ANDROID_UA },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId: id }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`YouTube ${res.status}：视频信息读不到，过一会儿再试`);
  }
  return res.json();
}

async function watchExtras(id: string): Promise<{ publishedAt: string | null; likes: number | null }> {
  const res = await labeledPublicFetch("YouTube(www.youtube.com)", `https://www.youtube.com/watch?v=${id}`, {
    headers: { "user-agent": DESKTOP_UA, "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+1; SOCS=CAI" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { publishedAt: null, likes: null };
  }
  return parseWatchPage(await res.text());
}

async function readCaptions(track: CaptionTrack): Promise<string | null> {
  const url = new URL(track.baseUrl, "https://www.youtube.com");
  // 字幕地址是接口给的：只认 YouTube 自己的域名
  if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
  url.searchParams.set("fmt", "json3");
  const res = await labeledPublicFetch("YouTube 字幕", url.href, { headers: { "user-agent": ANDROID_UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return captionText(await res.json().catch(() => null)) || null;
}

/**
 * 读一个 YouTube 视频。网络错误原样抛（可以重试）；视频读不了抛 SourceFetchError。
 * `canYtdlp`：本机有没有 yt-dlp（接口没给能直接下的视频地址时用它下）。
 */
export async function fetchYouTubeVideo(ref: LinkRef, maxVideoBytes?: number, canYtdlp = false): Promise<FetchedPost> {
  const [player, extras] = await Promise.all([callPlayer(ref.externalId), watchExtras(ref.externalId).catch(() => ({ publishedAt: null, likes: null }))]);
  const track = pickCaptionTrack(obj(obj(obj(player).captions).playerCaptionsTracklistRenderer).captionTracks);
  const captions = track ? await readCaptions(track).catch(() => null) : null;
  const post = mapYouTubePlayer(player, { ...extras, captions, captionsAuto: track?.auto ?? false, canYtdlp }, maxVideoBytes);
  if (post.externalId !== ref.externalId) throw new SourceFetchError(GONE);
  return post;
}
