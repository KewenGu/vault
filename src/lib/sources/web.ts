import { publicFetch } from "@/lib/network/public-fetch";
import "server-only";
import { recordCall } from "@/lib/usage/meter";
import { assertSafeUrl } from "@/lib/network/safe-url";
import type { LinkRef } from "./link";
import { downloadRemote } from "@/lib/media/files";
import { SourceFetchError, emptyStats, type FetchedPost, type RemoteFile } from "./types";
import { mapYtdlpInfo, ytdlpInfo } from "./ytdlp";

/**
 * 读「别的链接」：不是那六个平台的，一律按网页读——博文、新闻、公众号文章、别的视频站。
 *
 * 1. 本机有 yt-dlp 时先问它认不认得（B 站、Vimeo、微博视频…）：认得就按视频读（标题、简介、播放数，视频交给 yt-dlp 下）。
 * 2. 否则读正文，三条路依次试：
 *    - Jina Reader 带密钥（和调研管线同一个 JINA_API_KEY，记一笔 jina_fetch）；
 *    - 密钥不能用（没配、欠费 402、限流）时不带密钥再试一次（免费，限速更紧）；
 *    - 还不行就自己抓网页，从 HTML 里取标题、简介、题图和正文（纯前端渲染的页面这条路读不出正文）。
 *
 * 网页没有点赞、评论这些数字：拆解时只能从内容本身判断它好在哪。
 */

/** 正文最多留这么多字（一篇长文足够；再长的后面多半是评论、推荐） */
export const WEB_TEXT_MAX = 30_000;
/** 题图 + 配图最多存这么多张 */
const WEB_MAX_IMAGES = 6;
export const JINA_COUNT_KEY = "jina_fetch";

