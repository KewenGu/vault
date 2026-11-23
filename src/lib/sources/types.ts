/**
 * 链接来源：把分享链接读成一条帖子。认小红书、抖音、TikTok、Instagram、YouTube、X、Reddit；其余链接一律按「网页」读
 * （博文、新闻、商品页，本机装了 yt-dlp 时还有别的视频站）。
 * 这里是各层共用的形状：抓到的帖子（FetchedPost）、存进库里的快照（PostSnapshot）、转存的文件（ItemMedia）。
 * 读取器（xhs.ts、douyin.ts…）最初来自 SM-Intelligence 的收藏夹，那边修了平台改版的问题要同步过来。
 */

import { readCapture, type PageCapture } from "@/lib/vault/page-capture";

export const SOURCE_PLATFORMS = ["xiaohongshu", "douyin", "tiktok", "instagram", "youtube", "x", "reddit", "web"] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];
export const SOURCE_PLATFORM_LABEL: Record<SourcePlatform, string> = {
  xiaohongshu: "小红书",
  douyin: "抖音",
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
  reddit: "Reddit",
  web: "网页",
};

/** image 图文 / 配图帖 / 截图，video 视频，audio 音频（只有上传的有），text 只有文字，article 网页上的文章 */
export const POST_KINDS = ["image", "video", "audio", "text", "article"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const POST_KIND_LABEL: Record<PostKind, string> = { image: "图文", video: "视频", audio: "音频", text: "文字", article: "文章" };

/** 还没读到标题时（读取中、读取失败、帖子本来就没字）页面上叫它什么：「小红书帖子」「YouTube 视频」「网页」。 */
export function fallbackTitle(platform: SourcePlatform, kind: PostKind | null): string {
  const label = SOURCE_PLATFORM_LABEL[platform];
  const what = kind && kind !== "text" ? POST_KIND_LABEL[kind] : platform === "web" ? "" : platform === "youtube" ? "视频" : "帖子";
  if (platform === "web") return what || label;
  // 英文的平台名和后面的中文之间留一个空格
  return `${label}${/[a-z]$/i.test(label) ? " " : ""}${what}`;
}


/** 互动数：平台没给的是 null（不是 0）。views = 播放 / 浏览量（小红书、抖音这条路不给）。 */
export type PostStats = { views: number | null; likes: number | null; collects: number | null; comments: number | null; shares: number | null };
export const POST_STAT_KEYS = ["views", "likes", "collects", "comments", "shares"] as const;
export type PostStatKey = (typeof POST_STAT_KEYS)[number];

/** 互动数在各平台叫什么（页面上、提示词里用同一套）：X 的收藏是书签、评论是回复；视频是播放，帖子和网页是浏览。 */
export function statLabel(platform: SourcePlatform, key: PostStatKey): string {
  if (key === "views") return platform === "x" || platform === "web" ? "浏览" : platform === "youtube" ? "观看" : "播放";
  if (key === "likes") return "点赞";
  if (key === "collects") return platform === "x" ? "书签" : "收藏";
  if (key === "comments") return platform === "x" ? "回复" : "评论";
  return "转发";
}

/**
 * 平台 CDN 上的一个文件（地址带时效签名，要马上转存）。
 * headers：下载时要带的请求头（TikTok 的视频要页面发的 cookie + referer）；只发给和 url 同一个站的地址，跳去别的站就不带了。
 */
export type RemoteFile = {
  url: string;
  backupUrls?: string[];
  headers?: Record<string, string>;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  /** bytes 是估算的（码率 × 时长），不是平台报的真实大小：用来挑清晰度可以，不能凭它不下载 */
  bytesEstimated?: boolean;
};

/** 从平台读到的一条帖子（还没转存文件）。 */
export type FetchedPost = {
  platform: SourcePlatform;
  externalId: string;
  /** 读完才知道的规范链接（抖音：链接看不出是视频还是图文，读到了才知道），和存的不一样时换掉；没有就不动 */
  url?: string;
  kind: PostKind;
  title: string;
  text: string;
  author: { id: string | null; name: string };
  publishedAt: string | null;
  stats: PostStats;
  hashtags: string[];
  /** 高赞评论（平台给了才有；抖音这条路拿不到） */
  topComments: { text: string; likes: number | null }[];
  /** 图文的每一张图；视频是封面（可能有几个候选地址，按顺序试）；文章是题图和配图 */
  images: RemoteFile[];
  /**
   * via = "ytdlp"：没有能直接下的地址，url 是视频页面，要用本机的 yt-dlp 下（见 ytdlp.ts）。
   * audio：声音在另一个文件里（Reddit：画面和声音分开放），下载之后要合进视频（见 lib/media/mux.ts）
   */
  video: (RemoteFile & { durationS: number | null; via?: "ytdlp"; audio?: RemoteFile }) | null;
  /** 没拿到视频本体、但知道时长时填（YouTube 走 Apify 那条路）；有 video 时以 video.durationS 为准 */
  durationS?: number | null;
  /** 背景音乐（抖音、TikTok、Instagram） */
  music: string | null;
  /** 平台自带的字幕（YouTube）：有它就不用再做语音识别 */
  captions?: string | null;
  /** 读的时候发现的情况，分析时要知道（如「正文做成了图片」「文案被平台截断」） */
  notes: string[];
};

/** 存进 items.post 的快照：帖子本身的信息，不含文件地址（文件在 media 里）。 */
export type PostSnapshot = Pick<FetchedPost, "text" | "publishedAt" | "stats" | "hashtags" | "topComments" | "music" | "notes"> & {
  authorId: string | null;
  durationS: number | null;
  /** 抽帧 / 转写这一步留下的情况（「没有转写口播：…」）；和读取时的 notes 分开存，重新分析时整个换掉 */
  digestNotes: string[];
  /** items.transcript 是哪来的：captions = 平台自带的字幕（重新分析时留着，不再做语音识别），asr = 语音识别 */
  transcriptFrom: "captions" | "asr" | null;
  /** 画面切换的时间点（秒，0.1 秒精度，按时间排；抽帧时 ffmpeg 测的）。没测 / 一刀没切是空 */
  cuts: number[];
  /**
   * 网页是在手机的 Safari 里读的（服务器读不到，见 lib/vault/page-capture.ts）：读取这一步用它，不去抓网页。
   * 一直留着，重新读取时还用这一份。
   */
  capture?: PageCapture;
};

/** 读取 + 抽帧转写两步留下的所有情况（页面上列出来，也告诉模型）。 */
export const postNotes = (post: Pick<PostSnapshot, "notes" | "digestNotes">): string[] => [...post.notes, ...post.digestNotes];

/**
 * 转存到存储桶的一个文件（items.media 数组的一项）：
 * image = 图文的图 / 视频封面 / 上传的图片和截图，video = 视频本体，audio = 上传的音频，
 * frame = 从视频里抽的帧（at 是第几秒，给模型看、页面上也展示），
 * sheet = 帧格（几帧拼成一张，每格下面标时间和那一刻说的话；给模型一眼看全片，页面上也能看）。
 */
export type ItemMedia = {
  role: "image" | "video" | "audio" | "frame" | "sheet";
  path: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  durationS?: number | null;
  /** video：存的不是原片，是压到存档上限以内的副本（原片太大；读内容用的是原片）。2026-11-19 起不再压副本，只有那之前存的内容有 */
  compressed?: boolean;
  /** video：原片不在存储桶里，在这台服务器的磁盘上（超过存档上限；见 lib/media/local-store.ts）。path 是同样的相对路径 */
  local?: boolean;
  /** frame：这一帧的时间；sheet：这张帧格从哪一秒开始 */
  at?: number;
  /** sheet：这张帧格到哪一秒（全片一览，2026-10-13 起有） */
  to?: number;
  /** sheet：这张帧格里有几格（2026-11-20 起有；页面上数的是格数，不是帧格的张数） */
  tiles?: number;
  /** frame：这一帧是不是一个新镜头的开头（切点后面 0.3 秒内） */
  cut?: boolean;
  /** frame：那一刻正在说的话（speechLabel 的写法：【】里是正说到的词，｜是停顿）；没有口播是空 */
  words?: string | null;
};

/** 帖子读不到（链接失效、被删、风控、没配令牌）：重试也没用，message 直接给用户看。 */
export class SourceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFetchError";
  }
}

