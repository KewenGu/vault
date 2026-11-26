import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { recordCall } from "@/lib/usage/meter";
import type { Followed, Mention } from "./follow";
import { parseLink, platformOfHost, type LinkRef } from "./link";
import { SourceFetchError, emptyStats, toCount, type FetchedPost, type PostLink, type RemoteFile } from "./types";

/**
 * 微博：读一条微博，走 Apify 上的 actor。
 *
 * 为什么不直接读：微博的网页和接口现在都要登录（2026-11-26 在云端容器里实测：m.weibo.cn 的接口回 `ok: -100`，
 * 页面跳去访客验证），按网页读只会拿到登录页。
 *
 * actor 是 socialdatax~socialdatax-weibo-data-api（每条结果约 $0.005；和小红书、B 站那两个是同一家），
 * 输入 `{ operation: "get_post_detail", post_id: <数字 id> }`，同步端点 3–8 秒返回（2026-11-26 实测：纯文字带文章卡片的、
 * 3 张图的、带视频的、833 字的长微博各读了一条；不存在的 id 那次运行直接失败）。actor 可能改版，用 env APIFY_WEIBO_ACTOR 换（输入、输出形状要和这个一样）。
 * 同一个 actor 也用来列一个账号的微博（account-apify.ts，那边用 APIFY_WEIBO_PROFILE_ACTOR 换）。
 *
 * 拿得到：全文、作者、发布时间、点赞 / 评论 / 转发数、视频的播放量、话题、每一张图、视频地址（720p 的 mp4，带时效，要马上转存）。
 * 图片（sinaimg.cn）下载时要带 `Referer: https://weibo.com/`，不带回 403（实测）。
 * 微博带的文章（头条文章）、外链：actor 只给地址，文章按网页跟着读进来（实测手机版的文章页不登录读得到全文），和 X、Reddit 帖子里的链接一样。
 * 拿不到：评论内容；转发别人的微博时被转发的原文（没测过 actor 怎么给）；一条里有几个视频、实况图的也没测过。
 * 超话、地点、投票这些卡片不管。
 */

export const WEIBO_ACTOR = () => process.env.APIFY_WEIBO_ACTOR?.trim() || "socialdatax~socialdatax-weibo-data-api";
export const WEIBO_COUNT_KEY = "apify_weibo_post";
/** 下载微博的图片、视频时要带的请求头 */
export const WEIBO_MEDIA_HEADERS = { referer: "https://weibo.com/" };
const GONE = "这条微博读不到：可能被删了、设成了仅自己或仅粉丝可见，或者链接不对";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const dim = (v: unknown): number | null => (typeof v === "number" && v > 0 ? Math.round(v) : null);
const isUrl = (u: unknown): u is string => typeof u === "string" && u.startsWith("https://");

