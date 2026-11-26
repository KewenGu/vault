import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { SourceFetchError } from "./types";

vi.mock("./ytdlp", async (orig) => ({ ...(await orig<object>()), ytdlpProbe: vi.fn() }));

import { JINA_COUNT_KEY, WEIXIN_BLOCKED, cleanMarkdown, dropPreamble, fetchWebPage, looksLikeLoginWall, looksLikeVerifyWall, mapCapture, mapJinaData, mapPage, markdownLinks, outboundLinks, parseHtmlPage, readPage, usableImage, type PageRead } from "./web";
import { ytdlpProbe } from "./ytdlp";

const body = "这是一篇讲怎么做内容的长文。".repeat(20);
/** 按 r.jina.ai 真实返回的形状缩出来的（2026-10）。 */
const jinaData = (over: Record<string, unknown> = {}) => ({
  title: "Things we learned about LLMs in 2024",
  description: "A lot has happened.",
  url: "https://simonwillison.net/2024/Dec/31/llms-in-2024/",
  content: `# 标题\n\n![题图](https://static.example.com/a.jpg)\n\n${body}\n\n\n\n见[这篇文章](https://example.com/other)。  \n`,
  publishedTime: "Mon, 05 Oct 2026 21:00:00 GMT",
  images: { "Image 1": "https://static.example.com/a.jpg", "Image 2": "https://static.example.com/logo.png", "Image 3": "/b.png" },
  metadata: { author: "Simon Willison", "og:site_name": "Simon Willison’s Weblog", "og:image": "https://static.example.com/card.jpg", "article:published_time": "2024-12-31T18:07:00+00:00" },
  ...over,
});
const jina = (data: unknown, status = 200) => new Response(JSON.stringify({ code: status, data }), { status });
const ref = { platform: "web" as const, externalId: "h", url: "https://simonwillison.net/2024/Dec/31/llms-in-2024/" };
const page = (over: Partial<PageRead> = {}): PageRead => ({ title: "标题", description: "摘要", text: body, cover: null, images: [], author: "", site: "", publishedAt: null, via: "jina", ...over });

