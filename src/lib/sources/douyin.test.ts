import { describe, it, expect, vi, afterEach } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { DOUYIN_COUNT_KEY, fetchDouyinVideo, mapDouyinItem } from "./douyin";
import { SourceFetchError } from "./types";

/** 按 zen-studio~douyin-video-scraper 真实返回的形状缩出来的一条视频（2026-11-19）。 */
const videoItem = {
  id: "7288896159513316647",
  type: "video",
  text: "开头这句太绝了 #职场 #AI工具\n第二行…版本过低，升级后可展示全部信息",
  createTime: 1697078395,
  authorMeta: { id: "2524946748677725", secUid: "MS4wLjABAAAA", name: "零度*" },
  musicMeta: { id: "7288320493894011705", title: "@小雨是佩琪创作的原声", author: "小雨是佩琪", isOriginal: true },
  videoMeta: {
    duration: 6014,
    width: 720,
    height: 1282,
    playUrl: "https://v11-colds.douyinvod.com/play",
    playUrlH264: "https://v11-colds.douyinvod.com/play",
    downloadUrl: "https://v9-chc.douyinvod.com/logo.mp4",
    cover: "https://p95/cover.webp",
    originCover: "https://p95/origin.webp",
    dynamicCover: null,
  },
  coverUrl: "https://p95/cover.webp",
  images: [],
  videoUrl: "https://v9-chc.douyinvod.com/logo.mp4",
  statistics: { diggCount: 1458, shareCount: 132, commentCount: 98, collectCount: 97, playCount: 0 },
  hashtags: [{ id: "1", name: "职场" }, { id: "2", name: "AI工具" }, {}],
  authorDeclaration: null,
};

