import { describe, expect, it } from "vitest";
import { CAPTURE_TEXT_MAX, captureScript, decodeCaptureHash, readCapture } from "./page-capture";
import { decodeSharedText } from "./shortcut";

const b64url = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

describe("readCapture", () => {
  it("整理收到的内容：截长度、只留 http(s) 的图片、日期换成 ISO", () => {
    const c = readCapture({
      url: "https://mp.weixin.qq.com/s/abc",
      title: "  标题 ",
      text: "字".repeat(CAPTURE_TEXT_MAX + 10),
      images: ["https://a.com/1.jpg", "https://a.com/1.jpg", "javascript:alert(1)", 3, "data:image/png;base64,xx"],
      cover: "not a url",
      publishedAt: "2026-11-10T18:19:00+08:00",
      extra: "丢掉",
    });
    expect(c).toEqual({
      url: "https://mp.weixin.qq.com/s/abc",
      title: "标题",
      text: "字".repeat(CAPTURE_TEXT_MAX),
      description: "",
      cover: null,
      images: ["https://a.com/1.jpg"],
      author: "",
      site: "",
      publishedAt: "2026-11-10T10:19:00.000Z",
    });
  });

  it("没有网页地址、或者标题正文都没有：不收", () => {
    expect(readCapture({ title: "t", text: "x" })).toBeNull();
    expect(readCapture({ url: "file:///etc/passwd", text: "x" })).toBeNull();
    expect(readCapture({ url: "https://a.com", text: " ", title: "" })).toBeNull();
    expect(readCapture("https://a.com")).toBeNull();
    expect(readCapture({ url: "https://a.com", title: "只有标题", publishedAt: "不是日期" })).toMatchObject({ title: "只有标题", publishedAt: null });
  });
});

describe("decodeCaptureHash", () => {
  it("page=：解开 Base64（URL 安全写法、不带 =）里的 JSON", () => {
    const got = decodeCaptureHash(`#page=${b64url(JSON.stringify({ url: "https://a.com/p", title: "中文标题", text: "正文 ✓" }))}`);
    expect(got).toMatchObject({ kind: "page", capture: { url: "https://a.com/p", title: "中文标题", text: "正文 ✓" } });
  });

  it("截断了 / 不是 JSON / 内容不对：收到了但解不开，和没收到分开", () => {
    const full = b64url(JSON.stringify({ url: "https://a.com/p", title: "标题", text: "正文".repeat(50) }));
    expect(decodeCaptureHash(`#page=${full.slice(0, 41)}`)).toEqual({ kind: "unreadable" });
    expect(decodeCaptureHash(`#page=${b64url("不是 JSON")}`)).toEqual({ kind: "unreadable" });
    expect(decodeCaptureHash(`#page=${b64url("{}")}`)).toEqual({ kind: "unreadable" });
    expect(decodeCaptureHash("#page=")).toEqual({ kind: "unreadable" });
    expect(decodeCaptureHash("")).toBeNull();
    expect(decodeCaptureHash("#section-2")).toBeNull();
  });

  it("error=：快捷指令里出错，把原因带过来", () => {
    expect(decodeCaptureHash(`#error=${encodeURIComponent("TextEncoder is not defined")}`)).toEqual({ kind: "error", message: "TextEncoder is not defined" });
    expect(decodeCaptureHash("#error=%E0%A4%A")).toEqual({ kind: "error", message: "%E0%A4%A" });
  });
});

/** 一个极简的「网页」：只有脚本用到的那几个接口 */
function fakePage(opts: { host: string; href: string; title: string; metas: Record<string, string>; byId: Record<string, string>; tags: Record<string, string>; images: Record<string, string>[]; scripts: string[] }) {
  const el = (text: string) => ({ innerText: text, textContent: text, querySelectorAll: () => opts.images.map((a) => ({ getAttribute: (n: string) => a[n] ?? null, currentSrc: a.currentSrc ?? "", src: a.src ?? "" })) });
  const document = {
    title: opts.title,
    body: el("BODY"),
    querySelector(sel: string) {
      const meta = /^meta\[(?:property|name)="([^"]+)"\]$/.exec(sel);
      if (meta) return sel.includes("property") && opts.metas[`p:${meta[1]}`] ? { getAttribute: () => opts.metas[`p:${meta[1]}`] } : !sel.includes("property") && opts.metas[`n:${meta[1]}`] ? { getAttribute: () => opts.metas[`n:${meta[1]}`] } : null;
      if (sel.startsWith("#")) return opts.byId[sel.slice(1)] !== undefined ? el(opts.byId[sel.slice(1)]) : null;
      return opts.tags[sel] !== undefined ? el(opts.tags[sel]) : null;
    },
    querySelectorAll: () => opts.scripts.map((s) => ({ textContent: s })),
  };
  return { document, location: { hostname: opts.host, href: opts.href } };
}