const noVideo = { info: null, failed: null };
beforeEach(() => vi.mocked(ytdlpProbe).mockReset().mockResolvedValue(noVideo));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("收藏夹：读网页", () => {
  it("正文开头的站点导航去掉：从和文章标题对得上的那行标题后面开始；对不上、剩得太少就不动", () => {
    const body = "正文第一段。".repeat(40);
    const page = `# Simon’s Weblog\n\nSubscribe\n\n**Sponsored by:** 某某\n\n## Things we learned about LLMs in 2024\n\n31st December 2024\n\n${body}`;
    expect(dropPreamble(page, "Things we learned about LLMs in 2024")).toBe(`31st December 2024\n\n${body}`);
    // 页面标题带「 | 站名」：认文章标题那一行，不认站名那一行
    expect(dropPreamble(page, "Things we learned about LLMs in 2024 | Simon’s Weblog")).toBe(`31st December 2024\n\n${body}`);
    // 下面一行 === 的标题写法也认
    expect(dropPreamble(`导航 首页 关于\n\n为什么要写作\n==========\n\n${body}`, "为什么要写作")).toBe(body);
    expect(dropPreamble(page, "完全不相干的标题")).toBe(page);
    expect(dropPreamble("# 短文\n\n就一句话。", "短文")).toBe("# 短文\n\n就一句话。");
    expect(dropPreamble(page, "")).toBe(page);
  });

  it("Markdown 正文收拾干净：图片去掉、链接只留文字、多余空行压掉", () => {
    expect(cleanMarkdown("# 标题\n\n![图](https://a/b.jpg)\n\n正文见[这里](https://a.com/x)。  \n\n\n\n下一段")).toBe("# 标题\n\n正文见这里。\n\n下一段");
  });

  it("能当配图的地址：http(s)、不是矢量图 / 动图 / 图标、不像 logo 头像；相对地址按页面补全", () => {
    expect(usableImage("/img/a.png", "https://a.com/post/1")).toBe("https://a.com/img/a.png");
    expect(usableImage("https://a.com/a.JPG?w=800")).toBe("https://a.com/a.JPG?w=800");
    for (const bad of ["", "https://a.com/logo.png", "https://a.com/x.svg", "https://a.com/x.gif", "https://a.com/avatar/1.jpg", "data:image/png;base64,AAAA", "不是地址"]) expect(usableImage(bad)).toBeNull();
  });

  it("Jina 的返回 → 网页：作者 / 站名 / 题图从元数据取；发布时间只认页面写的（Jina 自己的那个是「现在」）", () => {
    expect(mapJinaData(jinaData(), ref.url)).toEqual({
      title: "Things we learned about LLMs in 2024",
      description: "A lot has happened.",
      text: `# 标题\n\n${body}\n\n见这篇文章。`,
      cover: "https://static.example.com/card.jpg",
      images: ["https://static.example.com/a.jpg", "https://simonwillison.net/b.png"],
      author: "Simon Willison",
      site: "Simon Willison’s Weblog",
      publishedAt: "2024-12-31T18:07:00.000Z",
      links: [{ text: "这篇文章", url: "https://example.com/other" }],
      via: "jina",
    });
    expect(mapJinaData(jinaData({ metadata: { author: "https://facebook.com/someone" } }), ref.url)).toMatchObject({ author: "", publishedAt: null, cover: null });
    // 目标网页本身打不开时 Jina 照样返回 200，只在 warning 里说
    expect(mapJinaData(jinaData({ warning: "Target URL returned error 403: Forbidden" }), ref.url)).toBeNull();
    expect(mapJinaData({ title: "没有正文" }, ref.url)).toBeNull();
  });

  it("自己抓的 HTML → 网页：正文取 <article>，去掉脚本 / 导航 / 页脚，实体解码；元数据两种属性顺序都认", () => {
    const html = `<html><head><title> 页面标题 &amp; 副标题 </title>
      <meta property="og:title" content="文章标题">
      <meta content="文章摘要 &quot;引号&quot;" name="description">
      <meta property="og:image" content="/card.jpg"><meta property="og:site_name" content="某站">
      <meta name="author" content="张三"><meta property="article:published_time" content="2026-09-01T08:00:00+08:00">
      </head><body><nav>导航 首页</nav><article><h1>文章标题</h1><p>第一段&nbsp;内容。</p><script>var a = "<p>不要</p>";</script>
      <p>第二段 &#8212; 完。</p><img src="/img/1.jpg"><img src="/img/1.jpg"><img src="/logo.svg"><footer>页脚</footer></article><p>文章外面的</p></body></html>`;
    expect(parseHtmlPage(html, "https://blog.example.com/p/1")).toEqual({
      title: "文章标题",
      description: '文章摘要 "引号"',
      text: "文章标题\n第一段 内容。\n\n第二段 — 完。",
      cover: "https://blog.example.com/card.jpg",
      images: ["https://blog.example.com/img/1.jpg"],
      author: "张三",
      site: "某站",
      publishedAt: "2026-09-01T00:00:00.000Z",
      links: [],
      via: "direct",
    });
    // 没有 article / main：取 body；没有 og:title 用 <title>；发布时间认 JSON-LD
    expect(parseHtmlPage('<html><head><title>只有 title</title><script type="application/ld+json">{"datePublished": "2026-01-02"}</script></head><body><p>正文</p></body></html>', "https://a.com/")).toMatchObject({
      title: "只有 title",
      text: "正文",
      publishedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("读正文：有密钥先带密钥问 Jina（成功记一笔 jina_fetch）", async () => {
    vi.stubEnv("JINA_API_KEY", "jina_secret");
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jina(jinaData()));
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    const read = await meterInto(counts, () => readPage(ref.url));
    expect(read).toMatchObject({ title: "Things we learned about LLMs in 2024", via: "jina" });
    expect(counts).toEqual({ [JINA_COUNT_KEY]: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://r.jina.ai/${ref.url}`);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer jina_secret", "x-return-format": "markdown" });
  });

  it("读正文：密钥欠费 / 限流 → 不带密钥再问一次（不记账）；Jina 读不出 → 自己抓网页", async () => {
    vi.stubEnv("JINA_API_KEY", "jina_secret");
    const broke = vi.fn(async (_url: string, init?: RequestInit) => ((init?.headers as Record<string, string>).authorization ? jina(null, 402) : jina(jinaData())));
    vi.stubGlobal("fetch", broke);
    const counts: Record<string, number> = {};
    expect(await meterInto(counts, () => readPage(ref.url))).toMatchObject({ via: "jina" });
    expect(broke).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({});

    // Jina 说目标网页打不开（带密钥那次算了钱）：不再问 Jina，直接自己抓
    const html = `<html><head><title>直接抓到的</title></head><body><article>${body}</article></body></html>`;
    const direct = vi.fn(async (url: string) => (url.startsWith("https://r.jina.ai/") ? jina(jinaData({ warning: "Target URL returned error 403" })) : new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })));
    vi.stubGlobal("fetch", direct);
    expect(await meterInto(counts, () => readPage(ref.url))).toMatchObject({ title: "直接抓到的", via: "direct" });
    expect(direct.mock.calls.map((c) => c[0])).toEqual([`https://r.jina.ai/${ref.url}`, ref.url]);
    expect(counts).toEqual({ [JINA_COUNT_KEY]: 1 });
  });

  it("读正文：没配密钥直接不带密钥问；哪条路都没读出正文是 null", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (url.startsWith("https://r.jina.ai/") ? jina(jinaData({ content: "太短", description: "" })) : new Response("<html><body><p>短</p></body></html>")));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readPage(ref.url)).toBeNull();
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBeUndefined();
    // 网络不通也是 null（不抛）
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await readPage(ref.url)).toBeNull();
  });

  it("网页 → 帖子：类型是文章，没有互动数；题图在前、最多 6 张；作者写成「作者 · 站名」；太长截到 3 万字", () => {
    const post = mapPage(page({ cover: "https://a.com/card.jpg", images: ["https://a.com/1.jpg", "https://a.com/card.jpg", ...Array.from({ length: 8 }, (_, i) => `https://a.com/x${i}.jpg`)], author: "Simon", site: "Weblog", publishedAt: "2024-12-31T18:07:00.000Z" }), ref);
    expect(post).toMatchObject({
      platform: "web",
      externalId: "h",
      kind: "article",
      title: "标题",
      text: body,
      author: { id: null, name: "Simon · Weblog" },
      publishedAt: "2024-12-31T18:07:00.000Z",
      stats: { views: null, likes: null, collects: null, comments: null, shares: null },
      video: null,
      notes: ["网页没有点赞、评论这些数字，只能从内容本身判断它好在哪"],
    });
    expect(post.images.map((i) => i.url)).toEqual(["https://a.com/card.jpg", "https://a.com/1.jpg", "https://a.com/x0.jpg", "https://a.com/x1.jpg", "https://a.com/x2.jpg", "https://a.com/x3.jpg"]);
    const long = mapPage(page({ text: "字".repeat(30_500), title: "", via: "direct" }), ref);
    expect(long.text).toHaveLength(30_000);
    expect(long.title).toBe("simonwillison.net");
    expect(long.author.name).toBe("simonwillison.net");
    expect(long.notes).toEqual(["网页没有点赞、评论这些数字，只能从内容本身判断它好在哪", "文章很长，只读了前 3 万字", "正文是直接从网页里取的，可能夹着导航、广告的文字"]);
  });

  it("读到的是登录页（标题带「登录 / Log in」、文字不长）：不当文章收", () => {
    expect(looksLikeLoginWall({ title: "Threads • Log in", text: "Log in with your Instagram account" })).toBe(true);
    expect(looksLikeLoginWall({ title: "知乎 - 登录", text: "登录后查看全部内容" })).toBe(true);
    expect(looksLikeLoginWall({ title: "How to log in to anything", text: "x".repeat(5000) })).toBe(false);
    expect(looksLikeLoginWall({ title: "Blogging is fun", text: "short" })).toBe(false);
  });

  it("读一个链接：本机的 yt-dlp 认得是视频页就按视频收；否则按文章读；读不出 / 是登录页报给用户", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jina(jinaData())));
    expect(await fetchWebPage(ref)).toMatchObject({ kind: "article", title: "Things we learned about LLMs in 2024", author: { name: "Simon Willison · Simon Willison’s Weblog" } });

    const info = { id: "BV1", title: "", description: "简介", uploader: "UP主", uploaderId: null, durationS: 272.5, publishedAt: null, views: 10, likes: 2, comments: null, shares: null, thumbnail: null, width: 1920, height: 1080, tags: [], extractor: "BiliBili", isLive: false };
    vi.mocked(ytdlpProbe).mockResolvedValue({ info, failed: null });
    const video = await fetchWebPage({ ...ref, url: "https://www.bilibili.com/video/BV1" });
    expect(video).toMatchObject({ platform: "web", externalId: "h", kind: "video", title: "www.bilibili.com", video: { url: "https://www.bilibili.com/video/BV1", via: "ytdlp" }, stats: { views: 10, likes: 2 } });
    // 直播、没有时长的不按视频收：照常读网页
    vi.mocked(ytdlpProbe).mockResolvedValue({ info: { ...info, isLive: true }, failed: null });
    expect((await fetchWebPage(ref)).kind).toBe("article");
    // yt-dlp 出错不影响读网页
    vi.mocked(ytdlpProbe).mockRejectedValue(new Error("yt-dlp 的 Python 依赖无法加载"));
    expect((await fetchWebPage(ref)).kind).toBe("article");

    vi.mocked(ytdlpProbe).mockResolvedValue(noVideo);
    vi.stubGlobal("fetch", vi.fn(async () => jina(jinaData({ title: "Threads • Log in", content: "Log in to see this post. ".repeat(20) }))));
    await expect(fetchWebPage(ref)).rejects.toThrow("这个网页要登录才能看（读到的是登录页）。把内容复制下来贴进来直接分析");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchWebPage(ref)).rejects.toThrow(SourceFetchError);
    await expect(fetchWebPage({ ...ref, url: "http://127.0.0.1/admin" })).rejects.toThrow("这个地址读不了（指向本机或内网）");
  });
});