export type PageRead = {
  title: string;
  description: string;
  text: string;
  /** 题图（og:image） */
  cover: string | null;
  /** 正文里的配图，按出现顺序 */
  images: string[];
  author: string;
  site: string;
  publishedAt: string | null;
  via: "jina" | "direct";
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Markdown 正文收拾一下：去掉图片、把链接换成它的文字（地址对分析没用、还很占地方）、压掉多余空行。 */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 正文开头的站点导航、订阅 / 赞助条去掉：前 4000 字里有一行标题和文章标题对得上，就从它后面开始
 * （标题页面上单独显示，不用留）。对不上、或者剩下的不到 200 字，原样返回。
 */
export function dropPreamble(text: string, title: string): string {
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  const t = norm(title);
  if (t.length < 4) return text;
  let best: { end: number; size: number } | null = null;
  // 两种写法都认：`## 标题`，和下面一行 === 的
  for (const m of text.slice(0, 4000).matchAll(/^(?:#{1,3}[ \t]+(.+)|(.+)\n=+)$/gm)) {
    const h = norm(m[1] ?? m[2]);
    // 页面标题常带「 | 站名」：文章标题那一行占了它一半以上才算，免得认成站名那一行
    const hit = h.includes(t) || (t.includes(h) && h.length * 2 >= t.length);
    if (hit && (!best || h.length > best.size)) best = { end: m.index + m[0].length, size: h.length };
  }
  if (!best) return text;
  const rest = text.slice(best.end).trim();
  return rest.length >= 200 ? rest : text;
}

function isoDate(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = str(c);
    if (!s) continue;
    // og:updated_time 这类是秒数
    const t = /^\d{10}$/.test(s) ? Number(s) * 1000 : Date.parse(s);
    if (Number.isFinite(t) && t > 0) return new Date(t).toISOString();
  }
  return null;
}

/** 能当配图存的图片地址：http(s)，不是矢量图 / 动图 / 图标，地址里不像 logo、头像、占位图。 */
export function usableImage(raw: string, base?: string): string | null {
  // 空地址按页面地址补全会变成页面自己
  if (!raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/\.(svg|gif|ico)$/i.test(u.pathname)) return null;
  if (/(logo|icon|avatar|sprite|emoji|badge|favicon|placeholder|spacer|pixel|gravatar|tracking)/i.test(u.pathname)) return null;
  return u.href;
}

type JinaData = { title?: unknown; description?: unknown; content?: unknown; images?: unknown; metadata?: unknown; warning?: unknown };

/** Jina Reader 的 `data` → 读到的网页。没有正文返回 null。 */
export function mapJinaData(data: unknown, url: string): PageRead | null {
  const d = (data && typeof data === "object" ? data : {}) as JinaData;
  if (typeof d.content !== "string") return null;
  // 目标网页本身打不开（403 / 404 / 验证页）时 Jina 照样返回 200，只在 warning 里说
  if (/returned error|error \d{3}/i.test(str(d.warning))) return null;
  const meta = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
  const author = [meta.author, meta["article:author"], meta["twitter:creator"]].map(str).find((a) => a && !/^https?:\/\//i.test(a)) ?? "";
  const images = d.images && typeof d.images === "object" ? Object.values(d.images as Record<string, unknown>) : [];
  const title = str(d.title) || str(meta["og:title"]);
  return {
    title,
    description: str(d.description) || str(meta["og:description"]),
    text: dropPreamble(cleanMarkdown(d.content), title),
    cover: usableImage(str(meta["og:image"]) || str(meta["twitter:image"]), url),
    images: images.map((i) => usableImage(str(i), url)).filter((i): i is string => i !== null),
    author,
    site: str(meta["og:site_name"]),
    // Jina 自己的 publishedTime 在页面没写日期时给的是「现在」，不能用；只认页面元数据里的
    publishedAt: isoDate(meta["article:published_time"], meta["og:article:published_time"], meta.datePublished, meta.pubdate, meta.date),
    via: "jina",
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : key.startsWith("#") ? Number(key.slice(1)) : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
  });

/** `<meta property|name="…" content="…">`（两种属性顺序都认）。 */
function metaContent(html: string, name: string): string {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*?content=["']([^"']*)["']`, "i").exec(html);
  const b = a ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name|itemprop)=["']${n}["']`, "i").exec(html);
  return decode(b?.[1] ?? "").trim();
}

/** 自己抓的 HTML → 读到的网页（Jina 用不了时的后备）：正文取 <article> / <main> / <body> 里的文字，去掉脚本、导航、页脚。 */
export function parseHtmlPage(html: string, url: string): PageRead {
  const region = /<article\b[\s\S]*<\/article>/i.exec(html)?.[0] ?? /<main\b[\s\S]*<\/main>/i.exec(html)?.[0] ?? /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const kept = region.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ");
  const text = decode(
    kept
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/section)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const images: string[] = [];
  for (const m of kept.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)) {
    const u = usableImage(decode(m[1]), url);
    if (u && !images.includes(u)) images.push(u);
  }
  const author = metaContent(html, "author") || metaContent(html, "article:author");
  return {
    title: metaContent(html, "og:title") || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim(),
    description: metaContent(html, "og:description") || metaContent(html, "description"),
    text,
    cover: usableImage(metaContent(html, "og:image") || metaContent(html, "twitter:image"), url),
    images,
    author: /^https?:\/\//i.test(author) ? "" : author,
    site: metaContent(html, "og:site_name"),
    publishedAt: isoDate(metaContent(html, "article:published_time"), metaContent(html, "datePublished"), /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1]),
    via: "direct",
  };
}

