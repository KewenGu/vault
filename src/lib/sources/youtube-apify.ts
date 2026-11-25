import { labeledFetch } from "@/lib/fetch-error";
import { labeledPublicFetch } from "@/lib/network/labeled-public-fetch";
import { summarizeErrorText } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import { cuesToText, type Cue } from "@/lib/media/transcript";
import { videoReadMaxBytes } from "@/lib/vault/limits";
import type { LinkRef } from "./link";
import { GONE } from "./youtube";
import { SourceFetchError, emptyStats, hashtagsIn, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * YouTube 的后备：播放接口不给这台机器读时（云服务器的机房 IP 一律被要求登录验证），走 Apify 上的 actor。
 *
 * actor 是 Apify 自己维护的 streamers~youtube-scraper（Store 里用量最大的 YouTube 采集器，FREE 档 $0.004 / 条）。
 * 输入 `{ startUrls: [{ url }], maxResults: 1, transcriptionAndSubtitle: "ALWAYS_SUBTITLES", subtitlesLanguage: "any",
 * subtitlesFormat: "srt" }`，同步端点约 8–30 秒返回（2026-11-19 在云端容器里实测）。和抖音那条路一样：actor 可能改版，
 * 用 env APIFY_YOUTUBE_ACTOR 换，不用改代码。
 *
 * 拿得到：标题、简介、作者、发布时间、观看 / 点赞 / 评论数、话题、时长、封面、字幕（作者上传的或自动生成的）。
 * 拿不到：视频本体、评论内容。视频本体由另一个 actor 下（见下面的 downloadYouTubeViaApify）。
 * 只要字幕、不让它转写：actor 的语音转写按分钟另收费（$0.048 / 分钟）。没有字幕的视频（2026-11-25 那条中文口播
 * 就没有）靠下下来的视频自己转写。
 *
 * 视频不存在时 actor 不报错，而是一直跑到超时（实测 150 秒）。所以先用 YouTube 公开的 oEmbed 接口问一下视频在不在，
 * 不在就不跑了。
 */

const ACTOR = () => process.env.APIFY_YOUTUBE_ACTOR?.trim() || "streamers~youtube-scraper";
export const YOUTUBE_APIFY_COUNT_KEY = "apify_youtube_video";
/** 下视频的 actor；设成 off 就不下（只读字幕） */
const DOWNLOAD_ACTOR = () => process.env.APIFY_YOUTUBE_DOWNLOAD_ACTOR?.trim() || "johnvc~youtube-download-api";
/** 按下到的视频的分钟数计 */
export const YOUTUBE_APIFY_DOWNLOAD_COUNT_KEY = "apify_youtube_download_minute";
const TEXT_MAX = 30_000;
const CAPTIONS_MAX = 80_000;

type Subtitle = { type?: string; language?: string; srt?: string | null };
type YtItem = {
  id?: string;
  title?: string;
  text?: string;
  date?: string;
  viewCount?: number;
  likes?: number;
  commentsCount?: number;
  channelName?: string;
  channelId?: string;
  duration?: string;
  thumbnailUrl?: string;
  hashtags?: string[];
  subtitles?: Subtitle[] | null;
  isMembersOnly?: boolean;
};

/** `00:14:50`、`14:50` → 秒。 */
function clockSeconds(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d+(:\d{1,2}){1,2}$/.test(v.trim())) return null;
  const s = v.trim().split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  return s > 0 ? s : null;
}

/**
 * SRT 字幕 → 一句句带时间的话。actor 给的时间不太规整（`00:00:0,000`），按宽松的写法认；
 * 自动字幕里每两句之间夹着一条空白的占位，丢掉。
 */