describe("服务器读不到的网页（微信公众号）", () => {
  const wx = { platform: "web" as const, externalId: "w", url: "https://mp.weixin.qq.com/s/icMS29rjuUeKiPdiJyzJAg" };
  /** 2026-11-19 从云服务器读一篇公众号文章：Jina 和直接请求拿到的都是这个验证页（缩短了） */
  const verifyJina = {
    title: "Weixin Official Accounts Platform",
    description: "",
    url: wx.url,
    content: "## 环境异常\n\n当前环境异常，完成验证后即可继续访问。\n\n[去验证](https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x)\n\n: ，.Video Mini Program Like，轻点两下取消赞 Wow，轻点两下取消在看",
    warning: "This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.",
    metadata: {},
  };
  const verifyHtml = `<html><head><title></title></head><body class="zh_CN"><div class="weui-msg"><div class="weui-msg__text-area"><h2 class="weui-msg__title">环境异常</h2><p class="weui-msg__desc">当前环境异常，完成验证后即可继续访问。</p></div><a href="#">去验证</a></div>${"<p>轻点两下取消赞</p>".repeat(30)}</body></html>`;

  it("Jina 说要过验证码的不算读到了", () => {
    expect(mapJinaData(verifyJina, wx.url)).toBeNull();
  });

  it("读到的是验证页：认出来，公众号告诉用户在 Safari 里读，别的站说要过人机验证", async () => {
    expect(looksLikeVerifyWall(parseHtmlPage(verifyHtml, wx.url))).toBe(true);
    expect(looksLikeVerifyWall({ title: "讲安全验证的长文", text: "完成验证".repeat(1000) })).toBe(false);
    expect(looksLikeVerifyWall(page())).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).startsWith("https://r.jina.ai/") ? jina(verifyJina) : new Response(verifyHtml, { headers: { "content-type": "text/html" } }))));
    await expect(fetchWebPage(wx)).rejects.toThrow(WEIXIN_BLOCKED);
    await expect(fetchWebPage({ ...ref, url: "https://example.com/post" })).rejects.toThrow("这个网页要先过人机验证，服务器读不了。把内容复制下来贴进来直接分析");
    // 什么都没读到也一样：公众号给它专门的说法
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchWebPage(wx)).rejects.toThrow(WEIXIN_BLOCKED);
  });

  it("在 Safari 里读到的网页 → 文章：配图照样挑过，备注说明是在手机上读的", () => {
    const post = mapCapture(
      {
        url: wx.url,
        title: "Pinky 开源仅 4 天就斩获 1.6K Star",
        text: body,
        description: "摘要",
        cover: "https://mmbiz.qpic.cn/sz_mmbiz_jpg/abc/0?wx_fmt=jpeg",
        images: ["https://mmbiz.qpic.cn/sz_mmbiz_png/def/640?wx_fmt=png", "https://res.wx.qq.com/a/icon.png", "https://mmbiz.qpic.cn/x/anim.gif"],
        author: "",
        site: "开源星探",
        publishedAt: "2026-11-10T10:19:00.000Z",
      },
      wx
    );
    expect(post).toMatchObject({ kind: "article", title: "Pinky 开源仅 4 天就斩获 1.6K Star", text: body, author: { name: "开源星探" }, publishedAt: "2026-11-10T10:19:00.000Z" });
    expect(post.images.map((i) => i.url)).toEqual(["https://mmbiz.qpic.cn/sz_mmbiz_jpg/abc/0?wx_fmt=jpeg", "https://mmbiz.qpic.cn/sz_mmbiz_png/def/640?wx_fmt=png"]);
    expect(post.notes).toContain("服务器读不到这个网页，内容是在手机的 Safari 里读的：正文和配图是当时页面上显示的");
    // 正文没取到时用简介
    expect(mapCapture({ url: wx.url, title: "t", text: "", description: "只有简介", cover: null, images: [], author: "", site: "", publishedAt: null }, wx).text).toBe("只有简介");
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));

