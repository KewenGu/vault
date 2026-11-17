import { describe, it, expect, vi, afterEach } from "vitest";
import { DESKTOP_UA } from "./link";
import { cookieHeader, extractUniversalData, fetchTikTokVideo, parseTikTokData } from "./tiktok";
import { SourceFetchError } from "./types";

/** 按 TikTok 视频页里 __UNIVERSAL_DATA_FOR_REHYDRATION__ 真实的形状缩出来的（2026-10）。 */
const item = (over: Record<string, unknown> = {}) => ({
  id: "6718335390845095173",
  desc: "Scramble up ur name & I’ll try to guess it😍 #foryoupage #PetsOfTikTok",
  createTime: "1564234358",
  author: { id: "1", secUid: "MS4wLjABAAAA", uniqueId: "scout2015", nickname: "Scout, Suki & Stella" },
  music: { title: "original sound", authorName: "tiff", original: true },
  stats: { diggCount: 35200, shareCount: 1499, commentCount: 5717, playCount: 159500, collectCount: 649 },
  statsV2: { diggCount: "35231", shareCount: "1499", commentCount: "5717", playCount: "159512", collectCount: "649" },
  challenges: [{ title: "foryoupage" }, { title: "PetsOfTikTok" }, {}],
  textExtra: [{ hashtagName: "foryoupage" }],
  video: {
    duration: 10,
    width: 576,
    height: 1024,
    cover: "https://p16-sign.tiktokcdn-us.com/cover.jpg",
    originCover: "https://p16-sign.tiktokcdn-us.com/origin.jpg",
    playAddr: "https://v16-webapp-prime.us.tiktok.com/play/",
    bitrateInfo: [
      { Bitrate: 2_000_000, CodecType: "h265_hvc1", PlayAddr: { DataSize: "1800000", Width: 720, Height: 1280, UrlList: ["https://v16-webapp-prime.us.tiktok.com/h265/"] } },
      { Bitrate: 2_300_000, CodecType: "h264", PlayAddr: { DataSize: "2953029", Width: 576, Height: 1024, UrlList: ["https://v16-webapp-prime.us.tiktok.com/h264/", "https://v19.tiktokcdn-us.com/h264/"] } },
      { Bitrate: 900_000, CodecType: "h264", PlayAddr: { DataSize: "1100000", Width: 360, Height: 640, UrlList: ["https://v16-webapp-prime.us.tiktok.com/h264-low/"] } },
    ],
  },
  ...over,
});
const page = (detail: unknown) => ({ __DEFAULT_SCOPE__: { "webapp.app-context": {}, "webapp.video-detail": detail } });
const ok = (over: Record<string, unknown> = {}) => page({ statusCode: 0, itemInfo: { itemStruct: item(over) } });
const html = (data: unknown) => `<html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></head></html>`;
const ref = { platform: "tiktok" as const, externalId: "6718335390845095173", url: "https://www.tiktok.com/@scout2015/video/6718335390845095173" };

afterEach(() => vi.unstubAllGlobals());

