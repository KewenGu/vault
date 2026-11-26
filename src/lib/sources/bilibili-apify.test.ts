import { afterEach, describe, expect, it, vi } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { bilibiliVideoId, fetchBilibiliViaApify, mapBilibiliItem } from "./bilibili-apify";
import { SourceFetchError } from "./types";

/** actor 2026-11-26 实际返回的形状。 */
const item = (over: Record<string, unknown> = {}) => ({
  url: "https://www.bilibili.com/video/BV1ar421p7kw",
  bvid: "BV1ar421p7kw",
  aid: 1401173475,
  cid: 1449553213,
  title: " 【千古绝学】公开奇门遁甲，掀翻玄学桌子。 ",
  desc: "零基础掌握奇门遁甲。\n\n声明：世上没有宿命！ #奇门遁甲",
  createTime: 1708760988,
  img: "http://i2.hdslb.com/bfs/archive/e8623ff0.jpg",
  view: 1291558,
  danmaku: 4645,
  reply: 3979,
  favorite: 100377,
  coin: 40270,
  share: 13393,
  like: 77238,
  duration: 2401.6,
  nickname: "荀爽",
  videoUrl: "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/13/32/1449553213/1449553213-1-192.mp4?e=x&deadline=1795713625",
  audioUrl: "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/13/32/1449553213/1449553213-1-30280.m4s?e=x",
  errMsg: "",
  ...over,
});
const ref = { externalId: "f3b02d9e829e24a218144bde94ce0e5e", url: "https://www.bilibili.com/video/BV1ar421p7kw" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("B 站视频：这台服务器读不了时走 Apify", () => {
  it("认 B 站的视频页：整理过的地址、带来源参数和末尾斜杠的旧地址、手机版都认；主页、专栏、别的站不认", () => {
    expect(bilibiliVideoId("https://www.bilibili.com/video/BV1ar421p7kw")).toBe("BV1ar421p7kw");
    expect(bilibiliVideoId("https://www.bilibili.com/video/BV1ar421p7kw/?vd_source=b041e1eb&p=2")).toBe("BV1ar421p7kw");
    expect(bilibiliVideoId("https://m.bilibili.com/video/BV1ar421p7kw")).toBe("BV1ar421p7kw");
    for (const url of ["https://space.bilibili.com/88461692", "https://www.bilibili.com/read/cv123", "https://www.bilibili.com/video/av170001", "https://notbilibili.com/video/BV1ar421p7kw", "不是地址"]) expect(bilibiliVideoId(url), url).toBeNull();
  });

  it("actor 的一条 → 一个视频（平台还是 web）：标题、简介、UP 主、互动数、封面、带声音的视频地址；记下为什么走了这条路", () => {
    expect(mapBilibiliItem(item(), ref, "对方回了 HTTP 412（多半是这台服务器的 IP 被那个站拦了）")).toEqual({
      platform: "web",
      externalId: ref.externalId,
      kind: "video",
      title: "【千古绝学】公开奇门遁甲，掀翻玄学桌子。",
      text: "零基础掌握奇门遁甲。\n\n声明：世上没有宿命！ #奇门遁甲",
      author: { id: null, name: "荀爽" },
      publishedAt: "2024-02-24T07:49:48.000Z",
      stats: { views: 1291558, likes: 77238, collects: 100377, comments: 3979, shares: 13393 },
      hashtags: ["奇门遁甲"],
      topComments: [],
      images: [{ url: "https://i2.hdslb.com/bfs/archive/e8623ff0.jpg" }],
      video: { url: item().videoUrl, width: null, height: null, bytes: null, durationS: 2401.6 },
      durationS: 2401.6,
      music: null,
      notes: ["这台服务器上的 yt-dlp 没读到这个视频（对方回了 HTTP 412（多半是这台服务器的 IP 被那个站拦了）），这次是通过 Apify 读的", "读不到评论内容，只有评论数"],
    });
    // 本机没有 yt-dlp 时的说法；简介只有一个「-」的当成没写
    const bare = mapBilibiliItem(item({ desc: "-" }), ref);
    expect(bare.notes[0]).toBe("这台服务器上没有 yt-dlp，这次是通过 Apify 读的");
    expect(bare.text).toBe("");
  });

  it("没给视频地址：信息照样留着，说清楚画面和口播没读到", () => {
    const post = mapBilibiliItem(item({ videoUrl: "" }), ref);
    expect(post.video).toBeNull();
    expect(post.kind).toBe("video");
    expect(post.notes).toContain("没有拿到视频地址，只读到了封面和简介：画面和里面说的话都没读到");
  });

  it("没读到（空的、不是这个视频、actor 说出错了、没有标题）：读不到", () => {
    for (const bad of [undefined, item({ bvid: "BV1u7hQ6rEQB" }), item({ errMsg: "video not found" }), item({ title: " " })]) {
      expect(() => mapBilibiliItem(bad, ref)).toThrow(SourceFetchError);
    }
  });

  it("一次同步运行：给 actor 的是整理过的地址（旧地址里的来源参数不带，分 P 的留着）；读到了记一笔", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify([item()]), { status: 201 });
    });
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchBilibiliViaApify({ externalId: "old", url: "https://www.bilibili.com/video/BV1ar421p7kw/?vd_source=b041e1eb&p=3" }));
    expect(post.externalId).toBe("old");
    expect(calls).toEqual([{ url: "https://api.apify.com/v2/acts/apple_yang~bilibili-video-audio-downloader/run-sync-get-dataset-items?timeout=110", auth: "Bearer apify_secret_1", body: { videoUrls: ["https://www.bilibili.com/video/BV1ar421p7kw?p=3"] } }]);
    expect(counts).toEqual({ apify_bilibili_video: 1 });
  });

  it("没配令牌、不是视频地址说清楚；actor 可以用环境变量换", async () => {
    await expect(fetchBilibiliViaApify(ref)).rejects.toThrow("走 Apify 读 B 站要配环境变量 APIFY_TOKEN");
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    await expect(fetchBilibiliViaApify({ externalId: "x", url: "https://space.bilibili.com/1" })).rejects.toThrow("这不是一个 B 站视频的地址");
    vi.stubEnv("APIFY_BILIBILI_ACTOR", "someone~other");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("[]", { status: 201 });
    });
    await expect(fetchBilibiliViaApify(ref)).rejects.toThrow(SourceFetchError);
    expect(urls[0]).toContain("/acts/someone~other/");
  });
});
