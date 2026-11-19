/**
 * 「在手机的 Safari 里读网页」：服务器读不到的网页（微信公众号会对服务器和机房 IP 要求先过验证），
 * 在 Safari 里是能看的。一个快捷指令从 Safari 的分享菜单拿到当前网页，跑 captureScript 取出标题、正文、配图、作者、发布时间，
 * 编码后打开 `/share#page=…`；确认页把它交给 savePage（lib/vault/service.ts）存成一条链接内容，后台不再去抓这个网页。
 *
 * 内容放在 # 片段里，不放在查询参数里：片段不发给服务器，一篇长文几十 KB 也不会撞上请求头的长度上限；
 * 确认页在浏览器里解开，再用表单提交。片段里是 Base64（URL 安全写法），原因同 lib/vault/shortcut.ts。
 *
 * 这个文件页面（客户端）和服务器都要用：不能引入 server-only 的模块。
 */

export type PageCapture = {
  /** 网页地址（Safari 当时打开的） */
  url: string;
  title: string;
  /** 正文（页面上显示的文字） */
  text: string;
  description: string;
  /** 题图（og:image） */
  cover: string | null;
  /** 正文里的配图，按出现顺序 */
  images: string[];
  author: string;
  /** 站点名；公众号是公众号的名字 */
  site: string;
  publishedAt: string | null;
};

/** 正文最多留这么多字：和服务器自己读网页时一样（lib/sources/web.ts 的 WEB_TEXT_MAX） */
export const CAPTURE_TEXT_MAX = 30_000;
/** 配图最多带这么多张地址（存的时候再挑） */
export const CAPTURE_IMAGES_MAX = 20;
const FIELD_MAX = 2_000;

export const CAPTURE_PREFIX = "page=";
export const CAPTURE_ERROR_PREFIX = "error=";

const str = (v: unknown, max = FIELD_MAX): string => (typeof v === "string" ? Array.from(v.trim()).slice(0, max).join("") : "");

function httpUrl(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** 收到的内容整理成 PageCapture：不认识的字段丢掉，长度截到上限。没有网页地址、或者标题正文都没有，返回 null。 */
export function readCapture(raw: unknown): PageCapture | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const url = httpUrl(o.url);
  if (!url) return null;
  const text = str(o.text, CAPTURE_TEXT_MAX);
  const title = str(o.title, 500);
  if (!text && !title) return null;
  const images = Array.isArray(o.images) ? [...new Set(o.images.map(httpUrl).filter((u): u is string => u !== null))].slice(0, CAPTURE_IMAGES_MAX) : [];
  const published = str(o.publishedAt, 64);
  const t = published ? Date.parse(published) : NaN;
  return {
    url,
    title,
    text,
    description: str(o.description),
    cover: httpUrl(o.cover),
    images,
    author: str(o.author, 200),
    site: str(o.site, 200),
    publishedAt: Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null,
  };
}

export type HashCapture = { kind: "page"; capture: PageCapture } | { kind: "error"; message: string } | { kind: "unreadable" } | null;