/** 互动数的显示：过万写成「1.2万」、过亿写成「4.4亿」，平台没给的是「—」。 */
export function formatCount(n: number | null): string {
  if (n === null) return "—";
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(n >= 1_000_000_000 ? 0 : 1).replace(/\.0$/, "")}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}万`;
  return n.toLocaleString("en-US");
}

export function emptyStats(): PostStats {
  return { views: null, likes: null, collects: null, comments: null, shares: null };
}

/** 平台给的数字（可能是字符串）→ 非负整数；没给、认不出、负数（Instagram 隐藏点赞时给 -1）是 null。 */
export function toCount(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** 没有标题的平台（抖音、TikTok、X、Instagram）：文案第一行去掉话题当标题，最多 60 个字。 */
export function titleFromText(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/#[^\s#]+/g, "").replace(/https?:\/\/\S+/g, "").trim())
      .find(Boolean) ?? "";
  return Array.from(line).slice(0, 60).join("");
}

/** 正文里的 #话题（去重，按出现顺序）。 */
export function hashtagsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,60})/gu)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** 库里读出来的 jsonb 是 unknown：按形状收一遍，坏数据给空值，页面不至于崩。 */
export function readPost(raw: unknown): PostSnapshot {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<PostSnapshot>;
  const s = (o.stats && typeof o.stats === "object" ? o.stats : {}) as Partial<PostStats>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const capture = o.capture ? readCapture(o.capture) : null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []);
  return {
    text: typeof o.text === "string" ? o.text : "",
    publishedAt: typeof o.publishedAt === "string" ? o.publishedAt : null,
    stats: { views: num(s.views), likes: num(s.likes), collects: num(s.collects), comments: num(s.comments), shares: num(s.shares) },
    hashtags: strings(o.hashtags),
    topComments: Array.isArray(o.topComments)
      ? o.topComments.filter((c) => c && typeof c.text === "string").map((c) => ({ text: c.text, likes: num(c.likes) }))
      : [],
    music: typeof o.music === "string" ? o.music : null,
    notes: strings(o.notes),
    authorId: typeof o.authorId === "string" ? o.authorId : null,
    durationS: num(o.durationS),
    digestNotes: strings(o.digestNotes),
    transcriptFrom: o.transcriptFrom === "captions" || o.transcriptFrom === "asr" ? o.transcriptFrom : null,
    cuts: Array.isArray(o.cuts) ? o.cuts.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0) : [],
    ...(capture ? { capture } : {}),
  };
}

export function readMedia(raw: unknown): ItemMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is ItemMedia => !!m && typeof m === "object" && typeof (m as ItemMedia).path === "string" && ["image", "video", "audio", "frame", "sheet"].includes((m as ItemMedia).role)
  );
}
