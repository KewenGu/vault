import { describe, it, expect, vi, afterEach } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { DOUYIN_COUNT_KEY, fetchDouyinVideo, mapDouyinItem } from "./douyin";
import { SourceFetchError } from "./types";

/** 按 natanielsantos~douyin-scraper 真实返回的形状缩出来的一条（2026-10）。 */
const item = {
  id: "7682728905966423334",
  text: "开头这句太绝了 #职场 #AI工具\n第二行…版本过低，升级后可展示全部信息",
  createTime: 1788776791,
  authorMeta: { id: "123", secUid: "MS4wLjABAAAA", name: "罗臣臣" },
  musicMeta: { name: "@罗臣臣创作的原声", author: "罗臣臣", isOriginal: true, duration: 60 },
  videoMeta: { cover: "https://p3/cover.jpg", originCover: "https://p3/origin.jpg", dinamicCover: "https://p3/dyn.webp", width: 1080, height: 1920, duration: 58432, playUrl: "https://www.douyin.com/aweme/v1/play/?video_id=v0" },
  thumb: "https://p3/thumb.jpg",
  statistics: { diggCount: 1184139, shareCount: 843877, commentCount: 36704, collectCount: 264848 },
  hashtags: [{ name: "职场" }, { name: "AI工具" }, {}],
};
const ref = { platform: "douyin" as const, externalId: "7682728905966423334", url: "https://www.douyin.com/video/7682728905966423334" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("收藏夹：读抖音视频", () => {
  it("actor 的一条 → 帖子：标题取文案第一行（去话题）、时长毫秒换秒、封面按候选顺序、被截断记一句", () => {
    const post = mapDouyinItem(item, ref.externalId);
    expect(post).toMatchObject({
      platform: "douyin",
      externalId: "7682728905966423334",
      kind: "video",
      title: "开头这句太绝了",
      text: "开头这句太绝了 #职场 #AI工具\n第二行…",
      author: { id: "MS4wLjABAAAA", name: "罗臣臣" },
      publishedAt: "2026-09-07T10:26:31.000Z",
      stats: { likes: 1184139, collects: 264848, comments: 36704, shares: 843877 },
      hashtags: ["职场", "AI工具"],
      topComments: [],
      music: "@罗臣臣创作的原声（原声）",
      video: { url: "https://www.douyin.com/aweme/v1/play/?video_id=v0", width: 1080, height: 1920, durationS: 58.4 },
      notes: ["文案被平台截断了，只读到前面一部分", "这条路读不到评论内容，只有评论数"],
    });
    expect(post.images).toEqual([{ url: "https://p3/dyn.webp", backupUrls: ["https://p3/origin.jpg", "https://p3/thumb.jpg", "https://p3/cover.jpg"], width: null, height: null }]);
  });

  it("不是原声的音乐带上作者；没有视频地址记一句", () => {
    const post = mapDouyinItem({ ...item, text: "一句话", musicMeta: { name: "晴天", author: "周杰伦", isOriginal: false }, videoMeta: { cover: "https://p3/cover.jpg" } }, ref.externalId);
    expect(post.music).toBe("晴天 — 周杰伦");
    expect(post.video).toBeNull();
    expect(post.notes).toEqual(["这条路读不到评论内容，只有评论数", "没有拿到视频地址，只读到了封面"]);
  });

  it("actor 说没读到 / 返回空：报读不到", () => {
    expect(() => mapDouyinItem({ error: true, message: "Couldn't get video data", inputUrl: ref.url }, ref.externalId)).toThrow(SourceFetchError);
    expect(() => mapDouyinItem(undefined, ref.externalId)).toThrow(/读不到/);
  });

  it("一次 Apify 运行：令牌放请求头、不进网址，跑成功记一笔（哪怕返回的是没读到）", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([item]), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchDouyinVideo(ref));
    expect(post.author.name).toBe("罗臣臣");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.apify.com/v2/acts/natanielsantos~douyin-scraper/run-sync-get-dataset-items?timeout=110");
    expect(url).not.toContain("apify_secret");
    expect(init.headers).toMatchObject({ authorization: "Bearer apify_secret" });
    expect(JSON.parse(String(init.body))).toEqual({ postUrls: [ref.url] });
    expect(counts).toEqual({ [DOUYIN_COUNT_KEY]: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ error: true }]), { status: 201 })));
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
