import { describe, it, expect, vi, afterEach } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { INSTAGRAM_COUNT_KEY, fetchInstagramPost, mapInstagramItem } from "./instagram";
import { SourceFetchError } from "./types";

/** 按 apify~instagram-scraper 真实返回的形状缩出来的一条 Reels（2026-10）。 */
const reel = {
  id: "2913166071890361328",
  type: "Video",
  shortCode: "Chunk8-jurw",
  caption: "“Gingerton”\n\nA cat in a hat. #WeeklyFluff",
  hashtags: ["WeeklyFluff", ""],
  commentsCount: 15774,
  latestComments: [
    { text: "so cute", likesCount: 2 },
    { text: "最高赞的一条", likesCount: 40 },
    { text: "  " },
  ],
  displayUrl: "https://instagram.fna.fbcdn.net/cover.jpg",
  images: [],
  videoUrl: "https://instagram.fna.fbcdn.net/v.mp4",
  dimensionsWidth: 1080,
  dimensionsHeight: 1920,
  likesCount: 975050,
  videoViewCount: 9000000,
  videoPlayCount: 29673446,
  timestamp: "2022-08-26T15:53:51.000Z",
  ownerFullName: "Instagram",
  ownerUsername: "instagram",
  ownerId: "25025320",
  musicInfo: { artist_name: "instagram", song_name: "Original audio", uses_original_audio: true },
};
const ref = { platform: "instagram" as const, externalId: "Chunk8-jurw", url: "https://www.instagram.com/reel/Chunk8-jurw/" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("收藏夹：读 Instagram 帖子", () => {
  it("Reels → 视频帖：播放数取 play（没有再取 view），评论按赞数排，音乐带作者；收藏 / 转发没有并记一句", () => {
    const post = mapInstagramItem(reel, ref.externalId);
    expect(post).toMatchObject({
      platform: "instagram",
      externalId: "Chunk8-jurw",
      kind: "video",
      title: "“Gingerton”",
      author: { id: "25025320", name: "Instagram @instagram" },
      publishedAt: "2022-08-26T15:53:51.000Z",
      stats: { views: 29673446, likes: 975050, collects: null, comments: 15774, shares: null },
      hashtags: ["WeeklyFluff"],
      topComments: [
        { text: "最高赞的一条", likes: 40 },
        { text: "so cute", likes: 2 },
      ],
      music: "Original audio — instagram",
      video: { url: "https://instagram.fna.fbcdn.net/v.mp4", width: 1080, height: 1920, bytes: null, durationS: null },
      notes: ["Instagram 不公开收藏数和转发数", "评论只读到最新的几条，不一定是最高赞的"],
    });
    expect(post.images).toEqual([{ url: "https://instagram.fna.fbcdn.net/cover.jpg", width: 1080, height: 1920 }]);
    expect(mapInstagramItem({ ...reel, videoPlayCount: undefined }, ref.externalId).stats.views).toBe(9000000);
  });

  it("轮播：每一张都存，里面的视频只存封面并记一句；作者隐藏点赞（-1）时点赞数是空的", () => {
    const post = mapInstagramItem(
      {
        ...reel,
        type: "Sidecar",
        videoUrl: undefined,
        likesCount: -1,
        latestComments: [],
        musicInfo: undefined,
        childPosts: [
          { type: "Image", displayUrl: "https://instagram.fna.fbcdn.net/1.jpg", dimensionsWidth: 1080, dimensionsHeight: 1350 },
          { type: "Video", displayUrl: "https://instagram.fna.fbcdn.net/2.jpg", videoUrl: "https://instagram.fna.fbcdn.net/2.mp4" },
          { type: "Image" },
        ],
      },
      ref.externalId
    );
    expect(post.kind).toBe("image");
    expect(post.video).toBeNull();
    expect(post.images).toEqual([
      { url: "https://instagram.fna.fbcdn.net/1.jpg", width: 1080, height: 1350 },
      { url: "https://instagram.fna.fbcdn.net/2.jpg", width: null, height: null },
    ]);
    expect(post.stats.likes).toBeNull();
    expect(post.music).toBeNull();
    expect(post.notes).toEqual(["Instagram 不公开收藏数和转发数", "轮播里有 1 段视频，只存了它们的封面", "作者隐藏了点赞数"]);
  });

  it("单图帖：封面和 images 里重复的只算一张；原声没有歌名时写「原声」", () => {
    const post = mapInstagramItem({ ...reel, type: "Image", videoUrl: undefined, images: ["https://instagram.fna.fbcdn.net/cover.jpg"], musicInfo: { uses_original_audio: true } }, ref.externalId);
    expect(post.kind).toBe("image");
    expect(post.images).toHaveLength(1);
    expect(post.music).toBe("原声");
  });

  it("actor 说没读到 / 返回空：报读不到", () => {
    expect(() => mapInstagramItem({ error: "restricted_page", errorDescription: "Restricted access" }, ref.externalId)).toThrow(SourceFetchError);
    expect(() => mapInstagramItem(undefined, ref.externalId)).toThrow(/读不到/);
  });

  it("一次 Apify 运行：令牌放请求头、不进网址，跑成功记一笔（哪怕返回的是没读到）", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret");
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify([reel]), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchInstagramPost(ref));
    expect(post.externalId).toBe("Chunk8-jurw");
    expect(counts).toEqual({ [INSTAGRAM_COUNT_KEY]: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?timeout=110");
    expect(url).not.toContain("apify_secret");
    expect(init?.headers).toMatchObject({ authorization: "Bearer apify_secret" });
    expect(JSON.parse(String(init?.body))).toEqual({ directUrls: [ref.url], resultsType: "posts", resultsLimit: 1, addParentData: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ error: "not_found" }]), { status: 201 })));
    await expect(meterInto(counts, () => fetchInstagramPost(ref))).rejects.toThrow(SourceFetchError);
    expect(counts).toEqual({ [INSTAGRAM_COUNT_KEY]: 2 });
  });

  it("没配 APIFY_TOKEN：不发请求，告诉用户；actor 可以用环境变量换；Apify 出错原样报、不记账", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchInstagramPost(ref)).rejects.toThrow("读 Instagram 帖子要用 Apify（环境变量 APIFY_TOKEN 没配）。可以先把帖子文案贴进来直接分析");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("APIFY_TOKEN", "t");
    vi.stubEnv("APIFY_INSTAGRAM_ACTOR", "someone~other-scraper");
    const counts: Record<string, number> = {};
    await expect(meterInto(counts, () => fetchInstagramPost(ref))).rejects.toThrow(/apify\(someone~other-scraper\)/);
    expect(fetchMock.mock.calls[0][0]).toContain("/acts/someone~other-scraper/");
    expect(counts).toEqual({});
  });
});
