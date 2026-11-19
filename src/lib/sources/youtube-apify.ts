import { labeledFetch } from "@/lib/fetch-error";
import { labeledPublicFetch } from "@/lib/network/labeled-public-fetch";
import { summarizeErrorText } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import { cuesToText, type Cue } from "@/lib/media/transcript";
import type { LinkRef } from "./link";
import { GONE } from "./youtube";
import { SourceFetchError, emptyStats, hashtagsIn, toCount, type FetchedPost } from "./types";

/**
 * YouTube 的后备：播放接口不给这台机器读时（云服务器的机房 IP 一律被要求登录验证），走 Apify 上的 actor。
 *
 * actor 是 Apify 自己维护的 streamers~youtube-scraper（Store 里用量最大的 YouTube 采集器，FREE 档 $0.004 / 条）。
 * 输入 `{ startUrls: [{ url }], maxResults: 1, transcriptionAndSubtitle: "ALWAYS_SUBTITLES", subtitlesLanguage: "any",
 * subtitlesFormat: "srt" }`，同步端点约 8–30 秒返回（2026-11-19 在云端容器里实测）。和抖音那条路一样：actor 可能改版，
 * 用 env APIFY_YOUTUBE_ACTOR 换，不用改代码。
 *
 * 拿得到：标题、简介、作者、发布时间、观看 / 点赞 / 评论数、话题、时长、封面、字幕（作者上传的或自动生成的）。
 * 拿不到：视频本体（所以没有画面，只看封面）、评论内容。
 * 只要字幕、不让它转写：actor 的语音转写按分钟另收费（$0.048 / 分钟），没有字幕的视频就是没有口播文字。
 *
 * 视频不存在时 actor 不报错，而是一直跑到超时（实测 150 秒）。所以先用 YouTube 公开的 oEmbed 接口问一下视频在不在，
 * 不在就不跑了。
 */

const ACTOR = () => process.env.APIFY_YOUTUBE_ACTOR?.trim() || "streamers~youtube-scraper";
export const YOUTUBE_APIFY_COUNT_KEY = "apify_youtube_video";
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

/** actor 返回的一条 → 帖子。没读到（空、不是这个视频）抛 SourceFetchError。 */
export function mapYouTubeApifyItem(item: unknown, externalId: string): FetchedPost {
  const it = (item && typeof item === "object" ? item : {}) as YtItem;
  if (!it.id || it.id !== externalId || typeof it.title !== "string") {
    throw new SourceFetchError("YouTube 不让这台机器读这个视频，改走 Apify 也没读到。可以把视频的标题、简介贴进来直接分析");
  }
  const title = it.title.trim();
  const description = (typeof it.text === "string" ? it.text : "").trim();
  const sub = pickSubtitle(it.subtitles);
  const captions = sub ? cuesToText(srtCues(sub.srt), CAPTIONS_MAX) || null : null;
  const notes = ["YouTube 不让这台机器直接读，这次是通过 Apify 读的：没有下载视频，画面只看了封面", "读不到评论内容，只有评论数"];
  if (it.isMembersOnly) notes.push("这是会员专享的视频");
  if (captions && sub?.auto) notes.push("字幕是 YouTube 自动生成的，可能有错字");
  if (!captions) notes.push("没有读到字幕，也没有视频可以转写：视频里说了什么不知道");
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
    video: null,
    durationS: clockSeconds(it.duration),
    music: null,
    captions,
    notes,
  };
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
 * 通过 Apify 读一个 YouTube 视频（一次运行，记一笔 apify_youtube_video）。调用方先确认配了 APIFY_TOKEN。
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
  return mapYouTubeApifyItem(items[0], ref.externalId);
}
