import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import { douyinUrl, type LinkRef } from "./link";
import { SourceFetchError, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条抖音作品（视频或图文）：走 Apify 上的第三方 actor（按条计费，BRONZE 档每次运行 $0.005 + 每条 $0.005）。
 *
 * 为什么不直接读：抖音的分享页（iesdouyin.com/share/video/<id>、/share/note/<id>）是纯前端渲染，作品信息要带 a_bogus
 * 签名的接口才给，海外网络打开还会提示「请在抖音内观看」（2026-10-05、2026-11-19 实测）。
 *
 * 用的是 zen-studio~douyin-video-scraper，输入 `{ videoUrls: [...] }`，同步端点约 10 秒返回。2026-11-19 从
 * natanielsantos~douyin-scraper 换过来：那个按链接读不了图文（`type: "imageText"`），一律返回「Couldn't get video data」，
 * 页面上就成了「可能被删了」。这个视频、图文都读，作品不存在时返回空数组。
 * 第三方 actor 可能改名 / 下架，用 env APIFY_DOUYIN_ACTOR 换（输入、输出形状要和这个一样），不用改代码。
 *
 * 拿得到：文案、作者、发布时间、点赞 / 评论 / 收藏 / 转发数、话题、背景音乐、封面；视频的播放地址，图文的每一张图
 * （地址都带时效，要马上转存）。
 * 拿不到：评论内容（分析时只能看互动数）、播放数；长文案会被平台截断（末尾带「版本过低，升级后可展示全部信息」）。
 */

const ACTOR = () => process.env.APIFY_DOUYIN_ACTOR?.trim() || "zen-studio~douyin-video-scraper";
export const DOUYIN_COUNT_KEY = "apify_douyin_post";
const GONE = "这个抖音作品读不到：可能被删了、设成了私密，或者链接不对。在抖音里重新点「分享 → 复制链接」再贴一次";

type Img = { url?: string; width?: number; height?: number };
type DouyinItem = {
  id?: string;
  /** "video" | "imageText"（图文） */
  type?: string;
  text?: string;
  createTime?: number;
  authorMeta?: { id?: string; secUid?: string; name?: string };
  musicMeta?: { title?: string; author?: string; isOriginal?: boolean };
  videoMeta?: {
    duration?: number;
    width?: number;
    height?: number;
    playUrl?: string | null;
    playUrlH264?: string | null;
    downloadUrl?: string | null;
    cover?: string | null;
    originCover?: string | null;
    dynamicCover?: string | null;
  };
  coverUrl?: string | null;
  images?: Img[] | null;
  statistics?: { diggCount?: number; shareCount?: number; commentCount?: number; collectCount?: number };
  hashtags?: { name?: string }[];
  authorDeclaration?: string | null;
};

const count = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
const dim = (n: unknown): number | null => (typeof n === "number" && n > 0 ? Math.round(n) : null);
const isUrl = (u: unknown): u is string => typeof u === "string" && u.startsWith("http");
const TRUNCATED = /…*版本过低，升级后可展示全部信息$/;

/** actor 返回的一条 → 帖子。没有这一条（作品不存在 / 私密时 actor 返回空数组）或形状不对抛 SourceFetchError。 */
export function mapDouyinItem(item: unknown, externalId: string): FetchedPost {
  const it = (item && typeof item === "object" ? item : {}) as DouyinItem;
  if (!it.id) throw new SourceFetchError(GONE);
  const raw = (it.text ?? "").trim();
  const truncated = TRUNCATED.test(raw);
  const text = raw.replace(TRUNCATED, "…");
  const v = it.videoMeta ?? {};
  const isImages = it.type === "imageText";
  const notes: string[] = [];
  if (truncated) notes.push("文案被平台截断了，只读到前面一部分");
  notes.push("这条路读不到评论内容，只有评论数");
  if (it.authorDeclaration?.trim()) notes.push(`作者声明：${it.authorDeclaration.trim()}`);

  let images: RemoteFile[];
  let video: FetchedPost["video"] = null;
  if (isImages) {
    // 图文：每一张图都要（背景音乐的地址 actor 也放在 videoUrl / playUrl 里，不当视频）
    images = (it.images ?? []).filter((g): g is Img & { url: string } => isUrl(g?.url)).map((g) => ({ url: g.url, width: dim(g.width), height: dim(g.height) }));
    if (images.length === 0) notes.push("这是一条图文，但没有拿到图片");
  } else {
    // 视频：封面候选按顺序试到一个能下的为止
    const covers = [...new Set([v.originCover, it.coverUrl, v.cover, v.dynamicCover].filter(isUrl))];
    images = covers.length > 0 ? [{ url: covers[0], backupUrls: covers.slice(1), width: null, height: null }] : [];
    const plays = [...new Set([v.playUrl, v.playUrlH264, v.downloadUrl].filter(isUrl))];
    const durationS = typeof v.duration === "number" && v.duration > 0 ? Math.round(v.duration / 100) / 10 : null;
    if (plays.length > 0) video = { url: plays[0], backupUrls: plays.slice(1), width: count(v.width), height: count(v.height), bytes: null, durationS };
    else notes.push("没有拿到视频地址，只读到了封面");
  }

  const m = it.musicMeta;
  const music = m?.title ? `${m.title}${m.isOriginal ? "（原声）" : m.author ? ` — ${m.author}` : ""}` : null;
  // 抖音没有单独的标题：文案第一行（去掉话题）当标题
  const firstLine = text.split("\n")[0].replace(/#\S+/g, "").trim();
  const id = String(it.id || externalId);
  return {
    platform: "douyin",
    externalId: id,
    url: douyinUrl(id, isImages ? "image" : "video"),
    kind: isImages ? "image" : "video",
    title: Array.from(firstLine).slice(0, 60).join(""),
    text,
    author: { id: it.authorMeta?.secUid || it.authorMeta?.id || null, name: it.authorMeta?.name ?? "" },
    publishedAt: typeof it.createTime === "number" && it.createTime > 0 ? new Date(it.createTime * 1000).toISOString() : null,
    stats: { views: null, likes: count(it.statistics?.diggCount), collects: count(it.statistics?.collectCount), comments: count(it.statistics?.commentCount), shares: count(it.statistics?.shareCount) },
    hashtags: (it.hashtags ?? []).map((h) => (h?.name ?? "").trim()).filter(Boolean),
    topComments: [],
    images,
    video,
    music,
    notes,
  };
}

/** 读一条抖音作品（一次 Apify 运行，记一笔 apify_douyin_post）。没配 APIFY_TOKEN 抛 SourceFetchError。 */
export async function fetchDouyinVideo(ref: LinkRef): Promise<FetchedPost> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("读抖音要用 Apify（环境变量 APIFY_TOKEN 没配）。可以先把文案贴进来直接分析");
  const actor = ACTOR();
  // 令牌放请求头，不进 URL（报错信息、日志里不会带出来）；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ videoUrls: [ref.url] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  // 跑成功就计费（哪怕返回的是空的）
  recordCall(DOUYIN_COUNT_KEY);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  return mapDouyinItem(items[0], ref.externalId);
}
