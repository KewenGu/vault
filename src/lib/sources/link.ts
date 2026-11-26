import { createHash } from "node:crypto";
import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import { assertSafeUrl } from "@/lib/network/safe-url";
import type { SourcePlatform } from "./types";

/**
 * 收藏夹的链接识别：从粘贴的分享文案里找出链接 → 认出是哪个平台的哪条帖子。
 * 认得的平台（小红书、抖音、TikTok、Instagram、YouTube、X、Reddit）要从链接里读出帖子 id；短链（xhslink.com、v.douyin.com、
 * vm.tiktok.com、instagram.com/share/…、reddit.com/r/…/s/…）发一次请求看它跳到哪，每一跳都必须还在这个平台自己的域名上。
 * 其余链接一律算「网页」（博文、新闻、别的视频站）：不跟跳转，id 是整理过的地址的哈希。
 *
 * - 小红书：`/explore/<id>`、`/discovery/item/<id>`（笔记 id 是 24 位十六进制）。链接里的 `xsec_token` 是访问口令，
 *   没有它网页版读不到笔记，所以整条链接原样留着（抓取时用）。
 * - 抖音：`/video/<id>`、`/note/<id>`（图文）、`/share/video/<id>`，或精选 / 主页里的 `?modal_id=<id>`（id 是一串数字）。
 * - TikTok：`/@<用户>/video/<id>`、`/@<用户>/photo/<id>`、`/v/<id>.html`、`/embed/v2/<id>`。
 * - Instagram：`/p/<短码>`、`/reel/<短码>`、`/tv/<短码>`（前面可以带用户名；短码区分大小写）。
 * - YouTube：`watch?v=<id>`、`youtu.be/<id>`、`/shorts/<id>`、`/live/<id>`、`/embed/<id>`（id 是 11 位）。
 * - X：`/<用户>/status/<id>`、`/i/status/<id>`（twitter.com 和 fxtwitter 这类镜像域名也认）。
 * - Reddit：`/r/<版块>/comments/<id>/…`（后面带着某条评论的也算这条帖子）、`/comments/<id>`、`/gallery/<id>`、`redd.it/<id>`
 *   （id 是一串小写字母和数字）。i.redd.it、v.redd.it 是图片和视频文件的地址，不是帖子，按网页处理。
 *
 * 账号的主页（存一个博主的全部作品用，见 lib/vault/creator-service.ts）认这七个平台：
 * - X：`x.com/<用户名>`（后面带 `/with_replies`、`/media` 这些分栏的也算）。
 * - TikTok：`tiktok.com/@<用户名>`。
 * - 抖音：`douyin.com/user/<sec_uid>`、分享出来的 `iesdouyin.com/share/user/<sec_uid>`（App 里「分享主页 → 复制链接」
 *   得到的 v.douyin.com 短链跳到这里）。
 * - 小红书：`xiaohongshu.com/user/profile/<用户 id>`（24 位十六进制；App 里「分享主页」的 xhslink.com 短链跳到这里）。
 * - Instagram：`instagram.com/<用户名>`（后面带 `/reels`、`/tagged` 这些分栏的也算）。
 * - YouTube：频道的 `youtube.com/@<名字>`、`/channel/<UC 开头的 id>`、`/c/<名字>`、`/user/<名字>`（后面带 `/videos`、`/shorts`
 *   这些分栏的也算）。同一个频道用不同写法贴进来认不出是同一个。
 * - B 站：`space.bilibili.com/<数字 id>`（带 `/video`、`/dynamic` 这些分栏的也算）、`bilibili.com/space/<id>`；App 里
 *   「分享主页」的 b23.tv 短链跟一次跳转。B 站不是这里「认得的平台」（视频按网页读，本机有 yt-dlp 时按视频读），
 *   只有主页单独认；视频页的地址整理成 `bilibili.com/video/<BV 号>`（分 P 的留着 `?p=`），同一个视频只收藏一次。
 * 一条链接既认得出帖子又像主页时（抖音主页上打开的视频 `…/user/<sec_uid>?modal_id=<id>`、小红书从主页点开的笔记
 * `…/user/profile/<用户 id>/<笔记 id>`）算帖子。
 */

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
export const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type LinkRef = {
  platform: SourcePlatform;
  externalId: string;
  /** 抓取时用的链接：小红书是带口令的原链接，其余平台是规范写法（`https://www.douyin.com/video/<id>`，抖音图文是 `/note/<id>`），网页是去掉追踪参数的地址 */
  url: string;
};

