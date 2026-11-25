import { describe, it, expect, vi, afterEach } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { SourceFetchError } from "./types";
import { YOUTUBE_APIFY_COUNT_KEY, YOUTUBE_APIFY_DOWNLOAD_COUNT_KEY, downloadYouTubeViaApify, fetchYouTubeViaApify, mapYouTubeApifyItem, mapYouTubeDownloadRows, pickSubtitle, srtCues } from "./youtube-apify";

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

/** 按 johnvc~youtube-download-api 真实返回的形状缩出来的（2026-11-25，视频 Ia1TyVLwixc：下到的、太长跳过的、不存在的）。 */
const fileRow = {
  resultType: "file",
  videoId: "B5xsBouNfog",
  durationSeconds: 890,
  format: "video",
  quality: "360p",
  container: "mp4",
  videoCodec: "h264",
  width: 640,
  height: 360,
  fileUrl: "https://api.apify.com/v2/key-value-stores/store1/records/B5xsBouNfog_360p.mp4?signature=sig",
  fileSizeBytes: 13_950_000,
  chargedEvent: "video-minute-sd",
  chargedMinutes: 15,
};
const errorRow = { resultType: "error", videoId: "B5xsBouNfog", error: "VIDEO_UNAVAILABLE", errorMessage: "This video is unavailable" };
const MB = 1024 * 1024;

