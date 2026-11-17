import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import type { LinkRef } from "./link";
import { SourceFetchError, emptyStats, hashtagsIn, titleFromText, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条 X 帖子，不用登录、不花钱。两条路，前一条不通再走后一条：
 *
 * 1. FxTwitter 的公开接口（api.fxtwitter.com/i/status/<id>，给聊天软件做链接预览用的开源服务）：正文（长帖是全文）、
 *    作者、回复 / 转发 / 点赞 / 书签 / 浏览数、图片、视频的各档 mp4 地址、引用的帖子、链接卡片。
 * 2. X 官方的嵌入接口（cdn.syndication.twimg.com/tweet-result，网页里嵌一条帖子时用的）：正文、作者、点赞数、回复数、
 *    图片 / 视频；没有转发、书签、浏览数，敏感内容和部分老帖不给。
 *
 * 两条路都读不到回复的内容（只有回复数）。帖子不存在 / 私密抛 SourceFetchError；网络错误原样抛（可以重试）。
 */

const UA = "Mozilla/5.0 (compatible; SM-Intelligence/1.0)";
const GONE = "这条 X 帖子读不到：可能被删了、账号设成了私密，或者链接不对。在 X 里重新点「分享 → 复制链接」再贴一次";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

type Variant = { url: string; bitrate: number | null };

/** 视频的几档 mp4 里挑一档：估算大小（码率 × 时长）不超过上限的最高码率；都超了给最小的那档（下载时会按大小拦下）。 */
function pickVariant(variants: Variant[], durationS: number | null, maxBytes: number): { url: string; backupUrls: string[]; bytes: number | null } | null {
  const sorted = [...variants].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (sorted.length === 0) return null;
  const size = (v: Variant) => (v.bitrate && durationS ? Math.round((v.bitrate * durationS) / 8) : null);
  const best = sorted.find((v) => (size(v) ?? 0) <= maxBytes) ?? sorted[sorted.length - 1];
  return { url: best.url, backupUrls: sorted.filter((v) => v !== best && (v.bitrate ?? 0) < (best.bitrate ?? 0)).map((v) => v.url), bytes: size(best) };
}

const mp4Variants = (raw: unknown): Variant[] =>
  arr(raw)
    .map((v) => obj(v))
    .filter((v) => str(v.content_type) === "video/mp4" && str(v.url).startsWith("https://"))
    .map((v) => ({ url: str(v.url), bitrate: posNum(v.bitrate) }));

/** 作者显示成「名字 @账号」（X 上认人靠 @账号）。 */
const authorName = (name: string, handle: string) => [name, handle ? `@${handle}` : ""].filter(Boolean).join(" ");

/** FxTwitter 返回的 tweet → 帖子。 */
export function mapFxTweet(raw: unknown, maxVideoBytes = 50 * 1024 * 1024): FetchedPost {
  const t = obj(raw);
  const id = str(t.id);
  if (!id) throw new SourceFetchError(GONE);
  const author = obj(t.author);
  const media = obj(t.media);
  const photos = arr(media.photos).map((p) => obj(p));
  const videos = arr(media.videos).map((v) => obj(v));
  const quote = obj(t.quote);
  const card = obj(t.card);
  const notes: string[] = ["读不到回复的内容，只有回复数"];

  let text = str(t.text).trim();
  if (str(quote.text)) text += `\n\n【引用 @${str(obj(quote.author).screen_name)} 的帖子】\n${str(quote.text).trim()}`;
  if (str(card.title)) text += `\n\n【链接卡片】${str(card.title)}${str(card.description) ? `\n${str(card.description)}` : ""}${str(card.domain) ? `（${str(card.domain)}）` : ""}`;
  if (str(t.replying_to)) notes.push(`这是回 @${str(t.replying_to)} 的一条回复，上文没读到`);
  const communityNote = str(obj(t.community_note).text);
  if (communityNote) notes.push(`帖子下有社区备注：${communityNote.replace(/\s+/g, " ").slice(0, 200)}`);

  const first = videos[0];
  const durationS = first ? posNum(first.duration) : null;
  const picked = first ? (pickVariant(mp4Variants(first.variants), durationS, maxVideoBytes) ?? (str(first.url) ? { url: str(first.url), backupUrls: [], bytes: null } : null)) : null;
  if (videos.length > 1) notes.push(`这条帖子有 ${videos.length} 个视频，只存了第一个`);
  if (first && !picked) notes.push("没有拿到视频地址，只读到了封面");

  const images: RemoteFile[] =
    photos.length > 0
      ? photos.filter((p) => str(p.url)).map((p) => ({ url: str(p.url), width: posNum(p.width), height: posNum(p.height) }))
      : first && str(first.thumbnail_url)
        ? [{ url: str(first.thumbnail_url), width: posNum(first.width), height: posNum(first.height) }]
        : str(obj(card.image).url)
          ? [{ url: str(obj(card.image).url), width: posNum(obj(card.image).width), height: posNum(obj(card.image).height) }]
          : [];

  const retweets = toCount(t.retweets);
  const quotes = toCount(t.quotes);
  const ts = posNum(t.created_timestamp);
  return {
    platform: "x",
    externalId: id,
    kind: first ? "video" : photos.length > 0 ? "image" : "text",
    title: titleFromText(str(t.text)),
    text,
    author: { id: str(author.id) || null, name: authorName(str(author.name), str(author.screen_name)) },
    publishedAt: ts ? new Date(ts * 1000).toISOString() : null,
    // 转发 = 转发 + 引用转发（都是把它带到自己的时间线上）
    stats: { views: toCount(t.views), likes: toCount(t.likes), collects: toCount(t.bookmarks), comments: toCount(t.replies), shares: retweets === null ? null : retweets + (quotes ?? 0) },
    hashtags: hashtagsIn(str(t.text)),
    topComments: [],
    images,
    video: picked ? { url: picked.url, backupUrls: picked.backupUrls, bytes: picked.bytes, width: posNum(first?.width), height: posNum(first?.height), durationS } : null,
    music: null,
    notes,
  };
}

/** 官方嵌入接口返回的 tweet → 帖子（正文里的 t.co 短链换回原链接，图片 / 视频的占位短链去掉）。 */
export function mapSyndicationTweet(raw: unknown, maxVideoBytes = 50 * 1024 * 1024): FetchedPost {
  const t = obj(raw);
  const id = str(t.id_str);
  if (!id || (t.__typename !== undefined && t.__typename !== "Tweet")) throw new SourceFetchError(GONE);
  const user = obj(t.user);
  const entities = obj(t.entities);
  let body = str(t.text);
  for (const m of arr(entities.media)) body = body.replace(str(obj(m).url), "");
  for (const u of arr(entities.urls)) if (str(obj(u).url)) body = body.replace(str(obj(u).url), str(obj(u).expanded_url) || str(obj(u).url));
  body = body.trim();
  const notes: string[] = ["这次走的是备用接口：没有转发数、书签数、浏览量", "读不到回复的内容，只有回复数"];
  if (t.note_tweet) notes.push("这是一条长帖，只读到了开头一段");
  const quoted = obj(t.quoted_tweet);
  let text = body;
  if (str(quoted.text)) text += `\n\n【引用 @${str(obj(quoted.user).screen_name)} 的帖子】\n${str(quoted.text).trim()}`;

  const details = arr(t.mediaDetails).map((m) => obj(m));
  const photos = details.filter((m) => str(m.type) === "photo" && str(m.media_url_https));
  const clip = details.find((m) => str(m.type) === "video" || str(m.type) === "animated_gif");
  const info = obj(clip?.video_info);
  const durationS = posNum(info.duration_millis) ? Math.round(posNum(info.duration_millis)! / 100) / 10 : null;
  const picked = clip ? pickVariant(mp4Variants(info.variants), durationS, maxVideoBytes) : null;
  if (clip && !picked) notes.push("没有拿到视频地址，只读到了封面");
  const dims = (m: Obj) => ({ width: posNum(obj(m.original_info).width), height: posNum(obj(m.original_info).height) });
  const images: RemoteFile[] =
    photos.length > 0 ? photos.map((m) => ({ url: str(m.media_url_https), ...dims(m) })) : clip && str(clip.media_url_https) ? [{ url: str(clip.media_url_https), ...dims(clip) }] : [];
  const created = Date.parse(str(t.created_at));
  return {
    platform: "x",
    externalId: id,
    kind: clip ? "video" : photos.length > 0 ? "image" : "text",
    title: titleFromText(body),
    text,
    author: { id: str(user.id_str) || null, name: authorName(str(user.name), str(user.screen_name)) },
    publishedAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
    stats: { ...emptyStats(), likes: toCount(t.favorite_count), comments: toCount(t.conversation_count) },
    hashtags: hashtagsIn(body),
    topComments: [],
    images,
    video: picked && clip ? { url: picked.url, backupUrls: picked.backupUrls, bytes: picked.bytes, ...dims(clip), durationS } : null,
    music: null,
    notes,
  };
}

/** 嵌入接口要的校验参数：由帖子 id 算出来（和 X 官方嵌入脚本里的算法一样）。 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function viaFx(id: string, maxVideoBytes?: number): Promise<FetchedPost | null> {
  const res = await labeledFetch("FxTwitter(api.fxtwitter.com)", `https://api.fxtwitter.com/i/status/${id}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const json = obj(await res.json().catch(() => null));
  const code = typeof json.code === "number" ? json.code : res.status;
  if (code === 404) throw new SourceFetchError(GONE);
  if (code === 401) throw new SourceFetchError("这条 X 帖子是私密账号发的，读不了。可以把帖子文字贴进来直接分析");
  // 别的状态（限流、服务出错、返回的不是 JSON）：换备用接口
  return code === 200 && json.tweet ? mapFxTweet(json.tweet, maxVideoBytes) : null;
}

async function viaSyndication(id: string, maxVideoBytes?: number): Promise<FetchedPost> {
  const res = await labeledFetch("X(cdn.syndication.twimg.com)", `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 400) {
    await res.body?.cancel().catch(() => {});
    throw new SourceFetchError(GONE);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`X ${res.status}：帖子读不到，过一会儿再试`);
  }
  return mapSyndicationTweet(await res.json().catch(() => null), maxVideoBytes);
}

/** 读一条 X 帖子。 */
export async function fetchXPost(ref: LinkRef, maxVideoBytes?: number): Promise<FetchedPost> {
  let post: FetchedPost | null = null;
  try {
    post = await viaFx(ref.externalId, maxVideoBytes);
  } catch (e) {
    if (e instanceof SourceFetchError) throw e;
    console.error(`FxTwitter 读帖子失败，换备用接口 id=${ref.externalId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return post ?? (await viaSyndication(ref.externalId, maxVideoBytes));
}