/** 认得的平台（「网页」不在里面：它是兜底） */
type Site = Exclude<SourcePlatform, "web">;

const HOSTS: Record<Site, RegExp> = {
  xiaohongshu: /(^|\.)(xiaohongshu\.com|xhslink\.com)$/,
  douyin: /(^|\.)(douyin\.com|iesdouyin\.com)$/,
  tiktok: /(^|\.)tiktok\.com$/,
  instagram: /(^|\.)(instagram\.com|instagr\.am)$/,
  youtube: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/,
  x: /(^|\.)(x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/,
  reddit: /(^|\.)reddit\.com$|^redd\.it$/,
};
const SITES = Object.keys(HOSTS) as Site[];

/** 域名是哪个认得的平台；别的站（当网页读）返回 null。只看域名结尾，仿冒域名不算。 */
export function platformOfHost(hostname: string): Site | null {
  const h = hostname.toLowerCase();
  return SITES.find((s) => HOSTS[s].test(h)) ?? null;
}

function toUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** 没带 http 的链接（有人只复制了 xhslink.com/xxx、youtu.be/xxx）：只认这几个平台的域名 */
const BARE_LINK =
  /(?<![\w./@-])((?:[\w-]+\.)*(?:xhslink\.com|xiaohongshu\.com|douyin\.com|tiktok\.com|instagram\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|reddit\.com|redd\.it)\/[\x21-\x7e]+)/gi;

/**
 * 从粘贴的内容里找链接。App 里「复制链接」得到的是一段话（「7.94 复制打开抖音，看看【…】 https://v.douyin.com/xxx/ k@P.xx」），
 * 链接夹在中间、后面可能紧跟中文，所以只取 ASCII 那一段。优先返回认得的平台的；一个都不是时返回第一个链接（当网页读）。
 */
export function extractShareUrl(text: string): string | null {
  const found: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[\x21-\x7e]+/gi)) found.push(m[0]);
  for (const m of text.matchAll(BARE_LINK)) found.push(`https://${m[1]}`);
  const cleaned = found.map((u) => u.replace(/[)\]}>,.;!?'"]+$/, ""));
  for (const u of cleaned) {
    const url = toUrl(u);
    if (url && platformOfHost(url.hostname)) return url.href;
  }
  return cleaned.find((u) => toUrl(u)) ?? null;
}

/** 分享链接里常见的追踪参数：同一篇文章带不带它们都算同一条收藏 */
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|spm|_hsenc|_hsmi|ref_src|ref_url|share_token|share_source)$/i;

/** 微信公众号文章的长链接里认文章的只有这几个参数；chksm、scene、sharer_* 这些随分享的人和场合变 */
const WEIXIN_KEEP = ["__biz", "mid", "idx", "sn"];

/** 网页链接整理成固定写法（去掉 #片段和追踪参数），再取哈希当 id：同一个地址只收藏一次。 */
function webRef(url: URL): LinkRef | null {
  const u = new URL(url.href);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  // B 站视频页：分享出来的链接带着一串来源参数（spm_id_from、vd_source…），手机版是 m.bilibili.com，都整理成同一个写法
  const bv = /(^|\.)bilibili\.com$/i.test(u.hostname) ? /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(u.pathname) : null;
  if (bv) {
    const part = Number(u.searchParams.get("p"));
    u.protocol = "https:";
    u.hostname = "www.bilibili.com";
    u.pathname = `/video/${bv[1]}`;
    u.search = Number.isInteger(part) && part > 1 ? `?p=${part}` : "";
  }
  if (u.hostname === "mp.weixin.qq.com") {
    // 短链接 /s/<id> 本身就认得出文章，参数全不要；长链接 /s?__biz=…&mid=…&idx=…&sn=… 只留这四个
    const keep = /^\/s\/[\w-]+$/.test(u.pathname) ? [] : u.pathname === "/s" && u.searchParams.has("__biz") ? WEIXIN_KEEP : null;
    if (keep) u.search = new URLSearchParams(keep.flatMap((k) => (u.searchParams.has(k) ? [[k, u.searchParams.get(k)!]] : []))).toString();
  }
  if (!assertSafeUrl(u.href)) return null;
  return { platform: "web", externalId: createHash("sha256").update(u.href).digest("hex").slice(0, 32), url: u.href };
}

