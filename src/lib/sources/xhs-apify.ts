import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import type { LinkRef } from "./link";
import { SourceFetchError, emptyStats, toCount, type FetchedPost, type RemoteFile } from "./types";
import { cleanDesc } from "./xhs";

/**
 * 小红书的后备：链接里没有访问口令（xsec_token）、或者口令过期了，直接读分享页读不到时（见 xhs.ts），走 Apify 上的 actor。
 * 存一个博主的全部笔记靠的就是它：列出来的笔记只有 id，没有口令。
 *
 * actor 是 socialdatax~socialdatax-xhs-data-api（Store 里用量最大的小红书采集器，每条结果 $0.005），
 * 输入 `{ operation: "get_note_detail", note_id }`，同步端点约 5 秒返回（2026-11-26 在云端容器里实测：视频、10 张图的图文
 * 各读了一篇；不存在的 id 返回空数组，那次运行几乎不收钱）。和抖音那条路一样：actor 可能改版，用 env APIFY_XHS_ACTOR 换
 * （输入、输出形状要和这个一样），不用改代码。同一个 actor 也用来列一个账号的笔记（account-apify.ts，那边用 APIFY_XHS_PROFILE_ACTOR 换）。
 *
 * 拿得到：标题、正文、作者、发布时间、点赞 / 收藏 / 评论 / 转发数、话题、每一张图、视频地址（地址带时效，要马上转存）。
 * 拿不到：评论内容（直接读分享页能拿到首屏的几条高赞评论）；视频只给一路码流（实测是 720p）。
 */

export const XHS_ACTOR = () => process.env.APIFY_XHS_ACTOR?.trim() || "socialdatax~socialdatax-xhs-data-api";
export const XHS_APIFY_COUNT_KEY = "apify_xhs_note";
const GONE = "这篇小红书笔记读不到：可能被删了、设成了私密，或者链接不对";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const dim = (v: unknown): number | null => (typeof v === "number" && v > 0 ? Math.round(v) : null);
const isUrl = (u: unknown): u is string => typeof u === "string" && u.startsWith("http");

/** actor 返回的一条 → 帖子。没有这一条（笔记不存在 / 私密时 actor 返回空数组）或形状不对抛 SourceFetchError。 */
export function mapXhsDetail(item: unknown, externalId: string): FetchedPost {
  const it = obj(item);
  const id = str(it.note_id).toLowerCase();
  if (!id || id !== externalId.toLowerCase()) throw new SourceFetchError(GONE);
  const isVideo = str(it.note_type) === "video";
  const notes: string[] = ["这条路读不到评论内容，只有评论数"];
  if (str(it.content_statement).trim()) notes.push(`作者声明：${str(it.content_statement).trim()}`);

  const gallery: RemoteFile[] = arr(it.image_items)
    .map((g) => obj(g))
    .filter((g) => isUrl(g.image_url))
    .map((g) => ({ url: str(g.image_url), width: dim(g.width), height: dim(g.height) }));
  // 视频：只要封面（image_items 里就是那一张）
  const cover = isUrl(it.cover_image_url) ? [{ url: it.cover_image_url, width: null, height: null }] : [];
  const images = isVideo ? (gallery.length > 0 ? gallery.slice(0, 1) : cover) : gallery.length > 0 ? gallery : cover;
  if (!isVideo && gallery.length === 0) notes.push("这是一篇图文，但没有拿到图片");

  let video: FetchedPost["video"] = null;
  if (isVideo) {
    const ms = typeof it.video_duration_ms === "number" && it.video_duration_ms > 0 ? it.video_duration_ms : null;
    if (isUrl(it.video_video_url)) video = { url: it.video_video_url, width: dim(it.video_width), height: dim(it.video_height), bytes: null, durationS: ms ? Math.round(ms / 100) / 10 : null };
    else notes.push("没有拿到视频地址，只读到了封面");
  }
  const published = typeof it.publish_time === "number" && it.publish_time > 0 ? new Date(it.publish_time * 1000).toISOString() : null;
  return {
    platform: "xiaohongshu",
    externalId: id,
    kind: isVideo ? "video" : "image",
    title: str(it.title).trim(),
    text: cleanDesc(str(it.content)),
    author: { id: str(it.author_user_id) || null, name: str(it.author_name) },
    publishedAt: published,
    stats: { ...emptyStats(), likes: toCount(it.like_count), collects: toCount(it.collect_count), comments: toCount(it.comment_count), shares: toCount(it.share_count) },
    hashtags: arr(it.topic_tags)
      .map((t) => str(obj(t).name).trim())
      .filter(Boolean),
    topComments: [],
    images,
    video,
    music: null,
    notes,
  };
}

/** 能不能走这条路（配了 APIFY_TOKEN）。 */
export const canReadXhsViaApify = () => !!process.env.APIFY_TOKEN?.trim();

/** 按笔记 id 读一篇（一次 Apify 运行，读到了记一笔 apify_xhs_note）。没配 APIFY_TOKEN 抛 SourceFetchError。 */
export async function fetchXhsViaApify(ref: Pick<LinkRef, "externalId">): Promise<FetchedPost> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("不带访问口令读小红书要用 Apify（环境变量 APIFY_TOKEN 没配）");
  const actor = XHS_ACTOR();
  // 令牌放请求头，不进 URL；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation: "get_note_detail", note_id: ref.externalId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  // 按结果计费：读到了才收（空的那次运行实测只收 $0.00005，不记）
  recordCall(XHS_APIFY_COUNT_KEY, items.length);
  return mapXhsDetail(items[0], ref.externalId);
}
