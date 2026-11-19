import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
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
 * 帖子提到的别的 X 帖子也一起读（只往下读一层，最多 MAX_MENTIONS 条）：引用转发的帖子、正文里贴的帖子链接、长文里嵌的帖子。
 * 它们的正文接在后面（长文里嵌的放回原来的位置），图片排在后面存到上限；帖子自己没视频时用它们的第一个视频。
 * 读不到的记进 notes。互动数、话题标签只算这条帖子自己的。
 */

const UA = "Mozilla/5.0 (compatible; SM-Intelligence/1.0)";
const GONE = "这条 X 帖子读不到：可能被删了、账号设成了私密，或者链接不对。在 X 里重新点「分享 → 复制链接」再贴一次";
const REPLIES_NOTE = "读不到回复的内容，只有回复数";
const FALLBACK_NOTE = "这次走的是备用接口：没有转发数、书签数、浏览量";
/** 一条帖子最多再读几条它提到的帖子 */
const MAX_MENTIONS = 5;

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

/** 字数和配图上限（长文、加上提到的帖子以后）：和网页文章一样（web.ts 的 WEB_TEXT_MAX / WEB_MAX_IMAGES）。 */
const TEXT_MAX = 30_000;
const MAX_IMAGES = 6;

/** 正文太长时截到上限，并记一条（what：「长文」「加上提到的帖子」）。 */
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
 * DIVIDER 是分割线，TWEET 是嵌进来的别的帖子（先留「【嵌入的帖子】链接」占位，读到了再换成内容，见 withMentions）。
 * 段里的链接放在段尾（X 算位置的字数和 JS 对 emoji 不一样）。没有标题也没有正文返回 null。
 */
export function readFxArticle(raw: unknown): { title: string; body: string; images: RemoteFile[]; tweetIds: string[]; notes: string[] } | null {
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
  return { title, body, images, tweetIds: [...new Set(tweetIds)], notes };
}

const embedPlaceholder = (id: string) => `【嵌入的帖子】https://x.com/i/status/${id}`;

/**
 * 正文里贴的别的 X 帖子（按出现顺序，去重，不含自己）。贴的是 X 长文的链接（x.com/i/article/…，不是发长文的那条帖子本身）
 * 读不到：长文 id 查不到是哪条帖子发的，记一句。
 */
export function linkedPostIds(text: string, selfId: string, ownArticleId: string, notes: string[]): string[] {
  const ids: string[] = [];
  let articles = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'）】」]+/gi)) {
    const url = m[0].replace(/[)\].,;:!?。，；：！？]+$/, "");
    const ref = parseLink(url);
    if (ref?.platform === "x") {
      if (ref.externalId !== selfId && !ids.includes(ref.externalId)) ids.push(ref.externalId);
      continue;
    }
    const article = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/i\/article\/(\d+)/i.exec(url);
    if (article && article[1] !== ownArticleId) articles++;
  }
  if (articles > 0) notes.push(`正文里链接了 ${articles} 篇 X 长文（x.com/i/article/…），这种链接读不到内容`);
  return ids;
}

/**
 * 帖子提到的一条别的帖子。how：quote 引用转发，link 正文里贴的链接，embed 长文里嵌的。
 * read：已经读到的（FxTwitter 返回的引用帖子是完整的，不用再请求一次）；unavailable：已经知道看不到（被删、私密…），不用再去读。
 */
export type XMention = { id: string; how: "quote" | "link" | "embed"; read?: XRead; unavailable?: string };
/** 读一条帖子：帖子本身（不含提到的帖子）+ 它提到的帖子。 */
export type XRead = { post: FetchedPost; mentions: XMention[] };

const tryRead = (f: () => XRead): XRead | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

/** FxTwitter 的墓碑（引用的帖子看不到时给的 { type: "tombstone", reason }）为什么看不到。 */
const TOMBSTONE_REASON: Record<string, string> = { deleted: "被删了", suspended: "账号被封了", private: "是私密账号，或者要登录才能看", blocked: "作者屏蔽了别人" };

/** FxTwitter 返回的 tweet → 帖子 + 它提到的帖子。引用的是长文、又只给了开头时，不用它带的，另外读一次。 */
export function readFxTweet(raw: unknown, maxVideoBytes?: number): XRead {
  const t = obj(raw);
  const post = mapFxTweet(t, maxVideoBytes);
  const quote = obj(t.quote);
  const quoteId = str(quote.id);
  const quoteArticle = obj(quote.article);
  const partialArticle = Object.keys(quoteArticle).length > 0 && arr(obj(quoteArticle.content).blocks).length === 0;
  const mentions: XMention[] = [];
  if (quote.type === "tombstone") {
    const why = TOMBSTONE_REASON[str(quote.reason)] ?? "看不到";
    if (quoteId) mentions.push({ id: quoteId, how: "quote", unavailable: why });
    else post.notes.push(`引用的帖子没读到：${why}`);
  } else if (quoteId) mentions.push({ id: quoteId, how: "quote", read: partialArticle ? undefined : tryRead(() => readFxTweet(quote, maxVideoBytes)) });
  for (const id of linkedPostIds(str(t.text), post.externalId, str(obj(t.article).id), post.notes)) mentions.push({ id, how: "link" });
  for (const id of readFxArticle(t.article)?.tweetIds ?? []) mentions.push({ id, how: "embed" });
  return { post, mentions };
}

