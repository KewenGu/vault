import { describe, it, expect, vi, afterEach } from "vitest";
import { captionText, fetchYouTubeVideo, mapYouTubePlayer, parseWatchPage, pickCaptionTrack, pickFormat } from "./youtube";
import { SourceFetchError } from "./types";

/** 按 youtubei/v1/player（Android 客户端）真实返回的形状缩出来的（2026-10）。 */
const player = (over: Record<string, unknown> = {}) => ({
  playabilityStatus: { status: "OK" },
  videoDetails: {
    videoId: "aircAruvnKk",
    title: "But what is a neural network? #SoME",
    lengthSeconds: "1120",
    keywords: ["neural network", "deep learning", " "],
    channelId: "UCYO_jab_esuFRV4b17AJtAw",
    shortDescription: "What are the neurons, why are there layers?\n#deeplearning",
    thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/aircAruvnKk/default.jpg", width: 120 }, { url: "https://i.ytimg.com/vi/aircAruvnKk/hq720.jpg", width: 1280 }] },
    viewCount: "24654339",
    author: "3Blue1Brown",
    isLiveContent: false,
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&fmt=srv3", languageCode: "en" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&kind=asr", languageCode: "en", kind: "asr" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=zh-Hans", languageCode: "zh-Hans" },
      ],
    },
  },
  streamingData: { formats: [{ itag: 18, url: "https://rr4---sn.googlevideo.com/videoplayback?itag=18", mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 260_000, width: 640, height: 360, contentLength: "36533246" }] },
  ...over,
});
const ref = { platform: "youtube" as const, externalId: "aircAruvnKk", url: "https://www.youtube.com/watch?v=aircAruvnKk" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("收藏夹：读 YouTube 视频", () => {
  it("字幕 json3 → 带时间的文字：一条条接成段（到句末、约 300 字换段），每段开头标开始时间；自动字幕的换行占位跳过，中文之间不加空格", () => {
    const events = [
      { tStartMs: 0, segs: [{ utf8: "This is a 3." }] },
      { tStartMs: 900, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 1000, segs: [{ utf8: "It's sloppily" }, { utf8: " written\nand rendered" }] },
      { tStartMs: 2000 },
    ];
    expect(captionText({ events })).toBe("[0:00] This is a 3. It's sloppily written and rendered");
    expect(captionText({ events: [{ tStartMs: 65_000, segs: [{ utf8: "大家好" }] }, { tStartMs: 66_000, segs: [{ utf8: "今天讲三件事" }] }, { tStartMs: 68_000, segs: [{ utf8: "OK" }] }] })).toBe("[1:05] 大家好今天讲三件事 OK");
    const long = captionText({ events: Array.from({ length: 30 }, (_, i) => ({ tStartMs: i * 2000, segs: [{ utf8: `Sentence number ${i} goes here.` }] })) }).split("\n");
    expect(long.length).toBeGreaterThan(1);
    expect(long[0]).toMatch(/^\[0:00\] Sentence number 0 /);
    expect(long[1]).toMatch(/^\[0:\d\d\] Sentence number \d+ /);
    for (const p of long.slice(0, -1)) expect(p.length).toBeGreaterThanOrEqual(300);
    expect(captionText({ events }, 16)).toBe("[0:00] This is a");
    expect(captionText(null)).toBe("");
  });

  it("挑字幕轨道：视频原本语言里作者上传的 → 自动生成的 → 中文 → 英文 → 第一条", () => {
    const t = (languageCode: string, kind?: string) => ({ baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}${kind ? "&kind=asr" : ""}`, languageCode, kind });
    expect(pickCaptionTrack([t("de"), t("en"), t("en", "asr")])).toMatchObject({ languageCode: "en", auto: false });
    expect(pickCaptionTrack([t("de"), t("ja", "asr")])).toMatchObject({ languageCode: "ja", auto: true });
    expect(pickCaptionTrack([t("de"), t("en-US"), t("zh-Hans")])).toMatchObject({ languageCode: "zh-Hans" });
    expect(pickCaptionTrack([t("de"), t("en-US")])).toMatchObject({ languageCode: "en-US" });
    expect(pickCaptionTrack([t("de"), { languageCode: "fr" }])).toMatchObject({ languageCode: "de" });
    expect(pickCaptionTrack(undefined)).toBeNull();
  });

  it("挑视频：不超上限的最高清 mp4；没报大小的按码率 × 时长估；都超了给最小的", () => {
    const f = (height: number, contentLength?: string, bitrate?: number) => ({ url: `https://rr1.googlevideo.com/${height}`, mimeType: "video/mp4; codecs=avc1", width: (height * 16) / 9, height, contentLength, bitrate });
    expect(pickFormat([f(360, "30000000"), f(720, "90000000")], 600, 50_000_000)).toMatchObject({ url: "https://rr1.googlevideo.com/360", bytes: 30000000, durationS: 600 });
    expect(pickFormat([f(360, "30000000"), f(720, "45000000")], 600, 50_000_000)).toMatchObject({ height: 720 });
    expect(pickFormat([f(360, undefined, 400_000)], 600, 50_000_000)).toMatchObject({ bytes: 30_000_000 });
    expect(pickFormat([f(360, "80000000"), f(720, "90000000")], 600, 50_000_000)).toMatchObject({ height: 360, bytes: 80000000 });
    expect(pickFormat([{ url: "https://rr1.googlevideo.com/webm", mimeType: "video/webm" }, { url: "http://insecure/x", mimeType: "video/mp4" }], 600, 50_000_000)).toBeNull();
  });

  it("视频网页里顺手读发布时间和点赞数，读不到是 null", () => {
    expect(parseWatchPage('…"publishDate":"2017-10-05T08:11:25-07:00",…"likeCount":"564562",…')).toEqual({ publishedAt: "2017-10-05T15:11:25.000Z", likes: 564562 });
    expect(parseWatchPage("<html>改版了</html>")).toEqual({ publishedAt: null, likes: null });
  });

  it("播放接口的返回 → 帖子：观看数、点赞、字幕、封面按清晰度排、话题 = 正文里的 # + 关键词", () => {
    const post = mapYouTubePlayer(player(), { publishedAt: "2017-10-05T15:11:25.000Z", likes: 564562, captions: "This is a 3.", captionsAuto: false });
    expect(post).toMatchObject({
      platform: "youtube",
      externalId: "aircAruvnKk",
      kind: "video",
      title: "But what is a neural network? #SoME",
      text: "What are the neurons, why are there layers?\n#deeplearning",
      author: { id: "UCYO_jab_esuFRV4b17AJtAw", name: "3Blue1Brown" },
      publishedAt: "2017-10-05T15:11:25.000Z",
      stats: { views: 24654339, likes: 564562, collects: null, comments: null, shares: null },
      hashtags: ["SoME", "deeplearning", "neural network", "deep learning"],
      captions: "This is a 3.",
      video: { url: "https://rr4---sn.googlevideo.com/videoplayback?itag=18", width: 640, height: 360, bytes: 36533246, durationS: 1120 },
      notes: ["读不到评论"],
    });
    expect(post.images).toEqual([
      {
        url: "https://i.ytimg.com/vi/aircAruvnKk/maxresdefault.jpg",
        backupUrls: ["https://i.ytimg.com/vi/aircAruvnKk/sddefault.jpg", "https://i.ytimg.com/vi/aircAruvnKk/hq720.jpg", "https://i.ytimg.com/vi/aircAruvnKk/default.jpg", "https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg"],
      },
    ]);
  });

  it("竖屏（Shorts）先试竖版封面；自动字幕 / 没字幕各记一句", () => {
    const shorts = player({ streamingData: { formats: [{ url: "https://rr1.googlevideo.com/v", mimeType: "video/mp4", width: 360, height: 640, contentLength: "900000" }] } });
    expect(mapYouTubePlayer(shorts, { captions: "字幕", captionsAuto: true }).images[0].url).toBe("https://i.ytimg.com/vi/aircAruvnKk/oar2.jpg");
    expect(mapYouTubePlayer(shorts, { captions: "字幕", captionsAuto: true }).notes).toEqual(["读不到评论", "字幕是 YouTube 自动生成的，可能有错字"]);
    expect(mapYouTubePlayer(shorts, {}).notes).toEqual(["读不到评论", "没有读到字幕"]);
  });

  it("没有能直接下的视频：本机有 yt-dlp 就交给它，没有就记一句；直播不下视频", () => {
    const bare = player({ streamingData: {} });
    expect(mapYouTubePlayer(bare, { captions: "x", canYtdlp: true }).video).toEqual({ url: "https://www.youtube.com/watch?v=aircAruvnKk", via: "ytdlp", durationS: 1120 });
    const none = mapYouTubePlayer(bare, { captions: "x" });
    expect(none.video).toBeNull();
    expect(none.notes).toContain("没有拿到视频地址，只看了封面、字幕和简介");
    const live = mapYouTubePlayer(player({ videoDetails: { ...player().videoDetails, isLive: true } }), { captions: "x", canYtdlp: true });
    expect(live.video).toBeNull();
    expect(live.notes).toContain("这是一场直播，没有下载视频");
  });

  it("视频不存在 → 读不到；YouTube 不给看（要登录、年龄限制）→ 带上它给的原因", () => {
    expect(() => mapYouTubePlayer({ playabilityStatus: { status: "ERROR", reason: "This video is unavailable" } }, {})).toThrow("这个 YouTube 视频读不到：可能被删了、设成了私享，或者链接不对");
    expect(() => mapYouTubePlayer({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" } }, {})).toThrow("YouTube 不让读这个视频（Sign in to confirm your age）。可以把视频的标题、简介贴进来直接分析");
    expect(() => mapYouTubePlayer(null, {})).toThrow(SourceFetchError);
  });

  it("读一个视频：播放接口按 Android 客户端问，字幕按 json3 要（换掉地址里原来的格式），网页读不到不影响", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      if (url.includes("/youtubei/v1/player")) return json(player());
      if (url.includes("/watch?v=")) return new Response('"publishDate":"2017-10-05T08:11:25-07:00","likeCount":"564562"');
      if (url.includes("/api/timedtext")) return json({ events: [{ segs: [{ utf8: "This is a 3." }] }] });
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const post = await fetchYouTubeVideo(ref);
    expect(post).toMatchObject({ captions: "[0:00] This is a 3.", publishedAt: "2017-10-05T15:11:25.000Z", stats: { likes: 564562 }, notes: ["读不到评论"] });
    const playerCall = fetchMock.mock.calls.find((c) => c[0].includes("/youtubei/"))!;
    expect(playerCall[1]?.method).toBe("POST");
    expect(JSON.parse(String(playerCall[1]?.body))).toMatchObject({ videoId: "aircAruvnKk", context: { client: { clientName: "ANDROID" } } });
    // 作者上传的英文字幕（视频本来就是英文：有自动英文字幕），格式换成 json3
    expect(fetchMock.mock.calls.find((c) => c[0].includes("timedtext"))![0]).toBe("https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&fmt=json3");

    // 网页和字幕都读不到：帖子照样出来，记一句没有字幕
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/youtubei/") ? json(player()) : new Response("", { status: 429 }))));
    expect(await fetchYouTubeVideo(ref)).toMatchObject({ captions: null, publishedAt: null, stats: { likes: null }, notes: ["读不到评论", "没有读到字幕"] });
  });

  it("字幕地址不是 YouTube 自己的域名：不去读；播放接口出错是临时的（可重试）", async () => {
    const evil = player({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://evil.example/timedtext", languageCode: "en" }] } } });
    const fetchMock = vi.fn(async (url: string) => (url.includes("/youtubei/") ? json(evil) : new Response("")));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchYouTubeVideo(ref)).captions).toBeNull();
    expect(fetchMock.mock.calls.some((c) => c[0].includes("evil.example"))).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchYouTubeVideo(ref)).rejects.toThrow("YouTube 500：视频信息读不到，过一会儿再试");
    // 接口给的是别的视频（不该发生）：当读不到
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/youtubei/") ? json(player()) : new Response(""))));
    await expect(fetchYouTubeVideo({ ...ref, externalId: "jNQXAC9IVRw" })).rejects.toThrow(SourceFetchError);
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