export function srtCues(srt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const m = /^\s*(\d+):(\d+):(\d+)(?:[,.](\d+))?\s*-->/.exec(lines[at]);
    const text = lines
      .slice(at + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (m && text) cues.push({ at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? "0"}`), text });
  }
  return cues;
}

/** 挑一条字幕（和 youtube.ts 的 pickCaptionTrack 同一个顺序）：原语言里作者上传的 → 自动生成的 → 中文 → 英文 → 第一条。 */
export function pickSubtitle(raw: unknown): { srt: string; auto: boolean } | null {
  const subs = (Array.isArray(raw) ? raw : [])
    .filter((s): s is Subtitle => !!s && typeof s === "object" && typeof (s as Subtitle).srt === "string" && (s as Subtitle).srt!.trim() !== "")
    .map((s) => ({ srt: s.srt!, auto: s.type === "auto_generated", lang: (s.language ?? "").toLowerCase().split("-")[0] }));
  const auto = subs.find((s) => s.auto);
  const manual = subs.filter((s) => !s.auto);
  const picked = (auto && manual.find((s) => s.lang === auto.lang)) ?? auto ?? manual.find((s) => s.lang === "zh") ?? manual.find((s) => s.lang === "en") ?? manual[0];
  return picked ? { srt: picked.srt, auto: picked.auto } : null;
}

/** 视频本体下没下到：下到了是 video；没下到 note 说为什么（没试过两个都是 null）。 */
export type YouTubeDownload = { video: (RemoteFile & { durationS: number | null }) | null; note: string | null };

/**
 * actor 返回的一条 → 帖子。没读到（空、不是这个视频）抛 SourceFetchError。
 * download：视频本体（另一个 actor 下的，见 downloadYouTubeViaApify）；不给 = 没有视频，只有封面和字幕。
 */
export function mapYouTubeApifyItem(item: unknown, externalId: string, download: YouTubeDownload = { video: null, note: null }): FetchedPost {
  const it = (item && typeof item === "object" ? item : {}) as YtItem;
  if (!it.id || it.id !== externalId || typeof it.title !== "string") {
    throw new SourceFetchError("YouTube 不让这台机器读这个视频，改走 Apify 也没读到。可以把视频的标题、简介贴进来直接分析");
  }
  const title = it.title.trim();
  const description = (typeof it.text === "string" ? it.text : "").trim();
  const sub = pickSubtitle(it.subtitles);
  const captions = sub ? cuesToText(srtCues(sub.srt), CAPTIONS_MAX) || null : null;
  const { video } = download;
  const via = "YouTube 不让这台机器直接读，这次是通过 Apify 读的";
  const notes = [video ? via : `${via}：${download.note ?? "没有下载视频"}，画面只看了封面`, "读不到评论内容，只有评论数"];
  if (it.isMembersOnly) notes.push("这是会员专享的视频");
  if (captions && sub?.auto) notes.push("字幕是 YouTube 自动生成的，可能有错字");
  // 有视频时说的话由后面的语音识别转写（process-item.ts 的第 ② 步），转不了那边会再记一句
  if (!captions) notes.push(video ? "没有读到字幕" : "没有读到字幕，也没有视频可以转写：视频里说了什么不知道");
  const durationS = clockSeconds(it.duration);
  const thumb = (name: string) => `https://i.ytimg.com/vi/${externalId}/${name}.jpg`;
  const covers = [...new Set([typeof it.thumbnailUrl === "string" && it.thumbnailUrl.startsWith("https://") ? it.thumbnailUrl : thumb("maxresdefault"), thumb("sddefault"), thumb("hqdefault")])];
  const tags = (Array.isArray(it.hashtags) ? it.hashtags : []).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "").trim());
  const published = Date.parse(typeof it.date === "string" ? it.date : "");
  return {
    platform: "youtube",
    externalId,
    kind: "video",
    title,
    text: Array.from(description).slice(0, TEXT_MAX).join(""),
    author: { id: typeof it.channelId === "string" && it.channelId ? it.channelId : null, name: typeof it.channelName === "string" ? it.channelName : "" },
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
    stats: { ...emptyStats(), views: toCount(it.viewCount), likes: toCount(it.likes), comments: toCount(it.commentsCount) },
    hashtags: [...new Set([...hashtagsIn(`${title}\n${description}`), ...tags])].filter(Boolean).slice(0, 15),
    topComments: [],
    images: [{ url: covers[0], backupUrls: covers.slice(1) }],
    video: video ? { ...video, durationS: video.durationS ?? durationS } : null,
    durationS,
    music: null,
    captions,
    notes,
  };
}

type DownloadRow = { resultType?: string; videoId?: string; fileUrl?: string; fileSizeBytes?: number; width?: number; height?: number; durationSeconds?: number; chargedMinutes?: number; error?: string };
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * 下视频的 actor 返回的行 → 视频地址，或者没下到的原因。
 * 原因只认 actor 的错误代码（`VIDEO_UNAVAILABLE` 这种）：它的说明文字是外面来的，不抄进 notes。
 */