/** 抖音作品的规范链接：视频 `douyin.com/video/<id>`，图文 `douyin.com/note/<id>`。 */
export const douyinUrl = (id: string, kind: "video" | "image") => `https://www.douyin.com/${kind === "image" ? "note" : "video"}/${id}`;

function siteRef(site: Site, url: URL): LinkRef | null {
  const path = url.pathname;
  if (site === "xiaohongshu") {
    const m = /^\/(?:explore|discovery\/item|note|user\/profile\/[0-9a-f]+)\/([0-9a-f]{24})\/?$/i.exec(path);
    if (!m || /xhslink\.com$/i.test(url.hostname)) return null;
    const kept = new URL(url.href);
    kept.protocol = "https:";
    return { platform: site, externalId: m[1].toLowerCase(), url: kept.href };
  }
  if (site === "douyin") {
    const m = /^\/(?:share\/)?(video|note|slides)\/(\d{6,24})\/?$/.exec(path);
    const id = m?.[2] ?? (/^\d{6,24}$/.test(url.searchParams.get("modal_id") ?? "") ? url.searchParams.get("modal_id")! : null);
    // 图文（note / slides）留成 /note/；看不出是哪种的（modal_id）先当视频，读完按读到的种类改（见 douyin.ts）
    return id ? { platform: site, externalId: id, url: douyinUrl(id, m?.[1] === "note" || m?.[1] === "slides" ? "image" : "video") } : null;
  }
  if (site === "tiktok") {
    const m = /^\/@([\w.-]+)\/(?:video|photo)\/(\d{8,24})\/?$/.exec(path);
    const id = m?.[2] ?? /^\/(?:v|embed(?:\/v2)?|share\/video)\/(\d{8,24})(?:\.html)?\/?$/.exec(path)?.[1];
    // 不知道作者时用 `@_`：TikTok 认这个写法（按 id 找视频）
    return id ? { platform: site, externalId: id, url: `https://www.tiktok.com/@${m?.[1] ?? "_"}/video/${id}` } : null;
  }
  if (site === "instagram") {
    // /share/reel/<码> 是分享短链（码不是帖子的短码），要跟一次跳转
    const m = path.startsWith("/share/") ? null : /^\/(?:[\w.]+\/)?(p|reels?|tv)\/([\w-]{5,40})\/?$/.exec(path);
    if (!m) return null;
    const type = m[1] === "p" ? "p" : m[1] === "tv" ? "tv" : "reel";
    return { platform: site, externalId: m[2], url: `https://www.instagram.com/${type}/${m[2]}/` };
  }
  if (site === "youtube") {
    const short = /youtu\.be$/i.test(url.hostname);
    const m = short ? /^\/([\w-]{11})\/?$/.exec(path) : /^\/(shorts|live|embed|v)\/([\w-]{11})\/?$/.exec(path);
    const v = url.searchParams.get("v") ?? "";
    const id = short ? m?.[1] : (m?.[2] ?? (path === "/watch" && /^[\w-]{11}$/.test(v) ? v : undefined));
    if (!id) return null;
    return { platform: site, externalId: id, url: !short && m?.[1] === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}` };
  }
  if (site === "reddit") {
    const short = /^redd\.it$/i.test(url.hostname);
    const m = short ? /^\/([0-9a-z]{4,10})\/?$/i.exec(path) : /^\/(?:(?:r|u|user)\/[\w.-]+\/)?comments\/([0-9a-z]{4,10})(?:\/|$)/i.exec(path) ?? /^\/gallery\/([0-9a-z]{4,10})\/?$/i.exec(path);
    // 读到之后换成带版块和标题的那个地址（见 reddit.ts）
    return m ? { platform: site, externalId: m[1].toLowerCase(), url: `https://www.reddit.com/comments/${m[1].toLowerCase()}` } : null;
  }
  const m = /^\/(?:(\w{1,15})\/status(?:es)?|i\/(?:web\/)?status)\/(\d{5,25})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(path);
  return m ? { platform: "x", externalId: m[2], url: `https://x.com/${m[1] ?? "i"}/status/${m[2]}` } : null;
}