describe("收藏夹：读 TikTok 视频", () => {
  it("页面里的 JSON → 帖子：播放 / 点赞 / 收藏 / 评论 / 转发都有（新旧两套数字取新的），话题、原声、作者", () => {
    const post = parseTikTokData(ok(), { cookie: "tt_chain_token=abc" });
    expect(post).toMatchObject({
      platform: "tiktok",
      externalId: "6718335390845095173",
      kind: "video",
      title: "Scramble up ur name & I’ll try to guess it😍",
      author: { id: "MS4wLjABAAAA", name: "Scout, Suki & Stella @scout2015" },
      publishedAt: "2019-07-27T13:32:38.000Z",
      stats: { views: 159512, likes: 35231, collects: 649, comments: 5717, shares: 1499 },
      hashtags: ["foryoupage", "PetsOfTikTok"],
      music: "original sound（原声）",
      notes: ["读不到评论内容，只有评论数"],
    });
  });

  it("码流挑不超上限里最大的 h264；视频地址带 cookie + referer，CDN 域名不带 cookie", () => {
    const post = parseTikTokData(ok(), { cookie: "tt_chain_token=abc" });
    expect(post.video).toEqual({
      url: "https://v16-webapp-prime.us.tiktok.com/h264/",
      backupUrls: ["https://v19.tiktokcdn-us.com/h264/"],
      headers: { "user-agent": DESKTOP_UA, referer: "https://www.tiktok.com/", cookie: "tt_chain_token=abc" },
      width: 576,
      height: 1024,
      bytes: 2953029,
      durationS: 10,
    });
    expect(post.images).toEqual([
      { url: "https://p16-sign.tiktokcdn-us.com/origin.jpg", backupUrls: ["https://p16-sign.tiktokcdn-us.com/cover.jpg"], headers: { "user-agent": DESKTOP_UA, referer: "https://www.tiktok.com/" } },
    ]);
    // 上限放不下大的那档：换小的
    expect(parseTikTokData(ok(), { maxVideoBytes: 1_500_000 }).video).toMatchObject({ url: "https://v16-webapp-prime.us.tiktok.com/h264-low/", bytes: 1100000 });
    // 没有分档信息：用 playAddr
    expect(parseTikTokData(ok({ video: { duration: 10, playAddr: "https://v16-webapp-prime.us.tiktok.com/play/" } })).video).toMatchObject({ url: "https://v16-webapp-prime.us.tiktok.com/play/", durationS: 10 });
    // 连地址都没有
    const none = parseTikTokData(ok({ video: { cover: "https://p16-sign.tiktokcdn-us.com/cover.jpg" } }));
    expect(none.video).toBeNull();
    expect(none.notes).toContain("没有拿到视频地址，只读到了封面");
  });

  it("图集：每张图都存，类型是图文，没有视频；不是原声的音乐带上作者", () => {
    const post = parseTikTokData(
      ok({
        imagePost: { images: [{ imageURL: { urlList: ["https://p16-sign.tiktokcdn-us.com/1.jpg", "https://p19-sign.tiktokcdn-us.com/1.jpg"] }, imageWidth: 1080, imageHeight: 1440 }, { imageURL: { urlList: ["https://p16-sign.tiktokcdn-us.com/2.jpg"] } }, { imageURL: {} }] },
        music: { title: "Sunny", authorName: "Someone", original: false },
        challenges: [],
      })
    );
    expect(post.kind).toBe("image");
    expect(post.video).toBeNull();
    expect(post.images.map((i) => [i.url, i.backupUrls, i.width])).toEqual([
      ["https://p16-sign.tiktokcdn-us.com/1.jpg", ["https://p19-sign.tiktokcdn-us.com/1.jpg"], 1080],
      ["https://p16-sign.tiktokcdn-us.com/2.jpg", [], null],
    ]);
    expect(post.music).toBe("Sunny — Someone");
    // 没有话题列表时用正文里标的
    expect(post.hashtags).toEqual(["foryoupage"]);
  });

  it("视频不在了 / 私密 / 页面里没有视频信息：各报各的", () => {
    expect(() => parseTikTokData(page({ statusCode: 10204, statusMsg: "item doesn't exist" }))).toThrow(/可能被删了/);
    expect(() => parseTikTokData(page({ statusCode: 10216 }))).toThrow("这个 TikTok 视频是私密的，读不了。可以把视频文案贴进来直接分析");
    expect(() => parseTikTokData({ __DEFAULT_SCOPE__: {} })).toThrow(/没有视频内容/);
    expect(() => parseTikTokData(null)).toThrow(SourceFetchError);
  });

  it("从页面 HTML 里取那段 JSON；没有 / 坏了是 null", () => {
    expect(extractUniversalData(html({ a: 1 }))).toEqual({ a: 1 });
    expect(extractUniversalData("<html>验证页</html>")).toBeNull();
    expect(extractUniversalData('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{坏的</script>')).toBeNull();
  });

  it("读视频页：按电脑浏览器打开，页面发的 cookie 记到视频地址上；读到的不是这条 / 没有数据 / 404 都报读不到", async () => {
    const res = () => {
      const r = new Response(html(ok()), { status: 200 });
      r.headers.append("set-cookie", "ttwid=1%7Cabc; Path=/; Domain=tiktok.com; HttpOnly");
      r.headers.append("set-cookie", "tt_chain_token=xyz==; Path=/; Secure");
      return r;
    };
    expect(cookieHeader(res())).toBe("ttwid=1%7Cabc; tt_chain_token=xyz==");
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => res());
    vi.stubGlobal("fetch", fetchMock);
    const post = await fetchTikTokVideo(ref);
    expect(fetchMock.mock.calls[0][0]).toBe(ref.url);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "user-agent": DESKTOP_UA });
    expect(post.video?.headers?.cookie).toBe("ttwid=1%7Cabc; tt_chain_token=xyz==");

    await expect(fetchTikTokVideo({ ...ref, externalId: "999" })).rejects.toThrow(/读不到/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>captcha</html>")));
    await expect(fetchTikTokVideo(ref)).rejects.toThrow(/没有视频内容/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchTikTokVideo(ref)).rejects.toThrow(SourceFetchError);
    // 别的状态码是临时的（可以重试），不是「读不到」
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(fetchTikTokVideo(ref)).rejects.toThrow("TikTok 503：页面打不开，过一会儿再试");
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
