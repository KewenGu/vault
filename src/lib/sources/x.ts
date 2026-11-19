import { MAX_IMAGES } from "@/lib/media/files";
import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import { embedPlaceholder, type Followed, type Mention } from "./follow";
import { parseLink, type LinkRef } from "./link";
import { SourceFetchError, emptyStats, hashtagsIn, titleFromText, toCount, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一条 X 帖子，不用登录、不花钱。两条路，前一条不通再走后一条：
 *
 * 1. FxTwitter 的公开接口（api.fxtwitter.com/i/status/<id>，给聊天软件做链接预览用的开源服务）：正文（长帖是全文）、
 *    作者、回复 / 转发 / 点赞 / 书签 / 浏览数、图片、视频的各档 mp4 地址、引用的帖子、链接卡片，
 *    还有 X 长文（Articles，x.com/i/article/…）的全文和配图。
 * 2. X 官方的嵌入接口（cdn.syndication.twimg.com/tweet-result，网页里嵌一条帖子时用的）：正文、作者、点赞数、回复数、
 *    图片 / 视频；没有转发、书签、浏览数，敏感内容和部分老帖不给；长文只有标题、开头一段和题图。
 *
 * 两条路都读不到回复的内容（只有回复数）。帖子不存在 / 私密抛 SourceFetchError；网络错误原样抛（可以重试）。
 *
 * 这里读一条帖子本身，并列出它提到的东西（引用转发的帖子、正文和长文里的所有链接、长文里嵌的帖子）；
 * 跟着读它们在 follow.ts。
 */

const UA = "Mozilla/5.0 (compatible; SM-Intelligence/1.0)";
const GONE = "这条 X 帖子读不到：可能被删了、账号设成了私密，或者链接不对。在 X 里重新点「分享 → 复制链接」再贴一次";
// 这两句 follow.ts 并进来时不重复（那边有同样的字）
const REPLIES_NOTE = "读不到回复的内容，只有回复数";
const FALLBACK_NOTE = "这次走的是备用接口：没有转发数、书签数、浏览量";

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

/** 长文的字数上限和网页文章一样（web.ts 的 WEB_TEXT_MAX）；配图存到转存的上限（MAX_IMAGES）。 */
const TEXT_MAX = 30_000;

/** 正文太长时截到上限，并记一条。 */
function capText(text: string, notes: string[], what: string): string {
  const chars = Array.from(text);
  if (chars.length <= TEXT_MAX) return text;
  notes.push(`${what}太长，只读了前 ${TEXT_MAX / 10_000} 万字`);
  return chars.slice(0, TEXT_MAX).join("");
}

const BLOCK_PREFIX: Record<string, string> = { "header-one": "# ", "header-two": "## ", "header-three": "### ", blockquote: "> ", "unordered-list-item": "- " };

/**
 * FxTwitter 给的 X 长文（tweet.article）→ 标题 + 正文 + 配图。正文是 Draft.js 的块：段落、标题、列表、引用照 Markdown 写；
 * atomic 块看它指向的实体：MARKDOWN（代码块、表格）原样放，MEDIA 是配图（正文里留「[配图 N]」，图按顺序存），
 * DIVIDER 是分割线，TWEET 是嵌进来的别的帖子（先留「【嵌入的帖子】链接」占位，读到了再换成内容，见 follow.ts）。
 * 段里的链接放在段尾（X 算位置的字数和 JS 对 emoji 不一样），也列在 links 里（要跟着读）。没有标题也没有正文返回 null。
 */
export function readFxArticle(raw: unknown): { title: string; body: string; images: RemoteFile[]; tweetIds: string[]; links: string[]; notes: string[] } | null {
  const a = obj(raw);
  const title = str(a.title).trim();
  const content = obj(a.content);
  const blocks = arr(content.blocks).map((b) => obj(b));
  if (!title && blocks.length === 0) return null;

  // entityMap：FxTwitter 给的是 [{ key, value }]，原样的 Draft.js 是 { key: value }
  const entities = new Map<string, Obj>();
  if (Array.isArray(content.entityMap)) for (const e of content.entityMap) entities.set(String(obj(e).key), obj(obj(e).value));
  else for (const [k, v] of Object.entries(obj(content.entityMap))) entities.set(k, obj(v));
  const entityOf = (range: unknown) => entities.get(String(obj(range).key)) ?? {};

  const mediaFile = (m: Obj): RemoteFile | null => {
    const info = obj(m.media_info);
    return str(info.original_img_url) ? { url: str(info.original_img_url), width: posNum(info.original_img_width), height: posNum(info.original_img_height) } : null;
  };
  const media = new Map<string, RemoteFile | null>(arr(a.media_entities).map((m) => [str(obj(m).media_id), mediaFile(obj(m))]));

  const images: RemoteFile[] = [];
  const cover = mediaFile(obj(a.cover_media));
  if (cover) images.push(cover);
  let figures = 0;
  let unsaved = 0;
  let unreadMedia = 0;
  const tweetIds: string[] = [];
  const unknown = new Set<string>();

  const atomic = (e: Obj): string | null => {
    const type = str(e.type);
    const data = obj(e.data);
    if (type === "MARKDOWN") return str(data.markdown).trim() || null;
    if (type === "DIVIDER") return "---";
    if (type === "TWEET") {
      if (!/^\d+$/.test(str(data.tweetId))) return null;
      tweetIds.push(str(data.tweetId));
      return embedPlaceholder(str(data.tweetId));
    }
    if (type === "MEDIA") {
      return arr(data.mediaItems)
        .map((item) => {
          const file = media.get(str(obj(item).mediaId));
          if (!file) {
            unreadMedia++;
            return "[媒体，没读到]";
          }
          figures++;
          if (images.some((i) => i.url === file.url)) return `[配图 ${figures}]`;
          if (images.length >= MAX_IMAGES) {
            unsaved++;
            return `[配图 ${figures}，没存]`;
          }
          images.push(file);
          return `[配图 ${figures}]`;
        })
        .join("\n");
    }
    if (type) unknown.add(type);
    return null;
  };

  const parts: { text: string; list: boolean }[] = [];
  const allLinks: string[] = [];
  let ordered = 0;
  for (const b of blocks) {
    const type = str(b.type);
    ordered = type === "ordered-list-item" ? ordered + 1 : 0;
    if (type === "atomic") {
      const text = atomic(entityOf(arr(b.entityRanges)[0]));
      if (text) parts.push({ text, list: false });
      continue;
    }
    const links = [...new Set(arr(b.entityRanges).map((r) => entityOf(r)).filter((e) => str(e.type) === "LINK").map((e) => str(obj(e.data).url)).filter(Boolean))];
    allLinks.push(...links);
    const text = str(b.text).trim();
    if (!text) continue;
    const prefix = type === "ordered-list-item" ? `${ordered}. ` : (BLOCK_PREFIX[type] ?? "");
    parts.push({ text: `${prefix}${text}${links.length > 0 ? `（链接：${links.join(" ")}）` : ""}`, list: type.endsWith("list-item") });
  }
  const body = parts.map((p, i) => (i === 0 ? "" : p.list && parts[i - 1].list ? "\n" : "\n\n") + p.text).join("");

  const notes: string[] = [];
  if (unsaved > 0) notes.push(`长文里有 ${figures} 张配图，只存了前 ${figures - unsaved} 张（正文里标了「没存」的没看到）`);
  if (unreadMedia > 0) notes.push(`长文里有 ${unreadMedia} 个图片 / 视频没读到`);
  if (unknown.size > 0) notes.push(`长文里有读不出的内容块（${[...unknown].join("、")}），跳过了`);
  if (blocks.length === 0) notes.push("长文只读到了标题，没读到正文");
  return { title, body, images, tweetIds: [...new Set(tweetIds)], links: [...new Set(allLinks)], notes };
}

const xRef = (id: string): LinkRef => ({ platform: "x", externalId: id, url: `https://x.com/i/status/${id}` });

/** 文字里的链接（去掉句末标点）。 */
const urlsIn = (text: string): string[] => [...text.matchAll(/https?:\/\/[\x21-\x7e]+/gi)].map((m) => m[0].replace(/["'<>]+.*$/, "").replace(/[)\]}.,;:!?]+$/, ""));

/**
 * 链接 → 要跟着读的东西（按出现顺序，同一条只算一次，不含帖子自己和自己的长文）。
 * 认得出是哪条的直接给 ref；X 长文本身的链接（x.com/i/article/…）查不到是哪条帖子发的，记成读不到；
 * 别的（短链、认不出的）ref 是 null，跟着读时再跟跳转。
 */
export function mentionsIn(urls: string[], selfId: string, ownArticleId: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>([`x:${selfId}`]);
  for (const url of urls) {
    const article = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/i\/article\/(\d+)/i.exec(url);
    if (article) {
      if (article[1] === ownArticleId || seen.has(`article:${article[1]}`)) continue;
      seen.add(`article:${article[1]}`);
      out.push({ how: "link", url, ref: null, unavailable: "这是 X 长文本身的链接，查不到是哪条帖子发的" });
      continue;
    }
    const ref = parseLink(url);
    const key = ref ? `${ref.platform}:${ref.externalId}` : url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ how: "link", url, ref });
  }
  return out;
}

const tryRead = (f: () => Followed): Followed | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

/** FxTwitter 的墓碑（引用的帖子看不到时给的 { type: "tombstone", reason }）为什么看不到。 */
const TOMBSTONE_REASON: Record<string, string> = { deleted: "被删了", suspended: "账号被封了", private: "是私密账号，或者要登录才能看", blocked: "作者屏蔽了别人" };

/** FxTwitter 返回的 tweet → 帖子 + 它提到的东西。引用的是长文、又只给了开头时，不用它带的，另外读一次。 */
export function readFxTweet(raw: unknown, maxVideoBytes?: number): Followed {
  const t = obj(raw);
  const post = mapFxTweet(t, maxVideoBytes);
  const quote = obj(t.quote);
  const quoteId = str(quote.id);
  const quoteArticle = obj(quote.article);
  const partialArticle = Object.keys(quoteArticle).length > 0 && arr(obj(quoteArticle.content).blocks).length === 0;
  const mentions: Mention[] = [];
  if (quote.type === "tombstone") {
    const why = TOMBSTONE_REASON[str(quote.reason)] ?? "看不到";
    if (quoteId) mentions.push({ how: "quote", ...urlRef(quoteId), unavailable: why });
    else post.notes.push(`引用的帖子没读到：${why}`);
  } else if (quoteId) mentions.push({ how: "quote", ...urlRef(quoteId), read: partialArticle ? undefined : tryRead(() => readFxTweet(quote, maxVideoBytes)) });
  const article = readFxArticle(t.article);
  mentions.push(...mentionsIn([...urlsIn(str(t.text)), ...(article?.links ?? [])], post.externalId, str(obj(t.article).id)));
  for (const id of article?.tweetIds ?? []) mentions.push({ how: "embed", ...urlRef(id) });
  return { post, mentions };
}

const urlRef = (id: string) => ({ url: `https://x.com/i/status/${id}`, ref: xRef(id) });

/** 官方嵌入接口返回的 tweet → 帖子 + 它提到的东西（引用的帖子它也带着，但只有正文和图）。 */
export function readSyndicationTweet(raw: unknown, maxVideoBytes?: number): Followed {
  const t = obj(raw);
  const post = mapSyndicationTweet(t, maxVideoBytes);
  const quoted = obj(t.quoted_tweet);
  const mentions: Mention[] = [];
  if (str(quoted.id_str)) mentions.push({ how: "quote", ...urlRef(str(quoted.id_str)), read: tryRead(() => readSyndicationTweet(quoted, maxVideoBytes)) });
  mentions.push(...mentionsIn(urlsIn(post.text), post.externalId, str(obj(t.article).rest_id)));
  return { post, mentions };
}

/** 作者显示成「名字 @账号」（X 上认人靠 @账号）。 */
const authorName = (name: string, handle: string) => [name, handle ? `@${handle}` : ""].filter(Boolean).join(" ");

/** FxTwitter 返回的 tweet → 帖子（只是它自己；引用的帖子见 readFxTweet）。 */
export function mapFxTweet(raw: unknown, maxVideoBytes = 50 * 1024 * 1024): FetchedPost {
  const t = obj(raw);
  const id = str(t.id);
  if (!id) throw new SourceFetchError(GONE);
  const author = obj(t.author);
  const media = obj(t.media);
  const photos = arr(media.photos).map((p) => obj(p));
  const videos = arr(media.videos).map((v) => obj(v));
  const card = obj(t.card);
  const article = readFxArticle(t.article);
  const notes: string[] = [REPLIES_NOTE, ...(article?.notes ?? [])];

  let text = str(t.text).trim();
  if (article) text = capText(`${text}\n\n【X 长文】${article.title}${article.body ? `\n\n${article.body}` : ""}`, notes, "长文");
  // 长文的链接卡片就是长文本身，不重复
  else if (str(card.title)) text += `\n\n【链接卡片】${str(card.title)}${str(card.description) ? `\n${str(card.description)}` : ""}${str(card.domain) ? `（${str(card.domain)}）` : ""}`;
  if (str(t.replying_to)) notes.push(`这是回 @${str(t.replying_to)} 的一条回复，上文没读到`);
  const communityNote = str(obj(t.community_note).text);
  if (communityNote) notes.push(`帖子下有社区备注：${communityNote.replace(/\s+/g, " ").slice(0, 200)}`);

  const first = videos[0];
  const durationS = first ? posNum(first.duration) : null;
  const picked = first ? (pickVariant(mp4Variants(first.variants), durationS, maxVideoBytes) ?? (str(first.url) ? { url: str(first.url), backupUrls: [], bytes: null } : null)) : null;
  if (videos.length > 1) notes.push(`这条帖子有 ${videos.length} 个视频，只存了第一个`);
  if (first && !picked) notes.push("没有拿到视频地址，只读到了封面");

  const images: RemoteFile[] =
    article && article.images.length > 0
      ? article.images
      : photos.length > 0
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
    kind: first ? "video" : article ? "article" : photos.length > 0 ? "image" : "text",
    title: article?.title || titleFromText(str(t.text)),
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

/** 官方嵌入接口返回的 tweet → 帖子（只是它自己；正文里的 t.co 短链换回原链接，图片 / 视频的占位短链去掉）。 */
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
  const notes: string[] = [FALLBACK_NOTE, REPLIES_NOTE];
  if (t.note_tweet) notes.push("这是一条长帖，只读到了开头一段");
  let text = body;
  // 长文：这个接口只给标题、开头一段（preview_text）和题图
  const article = obj(t.article);
  const articleTitle = str(article.title).trim();
  if (articleTitle) {
    text += `\n\n【X 长文】${articleTitle}${str(article.preview_text).trim() ? `\n\n${str(article.preview_text).trim()}……` : ""}`;
    notes.push("这是一条 X 长文，备用接口只读到了标题和开头一段，后面的正文和配图没读到");
  }
  const articleCover = obj(obj(article.cover_media).media_info);

  const details = arr(t.mediaDetails).map((m) => obj(m));
  const photos = details.filter((m) => str(m.type) === "photo" && str(m.media_url_https));
  const clip = details.find((m) => str(m.type) === "video" || str(m.type) === "animated_gif");
  const info = obj(clip?.video_info);
  const durationS = posNum(info.duration_millis) ? Math.round(posNum(info.duration_millis)! / 100) / 10 : null;
  const picked = clip ? pickVariant(mp4Variants(info.variants), durationS, maxVideoBytes) : null;
  if (clip && !picked) notes.push("没有拿到视频地址，只读到了封面");
  const dims = (m: Obj) => ({ width: posNum(obj(m.original_info).width), height: posNum(obj(m.original_info).height) });
  const images: RemoteFile[] =
    photos.length > 0
      ? photos.map((m) => ({ url: str(m.media_url_https), ...dims(m) }))
      : clip && str(clip.media_url_https)
        ? [{ url: str(clip.media_url_https), ...dims(clip) }]
        : str(articleCover.original_img_url)
          ? [{ url: str(articleCover.original_img_url), width: posNum(articleCover.original_img_width), height: posNum(articleCover.original_img_height) }]
          : [];
  const created = Date.parse(str(t.created_at));
  return {
    platform: "x",
    externalId: id,
    kind: clip ? "video" : articleTitle ? "article" : photos.length > 0 ? "image" : "text",
    title: articleTitle || titleFromText(body),
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

async function viaFx(id: string, maxVideoBytes?: number): Promise<Followed | null> {
  const res = await labeledFetch("FxTwitter(api.fxtwitter.com)", `https://api.fxtwitter.com/i/status/${id}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const json = obj(await res.json().catch(() => null));
  const code = typeof json.code === "number" ? json.code : res.status;
  if (code === 404) throw new SourceFetchError(GONE);
  if (code === 401) throw new SourceFetchError("这条 X 帖子是私密账号发的，读不了。可以把帖子文字贴进来直接分析");
  // 别的状态（限流、服务出错、返回的不是 JSON）：换备用接口
  return code === 200 && json.tweet ? readFxTweet(json.tweet, maxVideoBytes) : null;
}

async function viaSyndication(id: string, maxVideoBytes?: number): Promise<Followed> {
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
  return readSyndicationTweet(await res.json().catch(() => null), maxVideoBytes);
}

/** 读一条 X 帖子本身（FxTwitter → 官方嵌入接口），连同它提到的东西（还没读，跟着读见 follow.ts）。 */
export async function readXPost(ref: Pick<LinkRef, "externalId">, maxVideoBytes?: number): Promise<Followed> {
  let read: Followed | null = null;
  try {
    read = await viaFx(ref.externalId, maxVideoBytes);
  } catch (e) {
    if (e instanceof SourceFetchError) throw e;
    console.error(`FxTwitter 读帖子失败，换备用接口 id=${ref.externalId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return read ?? (await viaSyndication(ref.externalId, maxVideoBytes));
}