/** 能整个存下来的账号是哪几个平台的（列一个账号的作品见 account-list.ts） */
export const ACCOUNT_PLATFORMS = ["x", "tiktok", "douyin", "xiaohongshu", "instagram", "youtube", "bilibili"] as const;
export type AccountPlatform = (typeof ACCOUNT_PLATFORMS)[number];

/**
 * 一个账号的主页。externalId：X、TikTok、Instagram 是小写的用户名，抖音是 sec_uid，小红书是用户 id，
 * YouTube 是 `@名字`（小写）/ 频道 id / `c/名字` / `user/名字`，B 站是数字 id（mid）；
 * handle 是给人看的（`@karpathy`，抖音、小红书、B 站没有就是空）。
 */
export type AccountRef = { platform: AccountPlatform; externalId: string; handle: string; url: string };

/** x.com 下面不是用户名的那些路径 */
const X_RESERVED = new Set(["home", "explore", "search", "notifications", "messages", "settings", "compose", "i", "intent", "share", "hashtag", "login", "logout", "signup", "tos", "privacy", "about", "jobs", "download", "account", "premium", "communities", "lists", "bookmarks", "topics", "who_to_follow"]);

/** instagram.com 下面不是用户名的那些路径 */
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "explore", "stories", "accounts", "direct", "share", "about", "developer", "legal", "privacy", "terms", "web", "api", "challenge", "emails", "press", "directory", "graphql", "oauth", "tags", "locations", "popular", "session", "ar", "audio"]);

/** 链接是不是一个账号的主页（纯函数，不发请求）。 */
function accountRef(site: Site, url: URL): AccountRef | null {
  const path = url.pathname;
  if (site === "x") {
    const m = /^\/(\w{1,15})(?:\/(?:with_replies|media|highlights|articles|likes|affiliates|superfollows))?\/?$/.exec(path);
    if (!m || X_RESERVED.has(m[1].toLowerCase())) return null;
    return { platform: "x", externalId: m[1].toLowerCase(), handle: `@${m[1]}`, url: `https://x.com/${m[1]}` };
  }
  if (site === "tiktok") {
    const m = /^\/@([\w.-]{1,40})\/?$/.exec(path);
    return m && m[1] !== "_" ? { platform: "tiktok", externalId: m[1].toLowerCase(), handle: `@${m[1]}`, url: `https://www.tiktok.com/@${m[1]}` } : null;
  }
  if (site === "douyin") {
    // sec_uid 是一串 Base64 样子的字（MS4wLjABAAAA…）；`/user/self` 是「我自己」，不是某个账号
    const m = /^\/(?:share\/)?user\/(MS4w[\w-]{20,120})\/?$/.exec(path);
    return m ? { platform: "douyin", externalId: m[1], handle: "", url: `https://www.douyin.com/user/${m[1]}` } : null;
  }
  if (site === "xiaohongshu") {
    // 主页链接里的 xsec_token 是这次分享的口令，不留（列作品不用它）
    const m = /xhslink\.com$/i.test(url.hostname) ? null : /^\/user\/profile\/([0-9a-f]{24})\/?$/i.exec(path);
    return m ? { platform: "xiaohongshu", externalId: m[1].toLowerCase(), handle: "", url: `https://www.xiaohongshu.com/user/profile/${m[1].toLowerCase()}` } : null;
  }
  if (site === "instagram") {
    const m = /^\/([\w.]{1,30})(?:\/(?:reels|tagged|feed|guides|channel|saved))?\/?$/.exec(path);
    if (!m || IG_RESERVED.has(m[1].toLowerCase())) return null;
    return { platform: "instagram", externalId: m[1].toLowerCase(), handle: `@${m[1]}`, url: `https://www.instagram.com/${m[1]}/` };
  }
  if (site === "youtube") {
    if (/youtu\.be$/i.test(url.hostname)) return null;
    const tab = "(?:\\/(?:videos|shorts|streams|featured|playlists|community|posts|about|live|podcasts|releases))?\\/?$";
    const at = new RegExp(`^\\/@([^/?#\\s]{1,100})${tab}`).exec(path);
    if (at) {
      // 名字可以不是英文（地址里是转义过的）
      let name = at[1];
      try {
        name = decodeURIComponent(at[1]);
      } catch {
        // 转义不对：原样用
      }
      return { platform: "youtube", externalId: `@${name.toLowerCase()}`, handle: `@${name}`, url: `https://www.youtube.com/@${encodeURIComponent(name)}` };
    }
    const id = new RegExp(`^\\/channel\\/(UC[\\w-]{22})${tab}`).exec(path);
    if (id) return { platform: "youtube", externalId: id[1], handle: "", url: `https://www.youtube.com/channel/${id[1]}` };
    const legacy = new RegExp(`^\\/(c|user)\\/([\\w.-]{1,100})${tab}`).exec(path);
    return legacy ? { platform: "youtube", externalId: `${legacy[1]}/${legacy[2].toLowerCase()}`, handle: "", url: `https://www.youtube.com/${legacy[1]}/${legacy[2]}` } : null;
  }
  return null;
}