/** 问一次 Jina Reader。返回读到的网页；null = 这次没读成（status 说为什么）。 */
async function jina(url: string, key: string | null): Promise<{ status: number; page: PageRead | null }> {
  let res: Response;
  try {
    res = await publicFetch(`https://r.jina.ai/${url}`, {
      headers: { accept: "application/json", "x-return-format": "markdown", "x-with-images-summary": "true", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: 0, page: null };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, page: null };
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return { status: res.status, page: mapJinaData(json?.data, url) };
}

/** 自己抓网页（跟跳转时每一跳都过 SSRF 守卫，最多读 3 MB）。读不到返回 null。 */
async function direct(url: string): Promise<PageRead | null> {
  try {
    const bytes = await downloadRemote({ url, headers: { accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" } }, 3 * 1024 * 1024, 20_000);
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
    let html: string;
    try {
      html = new TextDecoder(charset).decode(bytes);
    } catch {
      html = new TextDecoder("utf-8").decode(bytes);
    }
    return /<html|<body|<article|<meta/i.test(html) ? parseHtmlPage(html, url) : null;
  } catch {
    return null;
  }
}

const hasBody = (p: PageRead | null): p is PageRead => !!p && (p.text.length >= 200 || (p.text.length > 0 && p.description.length > 0));

/** 读一个网页的正文：Jina（带密钥 → 不带）→ 自己抓。都读不出正文返回 null。 */
export async function readPage(url: string): Promise<PageRead | null> {
  const key = process.env.JINA_API_KEY?.trim() || null;
  if (key) {
    const keyed = await jina(url, key);
    if (keyed.status >= 200 && keyed.status < 300) recordCall(JINA_COUNT_KEY);
    if (hasBody(keyed.page)) return keyed.page;
    // 密钥本身的问题（401 无效、402 欠费、403、429 限流）：不带密钥再试；别的失败（页面读不了）直接换自己抓
    if (![401, 402, 403, 429].includes(keyed.status)) return orNull(await direct(url));
  }
  const free = await jina(url, null);
  if (hasBody(free.page)) return free.page;
  return orNull(await direct(url));
}

const orNull = (p: PageRead | null) => (hasBody(p) ? p : null);

/**
 * 读到的是不是登录页：要登录的站（Threads、知乎、LinkedIn…）对没登录的访问返回一个「请登录」的页面，照样有标题有文字。
 * 标题里带「登录 / Log in / Sign in」、文字又不长的按登录页算（真讲登录的长文不受影响）。
 */
export function looksLikeLoginWall(page: Pick<PageRead, "title" | "text">): boolean {
  return /\b(log ?in|sign ?in)\b|登录|登入|ログイン/i.test(page.title) && page.text.length < 3000;
}

/** 读到的网页 → 帖子（类型是「文章」）。 */
export function mapPage(page: PageRead, ref: LinkRef): FetchedPost {
  const host = new URL(ref.url).hostname.replace(/^www\./, "");
  const chars = Array.from(page.text);
  const notes = ["网页没有点赞、评论这些数字，只能从内容本身判断它好在哪"];
  if (chars.length > WEB_TEXT_MAX) notes.push(`文章很长，只读了前 ${WEB_TEXT_MAX / 10_000} 万字`);
  if (page.via === "direct") notes.push("正文是直接从网页里取的，可能夹着导航、广告的文字");
  const urls = [...new Set([page.cover, ...page.images].filter((u): u is string => !!u))].slice(0, WEB_MAX_IMAGES);
  const images: RemoteFile[] = urls.map((url) => ({ url }));
  return {
    platform: "web",
    externalId: ref.externalId,
    kind: "article",
    title: page.title || host,
    text: chars.slice(0, WEB_TEXT_MAX).join("") || page.description,
    author: { id: null, name: page.author && page.site && page.author !== page.site ? `${page.author} · ${page.site}` : page.author || page.site || host },
    publishedAt: page.publishedAt,
    stats: emptyStats(),
    hashtags: [],
    topComments: [],
    images,
    video: null,
    music: null,
    notes,
  };
}

/** 读一个「别的链接」。读不出内容抛 SourceFetchError（让用户把内容贴进来）。 */
export async function fetchWebPage(ref: LinkRef): Promise<FetchedPost> {
  if (!assertSafeUrl(ref.url)) throw new SourceFetchError("这个地址读不了（指向本机或内网）");
  // 认得的视频站（本机有 yt-dlp 才问得到）
  const video = await ytdlpInfo(ref.url).catch(() => null);
  if (video && !video.isLive && video.durationS) {
    const post = mapYtdlpInfo(video, ref);
    return { ...post, title: post.title || new URL(ref.url).hostname };
  }
  const page = await readPage(ref.url);
  if (!page) throw new SourceFetchError("这个网页没读出正文：可能要登录才能看，或者内容是脚本加载的。把内容复制下来贴进来直接分析");
  if (looksLikeLoginWall(page)) throw new SourceFetchError("这个网页要登录才能看（读到的是登录页）。把内容复制下来贴进来直接分析");
  return mapPage(page, ref);
}