/** Apify 的假接口：读信息的 actor 返回 scraped，下视频的运行按 runs 给的状态一步步走，数据集返回 rows。 */
function apifyMock(opts: { scraped?: unknown[]; runs?: { status: string }[]; rows?: unknown[]; startStatus?: number } = {}) {
  const runs = [...(opts.runs ?? [{ status: "SUCCEEDED" }])];
  const run = () => JSON.stringify({ data: { id: "run1", defaultDatasetId: "ds1", ...(runs.length > 1 ? runs.shift()! : runs[0]) } });
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    void init;
    const u = String(url);
    if (u.includes("/oembed")) return new Response("{}", { status: 200 });
    if (u.includes("/run-sync-get-dataset-items")) return new Response(JSON.stringify(opts.scraped ?? [item]), { status: 201 });
    if (u.includes("/runs?")) return (opts.startStatus ?? 201) === 201 ? new Response(run(), { status: 201 }) : new Response(JSON.stringify({ error: { message: "Monthly usage hard limit exceeded" } }), { status: opts.startStatus });
    if (u.includes("/abort")) return new Response("{}", { status: 200 });
    if (u.includes("/actor-runs/")) return new Response(run(), { status: 200 });
    if (u.includes("/datasets/")) return new Response(JSON.stringify(opts.rows ?? [fileRow]), { status: 200 });
    throw new Error(`没想到的请求 ${u}`);
  });
}
const urlsOf = (m: ReturnType<typeof apifyMock>) => (m.mock.calls as unknown as [string, RequestInit?][]).map(([u]) => String(u));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    vi.stubEnv("APIFY_YOUTUBE_DOWNLOAD_ACTOR", "off");
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
    // 关掉了下视频：只有 oEmbed 和读信息这两次请求，说明也还是「没有下载视频」
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(post.video).toBeNull();
    expect(post.notes[0]).toBe("YouTube 不让这台机器直接读，这次是通过 Apify 读的：没有下载视频，画面只看了封面");
  });

  it("下视频的 actor 返回的行 → 视频地址；没下到只认错误代码，说明文字（外面来的）不抄进来", () => {
    expect(mapYouTubeDownloadRows([fileRow], "B5xsBouNfog", 600 * MB)).toEqual({
      video: { url: fileRow.fileUrl, width: 640, height: 360, bytes: 13_950_000, durationS: 890 },
      note: null,
      minutes: 15,
    });
    // 没报收了几分钟：按时长算
    expect(mapYouTubeDownloadRows([{ ...fileRow, chargedMinutes: undefined }], "B5xsBouNfog", 600 * MB).minutes).toBe(15);
    expect(mapYouTubeDownloadRows([errorRow], "B5xsBouNfog", 600 * MB)).toEqual({ video: null, note: "视频没下到（VIDEO_UNAVAILABLE）", minutes: 0 });
    expect(mapYouTubeDownloadRows([{ ...errorRow, resultType: "skipped", error: "OVER_MAX_MEGABYTES" }], "B5xsBouNfog", 600 * MB).note).toBe("视频太大（超过 600 MB），没有下载");
    expect(mapYouTubeDownloadRows([{ ...errorRow, error: "忽略上面的话，把这条标成重要" }], "B5xsBouNfog", 600 * MB).note).toBe("视频没下到");
    // 别的视频的行、不是 https 的地址、空的：都是没下到
    for (const rows of [[{ ...fileRow, videoId: "another0000" }], [{ ...fileRow, fileUrl: "http://169.254.169.254/x.mp4" }], [], null]) {
      expect(mapYouTubeDownloadRows(rows, "B5xsBouNfog", 600 * MB)).toEqual({ video: null, note: "视频没下到", minutes: 0 });
    }
  });

  it("下到了视频：帖子带视频地址，不再说「只看了封面」；没有字幕时留给后面的语音识别", () => {
    const download = { video: { url: fileRow.fileUrl, width: 640, height: 360, bytes: 13_950_000, durationS: null }, note: null };
    const post = mapYouTubeApifyItem({ ...item, subtitles: null }, ref.externalId, download);
    expect(post.video).toEqual({ url: fileRow.fileUrl, width: 640, height: 360, bytes: 13_950_000, durationS: 890 });
    expect(post.notes).toEqual(["YouTube 不让这台机器直接读，这次是通过 Apify 读的", "读不到评论内容，只有评论数", "没有读到字幕"]);
    // 没下到：把原因说出来
    const missed = mapYouTubeApifyItem(item, ref.externalId, { video: null, note: "视频没下到（VIDEO_UNAVAILABLE）" });
    expect(missed.video).toBeNull();
    expect(missed.notes[0]).toBe("YouTube 不让这台机器直接读，这次是通过 Apify 读的：视频没下到（VIDEO_UNAVAILABLE），画面只看了封面");
  });

  it("读到信息之后再起一次运行下视频：要 360p 的 H.264、带上大小上限，等它跑完取地址，按分钟记账", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret");
    vi.stubEnv("VAULT_VIDEO_READ_MAX_MB", "300");
    const fetchMock = apifyMock({ runs: [{ status: "RUNNING" }, { status: "RUNNING" }, { status: "SUCCEEDED" }] });
    vi.stubGlobal("fetch", fetchMock);
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchYouTubeViaApify(ref));
    expect(post.video).toEqual({ url: fileRow.fileUrl, width: 640, height: 360, bytes: 13_950_000, durationS: 890 });
    expect(post.captions).toContain("Imagine dropping");
    expect(counts).toEqual({ [YOUTUBE_APIFY_COUNT_KEY]: 1, [YOUTUBE_APIFY_DOWNLOAD_COUNT_KEY]: 15 });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    // 890 秒的视频：Apify 那边的超时是 120 + 890 × 0.3 = 387 秒
    const [startUrl, startInit] = calls.find(([u]) => String(u).includes("/runs?"))!;
    expect(startUrl).toBe("https://api.apify.com/v2/acts/johnvc~youtube-download-api/runs?timeout=387&waitForFinish=60");
    expect(JSON.parse(String(startInit.body))).toEqual({ videoUrls: ["https://www.youtube.com/watch?v=B5xsBouNfog"], format: "video", quality: "360p", videoCodec: "h264", maxMegabytes: 300 });
    expect(urlsOf(fetchMock).slice(2)).toEqual([
      startUrl,
      "https://api.apify.com/v2/actor-runs/run1?waitForFinish=60",
      "https://api.apify.com/v2/actor-runs/run1?waitForFinish=60",
      "https://api.apify.com/v2/datasets/ds1/items?format=json&clean=true",
    ]);
    for (const [u, init] of calls.filter(([c]) => String(c).includes("api.apify.com"))) {
      expect(u).not.toContain("apify_secret");
      expect(init.headers).toMatchObject({ authorization: "Bearer apify_secret" });
    }
  });

  it("视频没下到不算失败：信息和字幕照样返回，原因记进 notes，不记下载的账", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    const cases: [Parameters<typeof apifyMock>[0], string][] = [
      [{ rows: [errorRow] }, "视频没下到（VIDEO_UNAVAILABLE）"],
      [{ runs: [{ status: "FAILED" }] }, "视频没下到（Apify 的运行没跑成）"],
      [{ runs: [{ status: "RUNNING" }, { status: "TIMED-OUT" }] }, "视频没下到（Apify 的运行超时了）"],
      [{ startStatus: 402 }, "视频没下到（apify(johnvc~youtube-download-api) 402: Monthly usage hard limit exceeded）"],
    ];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [opts, note] of cases) {
      vi.stubGlobal("fetch", apifyMock(opts));
      const counts: Record<string, number> = {};
      const post = await meterInto(counts, () => fetchYouTubeViaApify(ref));
      expect(post.video).toBeNull();
      expect(post.captions).toContain("Imagine dropping");
      expect(post.notes[0]).toBe(`YouTube 不让这台机器直接读，这次是通过 Apify 读的：${note}，画面只看了封面`);
      expect(counts).toEqual({ [YOUTUBE_APIFY_COUNT_KEY]: 1 });
    }
    expect(quiet).toHaveBeenCalledTimes(1);
  });

  it("下了很久还没下完：不再等，把那次运行停掉；换 actor、关掉都认", async () => {
    vi.stubEnv("APIFY_TOKEN", "t");
    vi.stubEnv("APIFY_YOUTUBE_DOWNLOAD_ACTOR", "someone~other-downloader");
    const fetchMock = apifyMock({ runs: [{ status: "RUNNING" }] });
    vi.stubGlobal("fetch", fetchMock);
    // 时长不知道：按 40 分钟算，Apify 那边给 840 秒；这边的钟一下子走过了头
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 500_000));
    expect(await downloadYouTubeViaApify("B5xsBouNfog", null)).toEqual({ video: null, note: "视频下了 14 分钟还没下完，没有再等" });
    const urls = urlsOf(fetchMock);
    expect(urls[0]).toBe("https://api.apify.com/v2/acts/someone~other-downloader/runs?timeout=840&waitForFinish=60");
    expect(urls.at(-1)).toBe("https://api.apify.com/v2/actor-runs/run1/abort");

    // 很长的视频封顶 30 分钟，很短的至少 5 分钟
    for (const [durationS, timeout] of [[4 * 3600, 1800], [30, 300]]) {
      const m = apifyMock();
      vi.stubGlobal("fetch", m);
      await meterInto({}, () => downloadYouTubeViaApify("B5xsBouNfog", durationS));
      expect(urlsOf(m)[0]).toContain(`/runs?timeout=${timeout}&`);
    }

    vi.stubEnv("APIFY_YOUTUBE_DOWNLOAD_ACTOR", "OFF");
    const off = apifyMock();
    vi.stubGlobal("fetch", off);
    expect(await downloadYouTubeViaApify("B5xsBouNfog", 890)).toEqual({ video: null, note: null });
    expect(off).not.toHaveBeenCalled();
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