/** B 站 UP 主的主页（B 站不在「认得的平台」里，单独认）。 */
function bilibiliAccount(url: URL): AccountRef | null {
  const host = url.hostname.toLowerCase();
  const m =
    host === "space.bilibili.com"
      ? /^\/(\d{1,20})(?:\/(?:video|upload\/video|dynamic|article|audio|channel\/[\w/]+|favlist|bangumi|lists))?\/?$/.exec(url.pathname)
      : /(^|\.)bilibili\.com$/.test(host)
        ? /^\/space\/(\d{1,20})\/?$/.exec(url.pathname)
        : null;
  return m ? { platform: "bilibili", externalId: m[1], handle: "", url: `https://space.bilibili.com/${m[1]}` } : null;
}

/** 链接直接认得出是哪个账号的主页时返回它（短链要跟跳转，用 resolveTarget）。 */
export function parseAccountLink(raw: string): AccountRef | null {
  const url = toUrl(raw);
  if (!url) return null;
  const site = platformOfHost(url.hostname);
  if (!site) return bilibiliAccount(url);
  return siteRef(site, url) ? null : accountRef(site, url);
}

/**
 * 链接里直接认得出帖子的返回 ref；是认得的平台但认不出帖子（短链、主页、搜索页）返回 null。
 * 别的站一律是「网页」；指向本机 / 内网的地址返回 null。
 */
