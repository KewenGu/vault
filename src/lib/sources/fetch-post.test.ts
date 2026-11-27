import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SOURCE_PLATFORMS, SourceFetchError, emptyStats, type FetchedPost } from "./types";

vi.mock("./xhs", () => ({ fetchXhsNote: vi.fn() }));
vi.mock("./xhs-apify", async (orig) => ({ ...(await orig<object>()), fetchXhsViaApify: vi.fn() }));
vi.mock("./account-x", () => ({ fetchXThreadIds: vi.fn() }));
vi.mock("./douyin", () => ({ fetchDouyinVideo: vi.fn() }));
vi.mock("./tiktok", () => ({ fetchTikTokVideo: vi.fn() }));
vi.mock("./instagram", () => ({ fetchInstagramPost: vi.fn() }));
vi.mock("./youtube", async (orig) => ({ ...(await orig<object>()), fetchYouTubeVideo: vi.fn() }));
vi.mock("./youtube-apify", () => ({ fetchYouTubeViaApify: vi.fn() }));
vi.mock("./x", () => ({ readXPost: vi.fn() }));
vi.mock("./reddit", async (orig) => ({ ...(await orig<object>()), readRedditPost: vi.fn() }));
vi.mock("./web", () => ({ fetchWebPage: vi.fn() }));
vi.mock("./weibo", async (orig) => ({ ...(await orig<object>()), readWeiboPost: vi.fn() }));
vi.mock("./ytdlp", async (orig) => ({ ...(await orig<object>()), ytdlpPath: vi.fn(), ytdlpInfo: vi.fn() }));

import { fetchDouyinVideo } from "./douyin";
import { fetchPost, fetchPostAlone } from "./fetch-post";
import { fetchInstagramPost } from "./instagram";
import { VIDEO_MAX_BYTES } from "@/lib/media/files";
import { RedditArchiveMiss, readRedditPost } from "./reddit";
import { fetchTikTokVideo } from "./tiktok";
import { fetchWebPage } from "./web";
import { readWeiboPost } from "./weibo";
import { readXPost } from "./x";
import { fetchXhsNote } from "./xhs";
import { fetchXhsViaApify } from "./xhs-apify";
import { fetchXThreadIds } from "./account-x";
import { YouTubeBlockedError, fetchYouTubeVideo } from "./youtube";
import { fetchYouTubeViaApify } from "./youtube-apify";
import { ytdlpInfo, ytdlpPath } from "./ytdlp";

const post = (platform: FetchedPost["platform"]): FetchedPost => ({ platform, externalId: "1", kind: "video", title: platform, text: "", author: { id: null, name: "" }, publishedAt: null, stats: emptyStats(), hashtags: [], topComments: [], images: [], video: null, music: null, notes: [] });
const ref = (platform: FetchedPost["platform"]) => ({ platform, externalId: "1", url: `https://example.com/${platform}` });
const info = { id: "1", title: "yt-dlp 读到的", description: "", uploader: "频道", uploaderId: null, durationS: 60, publishedAt: null, views: 5, likes: null, comments: null, shares: null, thumbnail: null, width: null, height: null, tags: [], extractor: "Youtube", isLive: false };