export function mapYouTubeDownloadRows(rows: unknown, externalId: string, maxBytes: number): YouTubeDownload & { minutes: number } {
  const row = (Array.isArray(rows) ? rows : []).find((r): r is DownloadRow => !!r && typeof r === "object" && (r as DownloadRow).videoId === externalId);
  if (row?.resultType === "file" && typeof row.fileUrl === "string" && row.fileUrl.startsWith("https://")) {
    const durationS = posInt(row.durationSeconds);
    return {
      video: { url: row.fileUrl, width: posInt(row.width), height: posInt(row.height), bytes: posInt(row.fileSizeBytes), durationS },
      note: null,
      minutes: posInt(row.chargedMinutes) ?? (durationS ? Math.ceil(durationS / 60) : 1),
    };
  }
  const code = typeof row?.error === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(row.error) ? row.error : null;
  const note = code === "OVER_MAX_MEGABYTES" ? `视频太大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB），没有下载` : `视频没下到${code ? `（${code}）` : ""}`;
  return { video: null, note, minutes: 0 };
}

const RUNNING = new Set(["READY", "RUNNING", "TIMING-OUT", "ABORTING"]);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 把视频本体下下来：Apify 上的 actor（默认 johnvc~youtube-download-api）把视频下到这次运行自己的存储里，给一个带签名的
 * 下载地址（Apify 那边按套餐留几天；这边读完帖子马上转存，见 process-item.ts 的 storeMedia）。
 *
 * 要的是 360p 的 H.264 mp4（和直接读那条路存的一样：看得清画面上的字，iPhone 上也能播），没有 360p 时 actor 给低一档的。
 * 2026-11-25 在云端容器里实测（视频 Ia1TyVLwixc，41 分钟、没有字幕的中文口播）：4 分 30 秒下到 38 MB 的文件，
 * 那次运行 Apify 记了 $0.0004（按分钟计，$0.000011 / 分钟；没下到的不收）。这是个人开发者维护的 actor，价格和接口
 * 都可能变：用 env APIFY_YOUTUBE_DOWNLOAD_ACTOR 换一个同样输入输出的，或者设成 off 不下。
 *
 * 下载比读信息慢得多（约是视频时长的九分之一），同步端点最多等 300 秒，所以起一次运行再轮询。
 * 下不到不算失败：返回原因（note），调用方照样用字幕和封面。运行在 Apify 那边的超时按视频时长给（5–30 分钟）。
 */