export function parseLink(raw: string): LinkRef | null {
  const url = toUrl(raw);
  if (!url) return null;
  const site = platformOfHost(url.hostname);
  return site ? siteRef(site, url) : webRef(url);
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

const NOT_A_POST: Record<Site, string> = {
  xiaohongshu: "没认出这是哪篇笔记：在小红书里点「分享 → 复制链接」，把复制到的内容整段贴进来",
  douyin: "没认出这是哪个视频：在抖音里点「分享 → 复制链接」，把复制到的内容整段贴进来",
  tiktok: "没认出这是哪个视频：在 TikTok 里点「分享 → 复制链接」再贴进来（主页、话题页读不了）",
  instagram: "没认出这是哪个帖子：在 Instagram 里点「分享 → 复制链接」再贴进来（要帖子或 Reels 的链接，主页和快拍读不了）",
  youtube: "没认出这是哪个视频：贴视频页面的链接（youtube.com/watch?v=… 或 youtu.be/…），频道主页和播放列表读不了",
  x: "没认出这是哪条帖子：在 X 里点「分享 → 复制链接」再贴进来（x.com/…/status/… 这样的链接，主页读不了）",
  reddit: "没认出这是哪个帖子：在 Reddit 里点「分享 → 复制链接」再贴进来（要帖子的链接，版块主页、用户主页读不了）",
};
const X_ARTICLE_LINK = "这是 X 长文本身的链接，读不了：在 X 里打开发这篇长文的那条帖子，点「分享 → 复制链接」贴帖子的链接（x.com/…/status/…），长文的全文会一起读到";
const SHORT_LINK_LABEL: Record<Site, string> = { xiaohongshu: "小红书", douyin: "抖音", tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X", reddit: "Reddit" };

const MAX_HOPS = 5;

export type LinkTarget = { kind: "post"; ref: LinkRef } | { kind: "account"; ref: AccountRef };

type FetchImpl = (service: string, input: string, init?: RequestInit) => Promise<Response>;

/**
 * 认出一条链接指向哪篇帖子，或者哪个账号的主页；短链跟着跳转走（最多 5 跳，每一跳都得在这个平台自己的域名上，不跟去别处）。
 * 不是认得的平台就当网页（不发请求）。认不出抛 LinkError，message 直接给用户看。
 */
export async function resolveTarget(raw: string, fetchImpl: FetchImpl = labeledFetch): Promise<LinkTarget> {
  let current = toUrl(raw);
  if (!current) throw new LinkError("这不是一条链接");
  const site = platformOfHost(current.hostname);
  if (!site) {
    const account = bilibiliAccount(current) ?? (await bilibiliShortLink(current, fetchImpl));
    if (account) return { kind: "account", ref: account };
    const ref = webRef(current);
    if (!ref) throw new LinkError("这个地址读不了（指向本机或内网）");
    return { kind: "post", ref };
  }
  // 长文的链接（x.com/i/article/<长文 id>）：这个 id 不是帖子的，没登录查不到是哪条帖子发的，不用去跟跳转
  if (site === "x" && /^\/i\/article\/\d+/.test(current.pathname)) throw new LinkError(X_ARTICLE_LINK);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const ref = siteRef(site, current);
    if (ref) return { kind: "post", ref };
    const account = accountRef(site, current);
    if (account) return { kind: "account", ref: account };
    if (hop === MAX_HOPS) break;
    const res = await fetchImpl(`${SHORT_LINK_LABEL[site]}短链`, current.href, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": MOBILE_UA, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(10_000),
    });
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (res.status < 300 || res.status >= 400 || !location) break;
    const next = toUrl(new URL(location, current).href);
    if (!next || platformOfHost(next.hostname) !== site) break;
    current = next;
  }
  throw new LinkError(NOT_A_POST[site]);
}

/**
 * B 站的短链（b23.tv/…）：App 里分享视频、分享主页给的都是它。跟一次跳转，落在 UP 主的主页上才算账号；
 * 别的（视频、专栏…）、跳不动的都返回 null，调用方照旧按网页处理这条短链。
 */
async function bilibiliShortLink(url: URL, fetchImpl: FetchImpl): Promise<AccountRef | null> {
  if (!/^(b23\.tv|bili2233\.cn)$/i.test(url.hostname)) return null;
  try {
    const res = await fetchImpl("B 站短链", url.href, { method: "GET", redirect: "manual", headers: { "user-agent": MOBILE_UA, accept: "text/html,*/*" }, signal: AbortSignal.timeout(10_000) });
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    const next = res.status >= 300 && res.status < 400 && location ? toUrl(new URL(location, url).href) : null;
    return next ? bilibiliAccount(next) : null;
  } catch {
    return null;
  }
}

/**
 * 认出一条链接指向哪篇帖子（账号的主页不算：抛 LinkError）。跟着读别的帖子提到的链接时用这个。
 * B 站的主页例外：它不是认得的平台，照旧当网页。
 */
export async function resolveLink(raw: string, fetchImpl: FetchImpl = labeledFetch): Promise<LinkRef> {
  const target = await resolveTarget(raw, fetchImpl);
  if (target.kind === "post") return target.ref;
  if (target.ref.platform !== "bilibili") throw new LinkError(NOT_A_POST[target.ref.platform]);
  const ref = parseLink(target.ref.url);
  if (!ref) throw new LinkError("这个地址读不了（指向本机或内网）");
  return ref;
}