function decodeBase64Url(raw: string): string | null {
  const b64 = raw.replace(/[\s]/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!b64 || !/^[A-Za-z0-9+/]+$/.test(b64) || b64.length % 4 === 1) return null;
  try {
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 解开确认页地址的 # 片段。null = 片段里没有网页内容（不是从这个快捷指令来的）；
 * unreadable = 有内容但解不开（多半是地址太长被截断了），页面上要说「收到了但不完整」，不能当成没收到。
 */
export function decodeCaptureHash(hash: string): HashCapture {
  const h = hash.replace(/^#/, "");
  if (h.startsWith(CAPTURE_ERROR_PREFIX)) {
    let message = h.slice(CAPTURE_ERROR_PREFIX.length);
    try {
      message = decodeURIComponent(message);
    } catch {
      // 原样显示
    }
    return { kind: "error", message: message.slice(0, 300) || "没说原因" };
  }
  if (!h.startsWith(CAPTURE_PREFIX)) return null;
  const json = decodeBase64Url(h.slice(CAPTURE_PREFIX.length));
  if (json === null) return { kind: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: "unreadable" };
  }
  const capture = readCapture(parsed);
  return capture ? { kind: "page", capture } : { kind: "unreadable" };
}

/**
 * 要在 Safari 里读的网站：服务器自己读不了的（微信公众号对服务器和机房 IP 要求先过验证）。
 * 别的网站在 Safari 里分享时只交链接，和普通的分享一样：小红书、抖音这些有专门的读法，读到的比页面上显示的全；
 * 普通网页服务器能读，也不用把整页塞进地址里（太长会被截断）。以后发现别的站服务器读不了，加在这里。
 */
export const BROWSER_READ_HOSTS = ["mp.weixin.qq.com"];

/**
 * 快捷指令「在网页上运行 JavaScript」（Run JavaScript on Webpage）里放的脚本：在 Safari 当前的网页里跑，
 * 最后 completion(要打开的地址)。地址按当前站点填好（origin），用户整段复制过去。
 *
 * - 不在 BROWSER_READ_HOSTS 里的网站：只交链接，打开 `/share?b64=<网页地址>`（和普通的分享同一条路，见 shortcut.ts）。
 * - 微信公众号按它的页面结构取：正文 #js_content、标题 #activity-name、公众号名 #js_name、作者 meta author，
 *   发布时间在页面脚本里（var ct = "秒数" 或 createTime = '2026-11-10 18:19'，北京时间）；配图的地址在 data-src 里。
 *   打开 `/share#page=<内容>`。
 * - 出错时打开 `/share#error=原因`，确认页上把原因显示出来。
 *
 * 只用老一点的语法（var、function），不同 iOS 版本的快捷指令都能跑。
 */
export function captureScript(origin: string): string {
  const share = `${origin.replace(/\/+$/, "")}/share`;
  // 每句都以分号结尾、注释用 /* */：复制时换行丢了也还能跑
  return `/* 存入 Vault：在 Safari 里分享网页（从 Vault 的「手机」页复制，地址已经填好） */
var VAULT = ${JSON.stringify(share)};
var READ = ${JSON.stringify(BROWSER_READ_HOSTS)};
var b64 = function (str) {
  var bytes = new TextEncoder().encode(str);
  var bin = "";
  for (var k = 0; k < bytes.length; k += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
  return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
};
try {
  if (READ.indexOf(location.hostname) < 0) {
    completion(VAULT + "?b64=" + b64(location.href));
  } else {
    var d = document;
    var meta = function (n) {
      var e = d.querySelector('meta[property="' + n + '"]') || d.querySelector('meta[name="' + n + '"]');
      return e ? (e.getAttribute("content") || "").trim() : "";
    };
    var shown = function (e) {
      if (!e) return "";
      var t = (e.innerText || "").trim();
      return t || (e.textContent || "").replace(/[ \\t]+/g, " ").trim();
    };
    var wx = location.hostname === "mp.weixin.qq.com";
    var root = (wx && d.querySelector("#js_content")) || d.querySelector("article") || d.querySelector("main") || d.body;
    var text = shown(root).replace(/\\n{3,}/g, "\\n\\n").slice(0, ${CAPTURE_TEXT_MAX});
    var images = [];
    var imgs = root ? root.querySelectorAll("img") : [];
    for (var i = 0; i < imgs.length && images.length < ${CAPTURE_IMAGES_MAX}; i++) {
      var src = imgs[i].getAttribute("data-src") || imgs[i].currentSrc || imgs[i].src || "";
      if (/^https?:/i.test(src) && images.indexOf(src) < 0) images.push(src);
    }
    var published = meta("article:published_time") || meta("og:article:published_time") || meta("datePublished") || meta("pubdate") || "";
    if (wx && !published) {
      var scripts = d.querySelectorAll("script");
      for (var j = 0; j < scripts.length && !published; j++) {
        var s = scripts[j].textContent || "";
        var ct = /\\bvar\\s+ct\\s*=\\s*["'](\\d{9,11})["']/.exec(s);
        var made = /\\bcreateTime\\s*=\\s*["'](\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})["']/.exec(s);
        if (ct) published = new Date(Number(ct[1]) * 1000).toISOString();
        else if (made) published = made[1].replace(" ", "T") + ":00+08:00";
      }
    }
    var page = {
      url: location.href,
      title: (wx && shown(d.querySelector("#activity-name"))) || meta("og:title") || d.title || "",
      text: text,
      description: meta("og:description") || meta("description"),
      cover: meta("og:image") || meta("twitter:image") || null,
      images: images,
      author: meta("author") || meta("article:author") || "",
      site: (wx && shown(d.querySelector("#js_name"))) || meta("og:site_name") || "",
      publishedAt: published || null
    };
    completion(VAULT + "#${CAPTURE_PREFIX}" + b64(JSON.stringify(page)));
  }
} catch (e) {
  completion(VAULT + "#${CAPTURE_ERROR_PREFIX}" + encodeURIComponent(String((e && e.message) || e)));
}
`;
}
