import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchXPost, mapFxTweet, mapSyndicationTweet, syndicationToken } from "./x";
import { SourceFetchError } from "./types";

/** 按 api.fxtwitter.com 真实返回的形状缩出来的（2026-10）。 */
const fx = (over: Record<string, unknown> = {}) => ({
  id: "2106418403661779046",
  text: "三个让新人少走弯路的习惯 #职场 #AI工具\n第二行 https://t.co/abc",
  author: { id: "79526964", name: "某某", screen_name: "someone" },
  replies: 12,
  retweets: 30,
  quotes: 5,
  likes: 400,
  bookmarks: 220,
  views: 51000,
  created_timestamp: 1791044257,
  ...over,
});
const video = {
  url: "https://video.twimg.com/v/720.mp4",
  thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
  duration: 12.9,
  width: 640,
  height: 640,
  variants: [
    { url: "https://video.twimg.com/v/pl.m3u8", content_type: "application/x-mpegURL" },
    { url: "https://video.twimg.com/v/320.mp4", content_type: "video/mp4", bitrate: 320_000 },
    { url: "https://video.twimg.com/v/720.mp4", content_type: "video/mp4", bitrate: 832_000 },
  ],
};
const ref = { platform: "x" as const, externalId: "2106418403661779046", url: "https://x.com/someone/status/2106418403661779046" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("收藏夹：读 X 帖子", () => {
  it("配图帖：标题取第一行（去话题和链接），作者是「名字 @账号」，互动数按 X 的叫法对上（书签 = 收藏、回复 = 评论、转发含引用）", () => {
    const post = mapFxTweet(fx({ media: { photos: [{ url: "https://pbs.twimg.com/a.jpg?name=orig", width: 1200, height: 900 }, { url: "https://pbs.twimg.com/b.jpg", width: 1, height: 1 }] } }));
    expect(post).toMatchObject({
      platform: "x",
      externalId: "2106418403661779046",
      kind: "image",
      title: "三个让新人少走弯路的习惯",
      author: { id: "79526964", name: "某某 @someone" },
      publishedAt: "2026-10-03T16:17:37.000Z",
      stats: { views: 51000, likes: 400, collects: 220, comments: 12, shares: 35 },
      hashtags: ["职场", "AI工具"],
      video: null,
      notes: ["读不到回复的内容，只有回复数"],
    });
    expect(post.images).toEqual([
      { url: "https://pbs.twimg.com/a.jpg?name=orig", width: 1200, height: 900 },
      { url: "https://pbs.twimg.com/b.jpg", width: 1, height: 1 },
    ]);
  });

  it("视频帖：挑估算大小不超上限的最高码率 mp4，更低的档当备用；封面当图", () => {
    const post = mapFxTweet(fx({ media: { videos: [video] } }));
    expect(post.kind).toBe("video");
    expect(post.video).toEqual({ url: "https://video.twimg.com/v/720.mp4", backupUrls: ["https://video.twimg.com/v/320.mp4"], bytes: 1341600, width: 640, height: 640, durationS: 12.9 });
    expect(post.images).toEqual([{ url: "https://pbs.twimg.com/thumb.jpg", width: 640, height: 640 }]);
    // 上限很小：换成能放下的那档
    expect(mapFxTweet(fx({ media: { videos: [video] } }), 600_000).video).toMatchObject({ url: "https://video.twimg.com/v/320.mp4", backupUrls: [] });
    // 好几个视频只存第一个
    expect(mapFxTweet(fx({ media: { videos: [video, video] } })).notes).toContain("这条帖子有 2 个视频，只存了第一个");
  });

  it("纯文字帖：引用的帖子和链接卡片拼进正文（卡片图当配图）；回复、社区备注记一句", () => {
    const post = mapFxTweet(
      fx({
        text: "这个观点我不同意",
        replying_to: "other",
        community_note: { text: "原文数据\n有误" },
        quote: { text: "被引用的原话", author: { screen_name: "quoted" } },
        card: { title: "文章标题", description: "文章摘要", domain: "example.com", image: { url: "https://pbs.twimg.com/card.jpg", width: 800, height: 419 } },
      })
    );
    expect(post.kind).toBe("text");
    expect(post.text).toBe("这个观点我不同意\n\n【引用 @quoted 的帖子】\n被引用的原话\n\n【链接卡片】文章标题\n文章摘要（example.com）");
    expect(post.images).toEqual([{ url: "https://pbs.twimg.com/card.jpg", width: 800, height: 419 }]);
    expect(post.notes).toEqual(["读不到回复的内容，只有回复数", "这是回 @other 的一条回复，上文没读到", "帖子下有社区备注：原文数据 有误"]);
  });

  it("备用接口（官方嵌入）：t.co 短链换回原链接、图片占位短链去掉；没有转发 / 书签 / 浏览量并记一句", () => {
    const post = mapSyndicationTweet({
      __typename: "Tweet",
      id_str: "643211948184596480",
      text: "看这篇 https://t.co/aaa https://t.co/img",
      entities: { urls: [{ url: "https://t.co/aaa", expanded_url: "https://example.com/post" }], media: [{ url: "https://t.co/img" }] },
      favorite_count: 138,
      conversation_count: 4,
      created_at: "2015-09-13T23:57:33.000Z",
      user: { id_str: "549749560", name: "某号", screen_name: "handle" },
      mediaDetails: [{ type: "video", media_url_https: "https://pbs.twimg.com/t.jpg", original_info: { width: 640, height: 640 }, video_info: { duration_millis: 12922, variants: [{ content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/a.mp4" }] } }],
      note_tweet: { id: "n" },
    });
    expect(post).toMatchObject({
      kind: "video",
      title: "看这篇",
      text: "看这篇 https://example.com/post",
      author: { id: "549749560", name: "某号 @handle" },
      publishedAt: "2015-09-13T23:57:33.000Z",
      stats: { views: null, likes: 138, collects: null, comments: 4, shares: null },
      video: { url: "https://video.twimg.com/a.mp4", width: 640, height: 640, durationS: 12.9 },
      notes: ["这次走的是备用接口：没有转发数、书签数、浏览量", "读不到回复的内容，只有回复数", "这是一条长帖，只读到了开头一段"],
    });
    // 敏感 / 太老的帖子返回 {}；墓碑（TweetTombstone）也是读不到
    expect(() => mapSyndicationTweet({})).toThrow(SourceFetchError);
    expect(() => mapSyndicationTweet({ __typename: "TweetTombstone", id_str: "1" })).toThrow(/读不到/);
  });

  it("嵌入接口的校验参数按帖子 id 算（和官方脚本一致）", () => {
    expect(syndicationToken("643211948184596480")).toBe(((643211948184596480 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ""));
    expect(syndicationToken("2106418403661779046")).toMatch(/^[0-9a-z]+$/);
  });

  it("先问 FxTwitter；它不行（限流、返回网页）就换官方嵌入接口", async () => {
    const ok = vi.fn(async (url: string) => (url.includes("fxtwitter") ? json({ code: 200, tweet: fx() }) : json({})));
    vi.stubGlobal("fetch", ok);
    expect((await fetchXPost(ref)).stats.views).toBe(51000);
    expect(ok.mock.calls.map((c) => c[0])).toEqual(["https://api.fxtwitter.com/i/status/2106418403661779046"]);

    const html = vi.fn(async (url: string) =>
      url.includes("fxtwitter") ? new Response("<html>rate limited</html>", { status: 429 }) : json({ __typename: "Tweet", id_str: ref.externalId, text: "备用读到的", favorite_count: 3, user: { screen_name: "a" } })
    );
    vi.stubGlobal("fetch", html);
    const post = await fetchXPost(ref);
    expect(post.text).toBe("备用读到的");
    expect(html.mock.calls[1][0]).toBe(`https://cdn.syndication.twimg.com/tweet-result?id=${ref.externalId}&token=${syndicationToken(ref.externalId)}&lang=en`);
  });

  it("帖子不在了 / 私密账号：直接报读不到，不再换接口；两边都没有也是读不到", async () => {
    const gone = vi.fn(async () => json({ code: 404, message: "NOT_FOUND", tweet: null }, 404));
    vi.stubGlobal("fetch", gone);
    await expect(fetchXPost(ref)).rejects.toThrow(SourceFetchError);
    expect(gone).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 401, message: "PRIVATE_TWEET" }, 401)));
    await expect(fetchXPost(ref)).rejects.toThrow("这条 X 帖子是私密账号发的，读不了。可以把帖子文字贴进来直接分析");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("fxtwitter") ? Promise.reject(new TypeError("fetch failed")) : json({}))));
    await expect(fetchXPost(ref)).rejects.toThrow(SourceFetchError);
    vi.restoreAllMocks();
  });
});

vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