function run(script: string, page: ReturnType<typeof fakePage>): string {
  let out = "";
  new Function("document", "location", "completion", script)(page.document, page.location, (u: string) => (out = u));
  return out;
}

describe("captureScript", () => {
  const origin = "https://vault.example.com/";

  it("公众号：正文、标题、公众号名取页面上的，配图取 data-src，发布时间取页面脚本里的 ct", () => {
    const page = fakePage({
      host: "mp.weixin.qq.com",
      href: "https://mp.weixin.qq.com/s/icMS29rjuUeKiPdiJyzJAg",
      title: "",
      metas: { "p:og:title": "og 标题", "p:og:image": "https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg", "p:og:description": "简介", "n:author": "张三" },
      byId: { js_content: "AI 能帮你写代码。\n\n\n\n可一旦涉及手机……", "activity-name": "Pinky 开源仅 4 天就斩获 1.6K Star", js_name: "开源星探" },
      tags: {},
      images: [{ "data-src": "https://mmbiz.qpic.cn/a/640?wx_fmt=png", src: "data:image/gif;base64,xx" }, { "data-src": "https://mmbiz.qpic.cn/a/640?wx_fmt=png" }, { src: "https://mmbiz.qpic.cn/b/640" }],
      scripts: ["var x = 1;", 'var ct = "1794392340";'],
    });
    const url = run(captureScript(origin), page);
    expect(url.startsWith("https://vault.example.com/share#page=")).toBe(true);
    const got = decodeCaptureHash(url.slice(url.indexOf("#")));
    expect(got).toEqual({
      kind: "page",
      capture: {
        url: "https://mp.weixin.qq.com/s/icMS29rjuUeKiPdiJyzJAg",
        title: "Pinky 开源仅 4 天就斩获 1.6K Star",
        text: "AI 能帮你写代码。\n\n可一旦涉及手机……",
        description: "简介",
        cover: "https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg",
        images: ["https://mmbiz.qpic.cn/a/640?wx_fmt=png", "https://mmbiz.qpic.cn/b/640"],
        author: "张三",
        site: "开源星探",
        publishedAt: new Date(1794392340 * 1000).toISOString(),
      },
    });
  });

  it("公众号的发布时间只有 createTime（北京时间）时也认", () => {
    const page = fakePage({ host: "mp.weixin.qq.com", href: "https://mp.weixin.qq.com/s/x", title: "t", metas: {}, byId: { js_content: "正文" }, tags: {}, images: [], scripts: ["var createTime = '2026-11-10 18:19';"] });
    const url = run(captureScript(origin), page);
    expect(decodeCaptureHash(url.slice(url.indexOf("#")))).toMatchObject({ kind: "page", capture: { publishedAt: "2026-11-10T10:19:00.000Z" } });
  });

  it("别的网站（小红书、普通网页…）：不读页面，只交链接，走普通分享那条路", () => {
    for (const href of ["https://www.xiaohongshu.com/explore/66aa?xsec_token=AB_c-d", "https://example.com/文章?id=1"]) {
      const host = new URL(href).hostname;
      const page = fakePage({ host, href, title: "页面标题", metas: {}, byId: {}, tags: { article: "正文" }, images: [], scripts: [] });
      const url = run(captureScript(origin), page);
      const prefix = "https://vault.example.com/share?b64=";
      expect(url.startsWith(prefix)).toBe(true);
      expect(decodeSharedText(url.slice(prefix.length))).toBe(href);
    }
  });

  it("出错时把原因带到确认页", () => {
    const url = run(captureScript(origin), { document: null, location: { hostname: "mp.weixin.qq.com", href: "https://mp.weixin.qq.com/s/x" } } as unknown as ReturnType<typeof fakePage>);
    expect(url.startsWith("https://vault.example.com/share#error=")).toBe(true);
    expect(decodeCaptureHash(url.slice(url.indexOf("#")))).toMatchObject({ kind: "error" });
  });
});
