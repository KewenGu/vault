import { describe, it, expect, vi, afterEach } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { SourceFetchError } from "./types";
import { YOUTUBE_APIFY_COUNT_KEY, fetchYouTubeViaApify, mapYouTubeApifyItem, pickSubtitle, srtCues } from "./youtube-apify";

/** 按 streamers~youtube-scraper 真实返回的形状缩出来的一条（2026-11-19，视频 B5xsBouNfog）。 */
const srt = "1\n00:00:0,000 --> 00:00:4,480\nImagine dropping a ceramic plate onto a\n\n2\n00:00:2,590 --> 00:00:4,480\n \n\n3\n00:00:2,600 --> 00:00:7,400\nhard stone floor.\n\n4\n00:00:4,470 --> 00:00:7,400\n \n\n5\n00:14:45,821 --> 00:14:51,261\nyou in the next video.\n\n";
const item = {
  title: "China Kept Reuniting for 2,000 Years. So Why Couldn't Europe?",
  type: "video",
  id: "B5xsBouNfog",
  url: "https://www.youtube.com/watch?v=B5xsBouNfog",
  thumbnailUrl: "https://i.ytimg.com/vi/B5xsBouNfog/maxresdefault.jpg",
  viewCount: 301864,
  date: "2026-11-03T12:30:38.000Z",
  likes: 2800,
  channelName: "Genius Chronicle",
  channelId: "UCu7TmkWMybrBmNpEu0jHiMA",
  duration: "00:14:50",
  commentsCount: 1262,
  text: "#History #ChinaHistory\n\nFor more than 2,000 years, China repeatedly collapsed into civil wars.",
  subtitles: [{ srtUrl: null, type: "auto_generated", language: "en", srt }],
  hashtags: ["#AncientChina", "#History"],
  isMembersOnly: false,
};
const ref = { platform: "youtube" as const, externalId: "B5xsBouNfog", url: "https://youtu.be/B5xsBouNfog" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("收藏夹：通过 Apify 读 YouTube 视频（播放接口被拦时的后备）", () => {
  it("SRT → 带时间的话：时间写得不规整也认，空白的占位丢掉", () => {
    expect(srtCues(srt)).toEqual([
      { at: 0, text: "Imagine dropping a ceramic plate onto a" },
      { at: 2.6, text: "hard stone floor." },
      { at: 885.821, text: "you in the next video." },
    ]);
    expect(srtCues("1\n00:01:05.500 --> 00:01:07.000\n<i>第一行</i>\n第二行\n")).toEqual([{ at: 65.5, text: "第一行 第二行" }]);
    expect(srtCues("不是字幕")).toEqual([]);
  });

  it("挑字幕：原语言里作者上传的 → 自动生成的 → 中文 → 英文 → 第一条；空的不算", () => {
    const sub = (type: string, language: string, text = language) => ({ type, language, srt: text });
    expect(pickSubtitle([sub("auto_generated", "en"), sub("user_generated", "fr"), sub("user_generated", "en-US", "manual-en")])).toEqual({ srt: "manual-en", auto: false });
    expect(pickSubtitle([sub("user_generated", "fr"), sub("auto_generated", "ja")])).toEqual({ srt: "ja", auto: true });
    expect(pickSubtitle([sub("user_generated", "fr"), sub("user_generated", "en"), sub("user_generated", "zh-Hans")])).toEqual({ srt: "zh-Hans", auto: false });
    expect(pickSubtitle([sub("auto_generated", "en", " "), { type: "auto_generated", language: "en", srt: null }])).toBeNull();
    expect(pickSubtitle(null)).toBeNull();
  });

  it("actor 的一条 → 帖子：没有视频本体，字幕当口播，说清楚这次没看画面", () => {
    const post = mapYouTubeApifyItem(item, ref.externalId);
    expect(post).toMatchObject({
      platform: "youtube",
      externalId: "B5xsBouNfog",
      kind: "video",
      title: "China Kept Reuniting for 2,000 Years. So Why Couldn't Europe?",
      author: { id: "UCu7TmkWMybrBmNpEu0jHiMA", name: "Genius Chronicle" },
      publishedAt: "2026-11-03T12:30:38.000Z",
      stats: { views: 301864, likes: 2800, collects: null, comments: 1262, shares: null },
      hashtags: ["History", "ChinaHistory", "AncientChina"],
      video: null,
      durationS: 890,
      captions: "[0:00] Imagine dropping a ceramic plate onto a hard stone floor.\n[14:45] you in the next video.",
      notes: ["YouTube 不让这台机器直接读，这次是通过 Apify 读的：没有下载视频，画面只看了封面", "读不到评论内容，只有评论数", "字幕是 YouTube 自动生成的，可能有错字"],
    });
    expect(post.images).toEqual([{ url: "https://i.ytimg.com/vi/B5xsBouNfog/maxresdefault.jpg", backupUrls: ["https://i.ytimg.com/vi/B5xsBouNfog/sddefault.jpg", "https://i.ytimg.com/vi/B5xsBouNfog/hqdefault.jpg"] }]);
  });

  it("没有字幕：说清楚视频里说了什么不知道（不是「没有口播」）", () => {
    const post = mapYouTubeApifyItem({ ...item, subtitles: null, duration: null }, ref.externalId);
    expect(post.captions).toBeNull();
    expect(post.durationS).toBeNull();
    expect(post.notes).toContain("没有读到字幕，也没有视频可以转写：视频里说了什么不知道");
  });

  it("返回空 / 不是这个视频：报读不到", () => {
    expect(() => mapYouTubeApifyItem(undefined, ref.externalId)).toThrow(SourceFetchError);
    expect(() => mapYouTubeApifyItem({ ...item, id: "another0000" }, ref.externalId)).toThrow(/改走 Apify 也没读到/);
  });

  it("一次 Apify 运行：先问视频在不在，令牌放请求头，只要字幕不要转写，读到了记一笔", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret");
    const fetchMock = vi.fn(async (url: string | URL) => (String(url).includes("/oembed") ? new Response("{}", { status: 200 }) : new Response(JSON.stringify([item]), { status: 201 })));
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchYouTubeViaApify(ref));
    expect(post.author.name).toBe("Genius Chronicle");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls.find(([u]) => String(u).includes("api.apify.com"))!;
    expect(url).toBe("https://api.apify.com/v2/acts/streamers~youtube-scraper/run-sync-get-dataset-items?timeout=110");
    expect(url).not.toContain("apify_secret");
    expect(init.headers).toMatchObject({ authorization: "Bearer apify_secret" });
    expect(JSON.parse(String(init.body))).toEqual({
      startUrls: [{ url: "https://www.youtube.com/watch?v=B5xsBouNfog" }],
      maxResults: 1,
      transcriptionAndSubtitle: "ALWAYS_SUBTITLES",
      subtitlesLanguage: "any",
      subtitlesFormat: "srt",
    });
    expect(counts).toEqual({ [YOUTUBE_APIFY_COUNT_KEY]: 1 });
  });

  it("视频不在（oEmbed 说没有）：不跑 Apify、不花钱", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    for (const status of [400, 403, 404]) {
      const fetchMock = vi.fn(async () => new Response("Not Found", { status }));
      vi.stubGlobal("fetch", fetchMock);
      const counts: Record<string, number> = {};
      await expect(meterInto(counts, () => fetchYouTubeViaApify(ref))).rejects.toThrow("这个 YouTube 视频读不到");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(counts).toEqual({});
    }
  });

  it("oEmbed 问不到（网络、别的状态码）当它在，照样跑；返回空不记账", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => (String(url).includes("/oembed") ? new Response("", { status: 401 }) : new Response("[]", { status: 201 }))));
    const counts: Record<string, number> = {};
    await expect(meterInto(counts, () => fetchYouTubeViaApify(ref))).rejects.toThrow(SourceFetchError);
    expect(counts).toEqual({});
  });

  it("actor 跑到超时（它读不到时的表现）：直接告诉用户，不重试；别的 Apify 报错留给重试；换 actor；没配令牌直接说", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    vi.stubEnv("APIFY_YOUTUBE_ACTOR", "someone~other-actor");
    const apify = (body: string, status: number) =>
      vi.fn(async (url: string | URL) => (String(url).includes("/oembed") ? new Response("{}", { status: 200 }) : new Response(body, { status })));
    const timedOut = apify(JSON.stringify({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: x, status: TIMED-OUT)." } }), 400);
    vi.stubGlobal("fetch", timedOut);
    await expect(fetchYouTubeViaApify(ref)).rejects.toThrow(SourceFetchError);
    expect(String(timedOut.mock.calls.at(-1)![0])).toContain("/acts/someone~other-actor/");

    vi.stubGlobal("fetch", apify(JSON.stringify({ error: { type: "rate-limit-exceeded", message: "Too many requests" } }), 429));
    const err = await fetchYouTubeViaApify(ref).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SourceFetchError);
    expect(String(err)).toContain("apify(someone~other-actor) 429: Too many requests");

    vi.stubEnv("APIFY_TOKEN", "");
    await expect(fetchYouTubeViaApify(ref)).rejects.toThrow(/APIFY_TOKEN/);
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