/** 一条图文（type: "imageText"）：videoUrl / playUrl 是背景音乐的 mp3，不是视频。 */
const imageItem = {
  id: "7709473635812144229",
  type: "imageText",
  text: "生活的苦，只是体力与情绪的重复；学习的苦，是认知与思维的重塑。#法式清醒 #人生哲学",
  createTime: 1795001709,
  authorMeta: { id: "4464496247841292", secUid: "MS4wLjABAAAAoD2P", name: "🐎飒露紫 🇨🇳🇫🇷" },
  musicMeta: { title: "晴天", author: "周杰伦", isOriginal: false },
  videoMeta: { duration: 0, width: 1800, height: 2398, playUrl: "https://sf11-cdn-tos.douyinstatic.com/obj/ies-music/1.mp3", cover: "https://p11/cover.webp", originCover: "https://p11/origin.webp" },
  coverUrl: "https://p11/cover.webp",
  images: [
    { url: "https://p11-sign.douyinpic.com/1.webp", width: 1440, height: 1918 },
    { url: "https://p11-sign.douyinpic.com/2.webp", width: 1440, height: 1918 },
    { width: 1, height: 1 },
  ],
  videoUrl: "https://sf11-cdn-tos.douyinstatic.com/obj/ies-music/1.mp3",
  statistics: { diggCount: 5299, shareCount: 644, commentCount: 60, collectCount: 3123 },
  hashtags: [{ name: "法式清醒" }, { name: "人生哲学" }],
  authorDeclaration: "内容由 AI 生成",
};
const ref = { platform: "douyin" as const, externalId: "7288896159513316647", url: "https://www.douyin.com/video/7288896159513316647" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("收藏夹：读抖音", () => {
  it("视频：标题取文案第一行（去话题）、时长毫秒换秒、播放地址去重按顺序、封面按候选顺序、被截断记一句", () => {
    const post = mapDouyinItem(videoItem, ref.externalId);
    expect(post).toMatchObject({
      platform: "douyin",
      externalId: "7288896159513316647",
      url: "https://www.douyin.com/video/7288896159513316647",
      kind: "video",
      title: "开头这句太绝了",
      text: "开头这句太绝了 #职场 #AI工具\n第二行…",
      author: { id: "MS4wLjABAAAA", name: "零度*" },
      publishedAt: "2023-10-12T02:39:55.000Z",
      stats: { views: null, likes: 1458, collects: 97, comments: 98, shares: 132 },
      hashtags: ["职场", "AI工具"],
      topComments: [],
      music: "@小雨是佩琪创作的原声（原声）",
      notes: ["文案被平台截断了，只读到前面一部分", "这条路读不到评论内容，只有评论数"],
    });
    expect(post.video).toEqual({ url: "https://v11-colds.douyinvod.com/play", backupUrls: ["https://v9-chc.douyinvod.com/logo.mp4"], width: 720, height: 1282, bytes: null, durationS: 6 });
    expect(post.images).toEqual([{ url: "https://p95/origin.webp", backupUrls: ["https://p95/cover.webp"], width: null, height: null }]);
  });

  it("图文：链接换成 /note/，每一张图都要（没地址的跳过），背景音乐的 mp3 不当视频；作者声明记一句", () => {
    const post = mapDouyinItem(imageItem, "7709473635812144229");
    expect(post).toMatchObject({ kind: "image", url: "https://www.douyin.com/note/7709473635812144229", video: null, title: "生活的苦，只是体力与情绪的重复；学习的苦，是认知与思维的重塑。", music: "晴天 — 周杰伦", hashtags: ["法式清醒", "人生哲学"] });
    expect(post.images).toEqual([
      { url: "https://p11-sign.douyinpic.com/1.webp", width: 1440, height: 1918 },
      { url: "https://p11-sign.douyinpic.com/2.webp", width: 1440, height: 1918 },
    ]);
    expect(post.notes).toEqual(["这条路读不到评论内容，只有评论数", "作者声明：内容由 AI 生成"]);
  });

  it("图文没拿到图、视频没拿到地址：各记一句", () => {
    expect(mapDouyinItem({ ...imageItem, images: null, authorDeclaration: null }, "1").notes).toEqual(["这条路读不到评论内容，只有评论数", "这是一条图文，但没有拿到图片"]);
    const bare = mapDouyinItem({ ...videoItem, text: "一句话", videoMeta: { cover: "https://p3/cover.jpg" }, coverUrl: null }, "1");
    expect(bare.video).toBeNull();
    expect(bare.images).toEqual([{ url: "https://p3/cover.jpg", backupUrls: [], width: null, height: null }]);
    expect(bare.notes).toEqual(["这条路读不到评论内容，只有评论数", "没有拿到视频地址，只读到了封面"]);
  });

  it("作品不存在（actor 返回空数组）/ 形状不对：报读不到", () => {
    expect(() => mapDouyinItem(undefined, ref.externalId)).toThrow(SourceFetchError);
    expect(() => mapDouyinItem({ error: true, message: "Couldn't get video data" }, ref.externalId)).toThrow(/读不到/);
  });

  it("一次 Apify 运行：令牌放请求头、不进网址，跑成功记一笔（哪怕返回的是空的）", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([videoItem]), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchDouyinVideo(ref));
    expect(post.author.name).toBe("零度*");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.apify.com/v2/acts/zen-studio~douyin-video-scraper/run-sync-get-dataset-items?timeout=110");
    expect(url).not.toContain("apify_secret");
    expect(init.headers).toMatchObject({ authorization: "Bearer apify_secret" });
    expect(JSON.parse(String(init.body))).toEqual({ videoUrls: [ref.url] });
    expect(counts).toEqual({ [DOUYIN_COUNT_KEY]: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 201 })));
    const failed: Record<string, number> = {};
    await expect(meterInto(failed, () => fetchDouyinVideo(ref))).rejects.toThrow(SourceFetchError);
    expect(failed).toEqual({ [DOUYIN_COUNT_KEY]: 1 });
  });

  it("换 actor（APIFY_DOUYIN_ACTOR）；Apify 报错不记账；没配令牌直接说", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    vi.stubEnv("APIFY_DOUYIN_ACTOR", "someone~other-actor");
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response("quota exceeded", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    await expect(meterInto(counts, () => fetchDouyinVideo(ref))).rejects.toThrow(/402/);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/acts/someone~other-actor/");
    expect(counts).toEqual({});

    vi.stubEnv("APIFY_TOKEN", "");
    await expect(fetchDouyinVideo(ref)).rejects.toThrow(/APIFY_TOKEN 没配/);
  });
});