beforeEach(() => {
  vi.mocked(fetchXhsNote).mockReset().mockResolvedValue(post("xiaohongshu"));
  vi.mocked(fetchXhsViaApify).mockReset().mockResolvedValue({ ...post("xiaohongshu"), title: "Apify 读到的", notes: ["这条路读不到评论内容，只有评论数"] });
  vi.mocked(fetchXThreadIds).mockReset().mockResolvedValue([]);
  vi.mocked(fetchDouyinVideo).mockReset().mockResolvedValue(post("douyin"));
  vi.mocked(fetchTikTokVideo).mockReset().mockResolvedValue(post("tiktok"));
  vi.mocked(fetchInstagramPost).mockReset().mockResolvedValue(post("instagram"));
  vi.mocked(fetchYouTubeVideo).mockReset().mockResolvedValue(post("youtube"));
  vi.mocked(readXPost).mockReset().mockResolvedValue({ post: post("x"), mentions: [] });
  vi.mocked(readRedditPost).mockReset().mockResolvedValue({ post: post("reddit"), mentions: [] });
  vi.mocked(fetchWebPage).mockReset().mockResolvedValue(post("web"));
  vi.mocked(readWeiboPost).mockReset().mockResolvedValue({ post: post("weibo"), mentions: [] });
  vi.mocked(ytdlpPath).mockReset().mockReturnValue(null);
  vi.mocked(ytdlpInfo).mockReset().mockResolvedValue(null);
  vi.mocked(fetchYouTubeViaApify).mockReset().mockResolvedValue({ ...post("youtube"), title: "Apify 读到的" });
  vi.stubEnv("APIFY_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("收藏夹：按平台读帖子", () => {
  it("每个平台走自己的读法；能挑视频档位的都带上转存上限", async () => {
    for (const p of SOURCE_PLATFORMS) expect((await fetchPost(ref(p))).title).toBe(p);
    expect(vi.mocked(fetchXhsNote)).toHaveBeenCalledWith(ref("xiaohongshu"), VIDEO_MAX_BYTES);
    expect(vi.mocked(fetchTikTokVideo)).toHaveBeenCalledWith(ref("tiktok"), VIDEO_MAX_BYTES);
    expect(vi.mocked(readXPost)).toHaveBeenCalledWith(ref("x"), VIDEO_MAX_BYTES);
    expect(vi.mocked(fetchYouTubeVideo)).toHaveBeenCalledWith(ref("youtube"), VIDEO_MAX_BYTES, false);
    expect(vi.mocked(fetchDouyinVideo)).toHaveBeenCalledWith(ref("douyin"));
    expect(vi.mocked(fetchInstagramPost)).toHaveBeenCalledWith(ref("instagram"));
    expect(vi.mocked(fetchWebPage)).toHaveBeenCalledWith(ref("web"));
    expect(vi.mocked(readRedditPost)).toHaveBeenCalledWith(ref("reddit"));
    expect(vi.mocked(readWeiboPost)).toHaveBeenCalledWith(ref("weibo"));
  });

  it("微博带的文章：跟着读（按网页），内容接在正文后面；没读到记一句", async () => {
    const article = { platform: "web" as const, externalId: "a1", url: "https://card.weibo.com/article/m/show/id/2309405369631686132718" };
    vi.mocked(readWeiboPost).mockResolvedValue({ post: { ...post("weibo"), kind: "text", text: "【夜读】与你共勉。" }, mentions: [{ how: "link", url: article.url, ref: article }] });
    const picture = "https://wx4.sinaimg.cn/large/0033ImPzly1ijfx6vj68zj60zk0k0gmn02.jpg";
    vi.mocked(fetchWebPage).mockResolvedValue({ ...post("web"), kind: "article", title: "头条文章", text: "不要低估每次微小的努力", author: { id: null, name: "" }, images: [{ url: "https://tvax4.sinaimg.cn/crop.0.0.1018.1018.180/avatar.jpg" }, { url: picture }, { url: "https://face.t.sinajs.cn/t4/appstyle/expression/ext/normal/7e/good.png" }, { url: "https://example.com/a.png" }] });
    const got = await fetchPost(ref("weibo"));
    // 文章里的图也在微博的图床上：下载要带 Referer；别处的图不带；页面上的头像、表情不算配图
    expect(got.images).toEqual([{ url: picture, headers: { referer: "https://weibo.com/" } }, { url: "https://example.com/a.png" }]);
    expect(got.kind).toBe("image");
    expect(got.platform).toBe("weibo");
    expect(got.text).toBe("【夜读】与你共勉。\n\n【链接的网页：card.weibo.com】《头条文章》\n不要低估每次微小的努力");
    expect(vi.mocked(fetchWebPage)).toHaveBeenCalledWith(article);
    // 文章页上只有头像：这条微博还是只有文字
    vi.mocked(fetchWebPage).mockResolvedValue({ ...post("web"), kind: "article", text: "正文", images: [{ url: "https://tvax4.sinaimg.cn/crop.0.0.1018.1018.180/avatar.jpg" }] });
    expect(await fetchPost(ref("weibo"))).toMatchObject({ kind: "text", images: [] });
    vi.mocked(fetchWebPage).mockRejectedValue(new SourceFetchError("这个网页读不到"));
    expect((await fetchPost(ref("weibo"))).notes).toContain(`链接的网页没读到（${article.url}）：这个网页读不到`);
  });

  it("Reddit 的链接帖：指向的链接跟着读（走那个平台的读法），内容接在正文后面", async () => {
    vi.mocked(readRedditPost).mockResolvedValue({ post: { ...post("reddit"), kind: "text", text: "链接：https://youtu.be/dQw4w9WgXcQ" }, mentions: [{ how: "link", url: "https://youtu.be/dQw4w9WgXcQ", ref: null }] });
    vi.mocked(fetchYouTubeVideo).mockResolvedValue({ ...post("youtube"), title: "视频标题", text: "视频简介", captions: "[00:01] 字幕" });
    const got = await fetchPost(ref("reddit"));
    expect(got.platform).toBe("reddit");
    expect(got.text).toContain("链接：https://youtu.be/dQw4w9WgXcQ");
    expect(got.text).toContain("视频简介");
    expect(vi.mocked(fetchYouTubeVideo).mock.calls[0][0]).toMatchObject({ platform: "youtube", externalId: "dQw4w9WgXcQ" });
  });

  it("跟着读到的 Reddit 帖子读到为止：它自己指向的链接不再跟", async () => {
    const reddit2 = { platform: "reddit" as const, externalId: "abc123", url: "https://www.reddit.com/comments/abc123" };
    vi.mocked(readXPost).mockResolvedValue({ post: { ...post("x"), text: "主帖" }, mentions: [{ how: "link", url: reddit2.url, ref: reddit2 }] });
    vi.mocked(readRedditPost).mockResolvedValue({ post: { ...post("reddit"), text: "Reddit 上的讨论" }, mentions: [{ how: "link", url: "https://example.com/a", ref: null }] });
    const got = await fetchPost({ platform: "x", externalId: "1", url: "https://x.com/i/status/1" });
    expect(got.text).toContain("Reddit 上的讨论");
    expect(vi.mocked(readRedditPost)).toHaveBeenCalledWith(reddit2);
    expect(vi.mocked(fetchWebPage)).not.toHaveBeenCalled();
  });

  it("Reddit 的存档里没有 / 存档出错：按网页再试一次，读到了说明是按网页读的；也读不到就说清楚是哪种情况", async () => {
    vi.mocked(readRedditPost).mockRejectedValue(new RedditArchiveMiss());
    vi.mocked(fetchWebPage).mockResolvedValue({ ...post("web"), title: "网页读到的", notes: ["正文是直接从网页里取的"] });
    const got = await fetchPost(ref("reddit"));
    expect(got).toMatchObject({ platform: "reddit", externalId: "1", title: "网页读到的" });
    expect(got.notes).toEqual(["第三方存档里还没有这条帖子，内容是按网页读的：没有点赞数，评论没有单独读", "正文是直接从网页里取的"]);
    expect(vi.mocked(fetchWebPage)).toHaveBeenCalledWith({ ...ref("reddit"), platform: "web" });

    vi.mocked(fetchWebPage).mockRejectedValue(new SourceFetchError("这个网页没读出正文"));
    await expect(fetchPost(ref("reddit"))).rejects.toThrow(/第三方存档里也还没有这一条（刚发的帖子要过一阵才收录/);
    await expect(fetchPost(ref("reddit"))).rejects.toBeInstanceOf(SourceFetchError);

    vi.mocked(readRedditPost).mockRejectedValue(new Error("Reddit 存档(arctic-shift.photon-reddit.com) 请求超时"));
    await expect(fetchPost(ref("reddit"))).rejects.toThrow(/第三方存档这会儿也读不了（Reddit 存档\(arctic-shift\.photon-reddit\.com\) 请求超时）/);
    vi.mocked(fetchWebPage).mockResolvedValue(post("web"));
    expect((await fetchPost(ref("reddit"))).notes[0]).toMatch(/^第三方存档这会儿读不了，内容是按网页读的/);

    // 存档说「这不是一条帖子」这类读不到：不换路，原样报
    const bad = new SourceFetchError("这不是一个 Reddit 帖子的链接");
    vi.mocked(readRedditPost).mockRejectedValue(bad);
    await expect(fetchPost(ref("reddit"))).rejects.toBe(bad);
  });

  it("X 帖子提到的东西跟着读：X 的走 X 的读法，别的链接走各自平台的读法，短链先跟跳转", async () => {
    const x2 = { ...post("x"), externalId: "2", text: "第二条" };
    vi.mocked(readXPost).mockImplementation(async (r) =>
      r.externalId === "1"
        ? { post: { ...post("x"), text: "主帖" }, mentions: [{ how: "link", url: "https://x.com/a/status/2", ref: { platform: "x", externalId: "2", url: "https://x.com/i/status/2" } }, { how: "link", url: "https://youtu.be/dQw4w9WgXcQ", ref: null }] }
        : { post: x2, mentions: [] }
    );
    vi.mocked(fetchYouTubeVideo).mockResolvedValue({ ...post("youtube"), text: "视频简介" });
    vi.stubGlobal("fetch", vi.fn());
    const got = await fetchPost({ platform: "x", externalId: "1", url: "https://x.com/i/status/1" });
    expect(got.text).toContain("第二条");
    expect(got.text).toContain("视频简介");
    expect(vi.mocked(readXPost)).toHaveBeenLastCalledWith({ platform: "x", externalId: "2", url: "https://x.com/i/status/2" }, VIDEO_MAX_BYTES);
    expect(vi.mocked(fetchYouTubeVideo).mock.calls[0][0]).toMatchObject({ platform: "youtube", externalId: "dQw4w9WgXcQ" });
    vi.unstubAllGlobals();
  });

  it("YouTube 不给读（要登录验证）：本机有 yt-dlp 就让它再试一次；没有 / 它也读不到就报原来的错", async () => {
    const blocked = new SourceFetchError("YouTube 不让读这个视频（Sign in to confirm you’re not a bot）");
    vi.mocked(fetchYouTubeVideo).mockRejectedValue(blocked);
    await expect(fetchPost(ref("youtube"))).rejects.toBe(blocked);
    expect(vi.mocked(ytdlpInfo)).not.toHaveBeenCalled();

    vi.mocked(ytdlpPath).mockReturnValue("/usr/local/bin/yt-dlp");
    await expect(fetchPost(ref("youtube"))).rejects.toBe(blocked);
    expect(vi.mocked(fetchYouTubeVideo)).toHaveBeenLastCalledWith(ref("youtube"), VIDEO_MAX_BYTES, true);

    vi.mocked(ytdlpInfo).mockResolvedValue(info);
    expect(await fetchPost(ref("youtube"))).toMatchObject({ platform: "youtube", externalId: "1", title: "yt-dlp 读到的", video: { via: "ytdlp", url: "https://example.com/youtube" } });
    // 网络错误（不是「读不到」）原样抛，留给重试
    vi.mocked(fetchYouTubeVideo).mockRejectedValue(new Error("YouTube 500"));
    await expect(fetchPost(ref("youtube"))).rejects.toThrow("YouTube 500");
  });

  it("YouTube 不给这台机器读（机房 IP）：配了 APIFY_TOKEN 就走 Apify；没配、视频本来就没了、yt-dlp 读到了都不走", async () => {
    const blocked = new YouTubeBlockedError("YouTube 不让读这个视频（Sign in to confirm you’re not a bot）");
    vi.mocked(fetchYouTubeVideo).mockRejectedValue(blocked);
    await expect(fetchPost(ref("youtube"))).rejects.toBe(blocked);
    expect(vi.mocked(fetchYouTubeViaApify)).not.toHaveBeenCalled();

    vi.stubEnv("APIFY_TOKEN", "t");
    expect((await fetchPost(ref("youtube"))).title).toBe("Apify 读到的");
    expect(vi.mocked(fetchYouTubeViaApify)).toHaveBeenCalledWith(ref("youtube"));
    // Apify 也没读到：报它的错
    vi.mocked(fetchYouTubeViaApify).mockRejectedValueOnce(new SourceFetchError("改走 Apify 也没读到"));
    await expect(fetchPost(ref("youtube"))).rejects.toThrow("改走 Apify 也没读到");

    // yt-dlp 读到了：不花这笔钱
    vi.mocked(fetchYouTubeViaApify).mockClear();
    vi.mocked(ytdlpPath).mockReturnValue("/usr/local/bin/yt-dlp");
    vi.mocked(ytdlpInfo).mockResolvedValue(info);
    expect((await fetchPost(ref("youtube"))).title).toBe("yt-dlp 读到的");
    // 视频被删了（不是被拦）：不走 Apify
    vi.mocked(ytdlpPath).mockReturnValue(null);
    const gone = new SourceFetchError("这个 YouTube 视频读不到");
    vi.mocked(fetchYouTubeVideo).mockRejectedValue(gone);
    await expect(fetchPost(ref("youtube"))).rejects.toBe(gone);
    expect(vi.mocked(fetchYouTubeViaApify)).not.toHaveBeenCalled();
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));

describe("小红书：没有访问口令、口令过期时换一条路", () => {
  const tokened = { platform: "xiaohongshu" as const, externalId: "1", url: "https://www.xiaohongshu.com/explore/1?xsec_token=ABC&xsec_source=pc_user" };
  const bare = { platform: "xiaohongshu" as const, externalId: "1", url: "https://www.xiaohongshu.com/explore/1" };
  const expired = new SourceFetchError("这篇笔记读不到：链接可能过期了");

  it("没配 APIFY_TOKEN：只有直接读这一条路，读不到就是读不到", async () => {
    expect((await fetchPost(tokened)).title).toBe("xiaohongshu");
    vi.mocked(fetchXhsNote).mockRejectedValue(expired);
    await expect(fetchPost(bare)).rejects.toBe(expired);
    expect(fetchXhsViaApify).not.toHaveBeenCalled();
  });

  it("配了 APIFY_TOKEN：有口令的先直接读（不花钱）；没有口令的（从博主那里存进来的）直接走 Apify", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    expect((await fetchPost(tokened)).title).toBe("xiaohongshu");
    expect(fetchXhsViaApify).not.toHaveBeenCalled();
    expect((await fetchPost(bare)).title).toBe("Apify 读到的");
    expect(fetchXhsNote).toHaveBeenCalledTimes(1);
  });

  it("口令过期了：按笔记 id 走 Apify，记一句是换了路读的；Apify 也说没有才是真的读不到；网络错误不换路", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    vi.mocked(fetchXhsNote).mockRejectedValue(expired);
    expect(await fetchPost(tokened)).toMatchObject({ title: "Apify 读到的", notes: ["链接里的访问口令失效了，这次是按笔记 id 另一条路读的", "这条路读不到评论内容，只有评论数"] });
    const gone = new SourceFetchError("这篇小红书笔记读不到：可能被删了、设成了私密，或者链接不对");
    vi.mocked(fetchXhsViaApify).mockRejectedValue(gone);
    await expect(fetchPost(tokened)).rejects.toBe(gone);
    vi.mocked(fetchXhsViaApify).mockClear();
    const network = new Error("小红书 502：页面打不开，过一会儿再试");
    vi.mocked(fetchXhsNote).mockRejectedValue(network);
    await expect(fetchPost(tokened)).rejects.toBe(network);
    expect(fetchXhsViaApify).not.toHaveBeenCalled();
  });
});

describe("X：从博主那里存进来的帖子把后面那一串也读进来", () => {
  it("要了才查一串帖子；后几条排在引用和链接前面跟着读，并在正文后面", async () => {
    const xPost = (id: string, text: string): FetchedPost => ({ ...post("x"), externalId: id, kind: "text", title: "", text, author: { id: null, name: "作者" } });
    vi.mocked(readXPost).mockImplementation(async (r) => ({ post: xPost(r.externalId, `第 ${r.externalId} 条`), mentions: [] }));
    await fetchPost(ref("x"));
    expect(fetchXThreadIds).not.toHaveBeenCalled();
    vi.mocked(fetchXThreadIds).mockResolvedValue(["2", "3"]);
    const got = await fetchPost(ref("x"), { thread: true });
    expect(vi.mocked(fetchXThreadIds).mock.calls).toEqual([["1"]]);
    expect(got.text).toBe("第 1 条\n\n【这一串的下一条：作者】\n第 2 条\n\n【这一串的下一条：作者】\n第 3 条");
  });

  it("查不到是不是一串：不算失败，记一句", async () => {
    vi.mocked(fetchXThreadIds).mockResolvedValue(null);
    const got = await fetchPost(ref("x"), { thread: true });
    expect(got.notes).toContain("没查到作者有没有接在这条后面继续发（查一串帖子的接口这会儿读不了）");
  });
});

describe("只读这一条（溯源用）", () => {
  it("X 帖子读到它本身为止，提到的东西原样带着、不跟着读；别的平台走各自的读法", async () => {
    const mentions = [{ how: "link" as const, url: "https://blog.example.com/a", ref: null }];
    vi.mocked(readXPost).mockResolvedValue({ post: post("x"), mentions });
    expect(await fetchPostAlone(ref("x"))).toEqual({ post: post("x"), mentions });
    expect(fetchWebPage).not.toHaveBeenCalled();
    expect(fetchXThreadIds).not.toHaveBeenCalled();

    vi.mocked(readRedditPost).mockResolvedValue({ post: post("reddit"), mentions: [{ how: "link", url: "https://youtu.be/x", ref: null }] });
    expect(await fetchPostAlone(ref("reddit"))).toEqual({ post: post("reddit"), mentions: [] });
    expect(fetchYouTubeVideo).not.toHaveBeenCalled();
    expect(await fetchPostAlone(ref("web"))).toEqual({ post: post("web"), mentions: [] });
  });
});