describe("正文里的链接（溯源用）", () => {
  const page = "https://blog.example.com/posts/fast-attention";

  it("Markdown 正文换成纯文字之前把外链收下来：同站的、图片的、分享按钮的不算，去重", () => {
    const md = [
      "[首页](/) · [关于](https://www.blog.example.com/about)",
      "![题图](https://cdn.example.net/cover.png)",
      "据 [**FlashAttention-9**](https://arxiv.org/abs/2611.01234#abstract \"论文\") 的结果，代码在 [https://github.com/acme/flash9](https://github.com/acme/flash9)。",
      "又见[这篇论文](https://arxiv.org/abs/2611.01234)。[分享到 X](https://twitter.com/intent/tweet?url=x) [邮件](mailto:a@example.com)",
    ].join("\n");
    expect(markdownLinks(md, page)).toEqual([
      { text: "FlashAttention-9", url: "https://arxiv.org/abs/2611.01234" },
      { text: "", url: "https://github.com/acme/flash9" },
    ]);
    // 正文照旧是纯文字
    expect(cleanMarkdown(md)).not.toContain("arxiv.org");
  });

  it("Jina 读到的网页带着链接；并成帖子时留着", () => {
    const read = mapJinaData({ title: "T", content: "正文见 [原文](https://openai.com/index/x)。" + "字".repeat(300) }, page)!;
    expect(read.links).toEqual([{ text: "原文", url: "https://openai.com/index/x" }]);
    expect(mapPage(read, { platform: "web", externalId: "e", url: page }).links).toEqual([{ text: "原文", url: "https://openai.com/index/x" }]);
  });

  it("自己抓的 HTML 也收正文区域里的外链（导航、页脚里的不收）", () => {
    const html = `<html><body><nav><a href="https://other.example/nav">导航</a></nav><article><p>据 <a class="x" href="https://arxiv.org/abs/2611.01234"><b>论文</b></a> 和 <a href="/local">站内</a>。</p></article></body></html>`;
    expect(parseHtmlPage(html, page).links).toEqual([{ text: "论文", url: "https://arxiv.org/abs/2611.01234" }]);
  });

  it("最多留 80 条；页面地址不对时不收", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ text: `l${i}`, url: `https://ref${i}.example/` }));
    expect(outboundLinks(many, page)).toHaveLength(80);
    expect(outboundLinks(many, "不是地址")).toEqual([]);
  });

  it("yt-dlp 认出这是视频、但没读到：照样按网页读，并说清楚是哪一步没成、这次少了什么（不悄悄当成一篇普通的网页）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jina(jinaData())));
    vi.mocked(ytdlpProbe).mockResolvedValue({ info: null, failed: { extractor: "BiliBili", why: "对方回了 HTTP 412（多半是这台服务器的 IP 被那个站拦了）" } });
    const post = await fetchWebPage({ ...ref, url: "https://www.bilibili.com/video/BV1ar421p7kw" });
    expect(post.kind).toBe("article");
    expect(post.notes[0]).toBe("这个链接是一个视频（BiliBili），这台服务器上的 yt-dlp 没读到：对方回了 HTTP 412（多半是这台服务器的 IP 被那个站拦了）。这次只按网页读了页面上的字，视频的画面和里面说的话都没读到");
    // 跑到超时的：不知道是哪个站，照样说
    vi.mocked(ytdlpProbe).mockResolvedValue({ info: null, failed: { extractor: "", why: "45 秒没读完" } });
    expect((await fetchWebPage(ref)).notes[0]).toMatch(/^这个链接是一个视频，这台服务器上的 yt-dlp 没读到：45 秒没读完。/);
  });

  it("B 站的页面按中文浏览器去读（不然拿到的是机器翻译成英文的页面）；别的网站不带这个", async () => {
    const seen: Record<string, string | null> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen[new URL(url.replace("https://r.jina.ai/", "")).hostname] = new Headers(init?.headers).get("x-locale");
      return jina(jinaData());
    }));
    await fetchWebPage({ ...ref, url: "https://www.bilibili.com/video/BV1ar421p7kw" });
    await fetchWebPage({ ...ref, url: "https://space.bilibili.com/88461692" });
    await fetchWebPage(ref);
    expect(seen).toEqual({ "www.bilibili.com": "zh-CN", "space.bilibili.com": "zh-CN", "simonwillison.net": null });
  });
});