/** 正文理顺：微博在末尾补的零宽空格去掉，行尾的空白去掉。 */
export function cleanWeiboText(text: string): string {
  return text
    .replace(/[​‌‍﻿]/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/**
 * 微博没有标题：媒体号习惯在开头写「【标题】」，有就用它；没有用第一行。话题是成对的井号（`#话题#`），留着字、去掉井号；
 * 短链（t.cn）去掉。最多 max 个字。
 */
export function weiboTitle(text: string, max = 60): string {
  const line =
    cleanWeiboText(text)
      .split("\n")
      .map((l) =>
        l
          .replace(/#([^#\n]{1,60})#/g, "$1")
          .replace(/https?:\/\/\S+/g, "")
          .trim(),
      )
      .find(Boolean) ?? "";
  const headline = /^【([^】]{4,})】/.exec(line)?.[1].trim();
  return Array.from(headline || line)
    .slice(0, max)
    .join("");
}

/** 话题：actor 给了就用它的；没给从正文里找成对的井号。 */
function topics(it: Obj, text: string): string[] {
  const given = arr(it.topic_tags)
    .map((t) => str(obj(t).name).trim())
    .filter(Boolean);
  const found = given.length > 0 ? given : [...text.matchAll(/#([^#\n]{1,60})#/g)].map((m) => m[1].trim()).filter(Boolean);
  return [...new Set(found)].slice(0, 15);
}

/** 卡片指向的地址：去掉微博加的来源参数（luicode、lfid、launchid…）。 */
function cardUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    for (const key of ["luicode", "lfid", "launchid", "featurecode", "extparam"]) u.searchParams.delete(key);
    return u.href;
  } catch {
    return null;
  }
}

/**
 * 卡片指向的是不是该跟着读的东西：微博的文章，或者别的网站。文章换成手机版的地址读（不登录读得到全文，页面上没有导航那些字）。
 * 微博自己的别的页面（超话、地点、投票…）不读。
 */
function cardMention(url: string): Mention | null {
  const u = new URL(url);
  const article = /(^|\.)weibo\.com$/i.test(u.hostname) && u.pathname === "/ttarticle/p/show" ? u.searchParams.get("id") : (/^card\.weibo\.com$/i.test(u.hostname) ? /^\/article\/m\/show\/id\/(\d+)/.exec(u.pathname)?.[1] : null);
  if (article && /^\d{10,30}$/.test(article)) {
    const read = `https://card.weibo.com/article/m/show/id/${article}`;
    return { how: "link", url: read, ref: parseLink(read) };
  }
  return platformOfHost(u.hostname) === "weibo" ? null : { how: "link", url, ref: parseLink(url) };
}

/** actor 返回的一条 → 帖子。没有这一条（不存在 / 看不到时 actor 返回空数组）或形状不对抛 SourceFetchError。 */
export function mapWeiboDetail(item: unknown, ref: Pick<LinkRef, "externalId">): FetchedPost {
  return mapWeibo(item, ref).post;
}

/** 同上，连同它带的文章 / 外链（跟着读用）。 */
export function mapWeibo(item: unknown, ref: Pick<LinkRef, "externalId">): Followed {
  const it = obj(item);
  const id = str(it.post_id);
  if (!id || id !== ref.externalId) throw new SourceFetchError(GONE);
  const notes: string[] = ["读不到评论内容，只有评论数"];
  let text = cleanWeiboText(str(it.content));

  // 微博带的卡片：视频、文章 / 外链、话题页。视频的卡片标题（「某某的微博视频」）actor 接在正文末尾，拿掉；
  // 文章的卡片标题给的是作者名，接在正文末尾的是文章的标题（分不出来，留着）
  const cardTitle = str(it.video_title).trim();
  const page = str(it.video_video_page_url);
  const hasVideoId = !!str(it.video_video_id) || /^https:\/\/video\.weibo\.com\//.test(page);
  const isTopicCard = /^#.*#$/.test(cardTitle) || /^https:\/\/m\.weibo\.cn\/search\b/.test(page);
  if (cardTitle && !isTopicCard && text.endsWith(cardTitle)) text = text.slice(0, -cardTitle.length).trimEnd();

  let video: FetchedPost["video"] = null;
  const links: PostLink[] = [];
  const mentions: Mention[] = [];
  if (hasVideoId) {
    const ms = typeof it.video_duration_ms === "number" && it.video_duration_ms > 0 ? it.video_duration_ms : null;
    if (isUrl(it.video_video_url)) video = { url: it.video_video_url, width: dim(it.video_width), height: dim(it.video_height), bytes: null, durationS: ms ? Math.round(ms / 100) / 10 : null, headers: WEIBO_MEDIA_HEADERS };
    else notes.push("没有拿到视频地址，只读到了封面和文字：画面和里面说的话都没读到");
  } else if (page && !isTopicCard) {
    const url = cardUrl(page);
    const mention = url ? cardMention(url) : null;
    if (url && mention) {
      links.push({ text: cardTitle === str(it.author_name).trim() ? "" : cardTitle, url });
      mentions.push(mention);
    }
  }

  const gallery: RemoteFile[] = arr(it.images)
    .map((g) => obj(g))
    .filter((g) => isUrl(g.url))
    .map((g) => ({ url: str(g.url), width: dim(g.width), height: dim(g.height), headers: WEIBO_MEDIA_HEADERS }));
  const plain: RemoteFile[] = gallery.length > 0 ? [] : arr(it.image_urls).filter(isUrl).map((url) => ({ url, width: null, height: null, headers: WEIBO_MEDIA_HEADERS }));
  const cover: RemoteFile[] = isUrl(it.video_cover_image_url) ? [{ url: it.video_cover_image_url, width: null, height: null, headers: WEIBO_MEDIA_HEADERS }] : [];
  // 视频：只要封面；配图的：每一张；只有文字的：没有图（文章卡片的题图不算这条微博的图）
  const pictures = gallery.length > 0 ? gallery : plain;
  const images = hasVideoId ? (cover.length > 0 ? cover : pictures.slice(0, 1)) : pictures;

  const published = typeof it.publish_time === "number" && it.publish_time > 0 ? new Date(it.publish_time * 1000).toISOString() : null;
  if (!text && images.length === 0 && !video) throw new SourceFetchError(GONE);
  const post: FetchedPost = {
    platform: "weibo",
    externalId: id,
    kind: hasVideoId ? "video" : images.length > 0 ? "image" : "text",
    title: weiboTitle(text),
    text: Array.from(text).slice(0, 30_000).join(""),
    author: { id: str(it.author_user_id) || null, name: str(it.author_name).trim() },
    publishedAt: published,
    stats: { ...emptyStats(), views: hasVideoId ? toCount(it.play_count) : null, likes: toCount(it.like_count), comments: toCount(it.comment_count), shares: toCount(it.repost_count) },
    hashtags: topics(it, text),
    topComments: [],
    images,
    video,
    music: null,
    ...(links.length > 0 ? { links } : {}),
    notes,
  };
  return { post, mentions };
}

/** 能不能读微博（配了 APIFY_TOKEN）。 */
export const canReadWeibo = () => !!process.env.APIFY_TOKEN?.trim();

/**
 * 按数字 id 读一条微博（一次 Apify 运行，读到了记一笔 apify_weibo_post），连同它带的文章 / 外链（还没读，fetch-post.ts 接着读）。
 * 没配 APIFY_TOKEN 抛 SourceFetchError。
 */
export async function readWeiboPost(ref: Pick<LinkRef, "externalId">): Promise<Followed> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError("读微博要用 Apify（环境变量 APIFY_TOKEN 没配）：微博的网页要登录才能看，直接读不到");
  const actor = WEIBO_ACTOR();
  // 令牌放请求头，不进 URL；timeout=110 是 Apify 那边的运行超时（秒），略小于这边的 120 秒
  const res = await labeledFetch("Apify(api.apify.com)", `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=110`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation: "get_post_detail", post_id: ref.externalId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 400) {
    // 微博不存在时 actor 那次运行直接失败（2026-11-26 实测），同步端点回 400「Actor run did not succeed … status: FAILED」。
    // 分不出是微博不在了还是 actor 临时出错：都说出来，不自动重试（用户可以点「重试」）
    const body = await res.text().catch(() => "");
    if (/run did not succeed|status: FAILED/i.test(body)) throw new SourceFetchError(`${GONE}（读它的那次 Apify 运行失败了：微博不存在时会这样，也可能是那边临时出错，过一会儿可以再试）`);
    throw new Error(`apify(${actor}) 400: ${body.slice(0, 200) || "无响应正文"}`);
  }
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error(`apify(${actor}) 结构异常: 期望数组，得到 ${typeof items}`);
  // 按结果计费：读到了才收
  recordCall(WEIBO_COUNT_KEY, items.length);
  return mapWeibo(items[0], ref);
}