export async function downloadYouTubeViaApify(externalId: string, durationS: number | null, maxBytes = videoReadMaxBytes()): Promise<YouTubeDownload> {
  const token = process.env.APIFY_TOKEN?.trim();
  const actor = DOWNLOAD_ACTOR();
  if (!token || actor.toLowerCase() === "off") return { video: null, note: null };
  const auth = { authorization: `Bearer ${token}` };
  const api = (path: string, init: RequestInit = {}) =>
    labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/${path}`, { ...init, headers: { ...auth, ...init.headers }, signal: AbortSignal.timeout(90_000) });
  const runSeconds = Math.min(1800, Math.max(300, Math.round(120 + (durationS ?? 2400) * 0.3)));
  try {
    const started = await api(`acts/${actor}/runs?timeout=${runSeconds}&waitForFinish=60`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        videoUrls: [`https://www.youtube.com/watch?v=${externalId}`],
        format: "video",
        quality: "360p",
        videoCodec: "h264",
        maxMegabytes: Math.floor(maxBytes / 1024 / 1024),
      }),
    });
    if (!started.ok) throw new Error(`apify(${actor}) ${started.status}: ${summarizeErrorText(await started.text().catch(() => ""))}`);
    type Run = { id?: string; status?: string; defaultDatasetId?: string };
    let run = ((await started.json()) as { data?: Run }).data ?? {};
    if (!run.id || !/^[A-Za-z0-9]+$/.test(run.id)) throw new Error(`apify(${actor}) 结构异常: 没有运行的 id`);
    const runId = run.id;
    const deadline = Date.now() + (runSeconds + 60) * 1000;
    while (RUNNING.has(run.status ?? "") && Date.now() < deadline) {
      const res = await api(`actor-runs/${runId}?waitForFinish=60`);
      if (!res.ok) throw new Error(`apify(${actor}) ${res.status}: ${summarizeErrorText(await res.text().catch(() => ""))}`);
      run = ((await res.json()) as { data?: Run }).data ?? {};
    }
    if (RUNNING.has(run.status ?? "")) {
      // 还在跑就不等了：停掉它，别让它接着下
      await api(`actor-runs/${runId}/abort`, { method: "POST" }).then((r) => r.body?.cancel()).catch(() => {});
      return { video: null, note: `视频下了 ${Math.round(runSeconds / 60)} 分钟还没下完，没有再等` };
    }
    if (run.status !== "SUCCEEDED" || !run.defaultDatasetId || !/^[A-Za-z0-9]+$/.test(run.defaultDatasetId)) {
      return { video: null, note: `视频没下到（Apify 的运行${run.status === "TIMED-OUT" ? "超时了" : "没跑成"}）` };
    }
    const res = await api(`datasets/${run.defaultDatasetId}/items?format=json&clean=true`);
    if (!res.ok) throw new Error(`apify(${actor}) ${res.status}: ${summarizeErrorText(await res.text().catch(() => ""))}`);
    const { minutes, ...download } = mapYouTubeDownloadRows(await res.json(), externalId, maxBytes);
    if (minutes > 0) recordCall(YOUTUBE_APIFY_DOWNLOAD_COUNT_KEY, minutes);
    return download;
  } catch (e) {
    console.error(`YouTube 视频下载失败 ${externalId}: ${messageOf(e)}`);
    return { video: null, note: `视频没下到（${messageOf(e).slice(0, 100)}）` };
  }
}

/** 视频在不在（YouTube 公开的 oEmbed 接口）。不在返回 false；问不到（网络、别的状态码）当它在。 */
async function exists(id: string): Promise<boolean> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  const res = await labeledPublicFetch("YouTube(www.youtube.com)", url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return true;
  await res.body?.cancel().catch(() => {});
  // 400 = 没有这个视频，404 = 被删了，403 = 私享
  return ![400, 403, 404].includes(res.status);
}

/**
 * 通过 Apify 读一个 YouTube 视频：一次运行读信息和字幕（记一笔 apify_youtube_video），读到了再起一次运行把视频下下来
 * （按分钟记 apify_youtube_download_minute；下不到不算失败）。调用方先确认配了 APIFY_TOKEN。
 * 网络错误原样抛（可以重试）；视频不在、actor 没读到抛 SourceFetchError。
 */
export async function fetchYouTubeViaApify(ref: LinkRef): Promise<FetchedPost> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("YouTube 不让这台机器读这个视频，后备的 Apify 没配（环境变量 APIFY_TOKEN）。可以把视频的标题、简介贴进来直接分析");
  if (!(await exists(ref.externalId))) throw new SourceFetchError(GONE);
  const actor = ACTOR();
  // 令牌放请求头，不进 URL；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      startUrls: [{ url: `https://www.youtube.com/watch?v=${ref.externalId}` }],
      maxResults: 1,
      transcriptionAndSubtitle: "ALWAYS_SUBTITLES",
      subtitlesLanguage: "any",
      subtitlesFormat: "srt",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // actor 读不到视频时不报错、一直跑到超时：重试也是再等两分钟，直接告诉用户
    if (/TIMED-OUT/.test(body)) throw new SourceFetchError("YouTube 不让这台机器读这个视频，改走 Apify 也没读到（跑到超时）。可以把视频的标题、简介贴进来直接分析");
    throw new Error(`apify(${actor}) ${res.status}: ${summarizeErrorText(body)}`);
  }
  // 按写进数据集的条数计费：返回空的不记
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  if (items.length > 0) recordCall(YOUTUBE_APIFY_COUNT_KEY);
  // 先确认读到的就是这个视频（不是就抛），再去下视频
  const post = mapYouTubeApifyItem(items[0], ref.externalId);
  const download = await downloadYouTubeViaApify(ref.externalId, post.durationS ?? null);
  return download.video || download.note ? mapYouTubeApifyItem(items[0], ref.externalId, download) : post;
}
