import { describe, it, expect, vi, beforeEach } from "vitest";
import { SourceFetchError, emptyStats, type FetchedPost } from "./types";

vi.mock("./xhs", () => ({ fetchXhsNote: vi.fn() }));
vi.mock("./douyin", () => ({ fetchDouyinVideo: vi.fn() }));
vi.mock("./tiktok", () => ({ fetchTikTokVideo: vi.fn() }));
vi.mock("./instagram", () => ({ fetchInstagramPost: vi.fn() }));
vi.mock("./youtube", () => ({ fetchYouTubeVideo: vi.fn() }));
vi.mock("./x", () => ({ fetchXPost: vi.fn() }));
vi.mock("./web", () => ({ fetchWebPage: vi.fn() }));
vi.mock("./ytdlp", async (orig) => ({ ...(await orig<object>()), ytdlpPath: vi.fn(), ytdlpInfo: vi.fn() }));

import { fetchDouyinVideo } from "./douyin";
import { fetchPost } from "./fetch-post";
import { fetchInstagramPost } from "./instagram";
import { VIDEO_MAX_BYTES } from "@/lib/media/files";
import { fetchTikTokVideo } from "./tiktok";
import { fetchWebPage } from "./web";
import { fetchXPost } from "./x";
import { fetchXhsNote } from "./xhs";
import { fetchYouTubeVideo } from "./youtube";
import { ytdlpInfo, ytdlpPath } from "./ytdlp";

const post = (platform: FetchedPost["platform"]): FetchedPost => ({ platform, externalId: "1", kind: "video", title: platform, text: "", author: { id: null, name: "" }, publishedAt: null, stats: emptyStats(), hashtags: [], topComments: [], images: [], video: null, music: null, notes: [] });
const ref = (platform: FetchedPost["platform"]) => ({ platform, externalId: "1", url: `https://example.com/${platform}` });
const info = { id: "1", title: "yt-dlp 读到的", description: "", uploader: "频道", uploaderId: null, durationS: 60, publishedAt: null, views: 5, likes: null, comments: null, shares: null, thumbnail: null, width: null, height: null, tags: [], extractor: "Youtube", isLive: false };

beforeEach(() => {
  vi.mocked(fetchXhsNote).mockReset().mockResolvedValue(post("xiaohongshu"));
  vi.mocked(fetchDouyinVideo).mockReset().mockResolvedValue(post("douyin"));
  vi.mocked(fetchTikTokVideo).mockReset().mockResolvedValue(post("tiktok"));
  vi.mocked(fetchInstagramPost).mockReset().mockResolvedValue(post("instagram"));
  vi.mocked(fetchYouTubeVideo).mockReset().mockResolvedValue(post("youtube"));
  vi.mocked(fetchXPost).mockReset().mockResolvedValue(post("x"));
  vi.mocked(fetchWebPage).mockReset().mockResolvedValue(post("web"));
  vi.mocked(ytdlpPath).mockReset().mockReturnValue(null);
  vi.mocked(ytdlpInfo).mockReset().mockResolvedValue(null);
});

describe("收藏夹：按平台读帖子", () => {
  it("每个平台走自己的读法；能挑视频档位的都带上转存上限", async () => {
    for (const p of ["xiaohongshu", "douyin", "tiktok", "instagram", "youtube", "x", "web"] as const) expect((await fetchPost(ref(p))).title).toBe(p);
    expect(vi.mocked(fetchXhsNote)).toHaveBeenCalledWith(ref("xiaohongshu"), VIDEO_MAX_BYTES);
    expect(vi.mocked(fetchTikTokVideo)).toHaveBeenCalledWith(ref("tiktok"), VIDEO_MAX_BYTES);
    expect(vi.mocked(fetchXPost)).toHaveBeenCalledWith(ref("x"), VIDEO_MAX_BYTES);
    expect(vi.mocked(fetchYouTubeVideo)).toHaveBeenCalledWith(ref("youtube"), VIDEO_MAX_BYTES, false);
    expect(vi.mocked(fetchDouyinVideo)).toHaveBeenCalledWith(ref("douyin"));
    expect(vi.mocked(fetchInstagramPost)).toHaveBeenCalledWith(ref("instagram"));
    expect(vi.mocked(fetchWebPage)).toHaveBeenCalledWith(ref("web"));
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
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