/** 官方嵌入接口返回的 tweet → 帖子 + 它提到的帖子（引用的帖子它也带着，但只有正文和图）。 */
export function readSyndicationTweet(raw: unknown, maxVideoBytes?: number): XRead {
  const t = obj(raw);
  const post = mapSyndicationTweet(t, maxVideoBytes);
  const quoted = obj(t.quoted_tweet);
  const mentions: XMention[] = [];
  if (str(quoted.id_str)) mentions.push({ id: str(quoted.id_str), how: "quote", read: tryRead(() => readSyndicationTweet(quoted, maxVideoBytes)) });
  for (const id of linkedPostIds(post.text, post.externalId, str(obj(t.article).rest_id), post.notes)) mentions.push({ id, how: "link" });
  return { post, mentions };
}

const MENTION_LABEL: Record<XMention["how"], string> = { quote: "引用的帖子", link: "正文里链接的帖子", embed: "长文里嵌的帖子" };

/** 提到的帖子读的结果：read 是读到的；没读到时 unavailable 是已知的原因，error 是读的时候出的错。 */
export type ResolvedMention = { id: string; how: XMention["how"]; read?: XRead; unavailable?: string; error?: unknown };

/**
 * 把读到的提到的帖子并进这条帖子：正文接在后面（长文里嵌的换掉占位），图片排在后面存到上限，自己没视频时用它们的第一个视频；
 * 它们读的时候留下的情况、没读到的、没再往下读的、超出条数没读的都记进 notes。互动数、标签、作者还是这条帖子自己的。
 */
export function withMentions(main: FetchedPost, mentions: ResolvedMention[], skipped = 0): FetchedPost {
  let text = main.text;
  const images = [...main.images];
  let video = main.video;
  const notes = [...main.notes];
  let title = main.title;
  for (const m of mentions) {
    const label = MENTION_LABEL[m.how];
    const url = `https://x.com/i/status/${m.id}`;
    if (!m.read) {
      const why = m.unavailable ?? (m.error === undefined || m.error instanceof SourceFetchError ? "可能被删了，或者是私密账号" : "网络出错");
      notes.push(`${label}没读到（${url}）：${why}`);
      continue;
    }
    const sub = m.read.post;
    const who = `${label}（${sub.author.name}）`;
    const section = `【${label}：${sub.author.name}】\n${sub.text}`;
    if (m.how === "embed" && text.includes(embedPlaceholder(m.id))) text = text.replace(embedPlaceholder(m.id), section);
    else text += `\n\n${section}`;
    title ||= sub.title;

    const fresh = sub.images.filter((f) => !images.some((i) => i.url === f.url));
    const room = Math.max(0, MAX_IMAGES - images.length);
    images.push(...fresh.slice(0, room));
    if (fresh.length > room) notes.push(`${who}有 ${fresh.length - room} 张图没存`);
    if (sub.video && !video) {
      video = sub.video;
      notes.push(`视频是${who}里的`);
    } else if (sub.video) notes.push(`${who}里也有视频，没存`);

    for (const n of sub.notes) if (n !== REPLIES_NOTE && n !== FALLBACK_NOTE) notes.push(`${who}：${n}`);
    const further = new Set(m.read.mentions.map((x) => x.id)).size;
    if (further > 0) notes.push(`${who}又提到了 ${further} 条帖子，没再往下读`);
  }
  if (skipped > 0) notes.push(`还提到了 ${skipped} 条别的帖子没读（一条最多跟着读 ${MAX_MENTIONS} 条）`);
  text = capText(text, notes, "加上提到的帖子");
  const kind = main.kind !== "text" ? main.kind : video ? "video" : images.length > main.images.length ? "image" : "text";
  return { ...main, kind, title, text, images, video, notes };
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

async function viaFx(id: string, maxVideoBytes?: number): Promise<XRead | null> {
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

async function viaSyndication(id: string, maxVideoBytes?: number): Promise<XRead> {
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

/** 读一条帖子本身：FxTwitter → 官方嵌入接口。 */
async function readXPost(id: string, maxVideoBytes?: number): Promise<XRead> {
  let read: XRead | null = null;
  try {
    read = await viaFx(id, maxVideoBytes);
  } catch (e) {
    if (e instanceof SourceFetchError) throw e;
    console.error(`FxTwitter 读帖子失败，换备用接口 id=${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return read ?? (await viaSyndication(id, maxVideoBytes));
}

/** 读一条 X 帖子，连同它提到的帖子（引用的、链接的、长文里嵌的，往下读一层）。提到的帖子读不到不影响这条。 */
export async function fetchXPost(ref: LinkRef, maxVideoBytes?: number): Promise<FetchedPost> {
  const { post, mentions } = await readXPost(ref.externalId, maxVideoBytes);
  const seen = new Set([post.externalId]);
  const unique = mentions.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const picked = unique.slice(0, MAX_MENTIONS);
  const resolved = await Promise.all(
    picked.map(async (m): Promise<ResolvedMention> => {
      if (m.read || m.unavailable) return m;
      try {
        return { ...m, read: await readXPost(m.id, maxVideoBytes) };
      } catch (error) {
        return { ...m, error };
      }
    })
  );
  return withMentions(post, resolved, unique.length - picked.length);
}
