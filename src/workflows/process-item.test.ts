import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { emptyStats, type FetchedPost, type ItemMedia, type PostSnapshot } from "@/lib/sources/types";
import type { Understanding } from "@/lib/vault/understand";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("@/lib/sources/fetch-post", () => ({ fetchPost: vi.fn() }));
vi.mock("@/lib/sources/ytdlp", async (orig) => ({ ...(await orig<object>()), ytdlpDownload: vi.fn() }));
vi.mock("@/lib/media/files", async (orig) => ({ ...(await orig<object>()), downloadRemote: vi.fn(), normalizeImage: vi.fn(), visionImage: vi.fn(async (data: Uint8Array) => data) }));
vi.mock("@/lib/media/frames", async (orig) => ({ ...(await orig<object>()), canDigestVideo: vi.fn(), digestVideo: vi.fn(), contactSheets: vi.fn() }));
vi.mock("@/lib/asr/volc", async (orig) => ({ ...(await orig<object>()), asrConfig: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/asr/openai", async (orig) => ({ ...(await orig<object>()), openaiAsrConfig: vi.fn(), transcribeWithOpenAI: vi.fn() }));
vi.mock("@/lib/asr/whisper-local", async (orig) => ({ ...(await orig<object>()), localWhisper: vi.fn(), whisperSetupHint: vi.fn(), transcribeLocally: vi.fn() }));
vi.mock("@/lib/vault/understand", async (orig) => ({ ...(await orig<object>()), understand: vi.fn() }));
vi.mock("@/lib/graph/merge", async (orig) => ({ ...(await orig<object>()), linkItemEntities: vi.fn(async () => ({ linked: 0, created: 0, merged: 0, edges: 0 })) }));

import { openaiAsrConfig, transcribeWithOpenAI } from "@/lib/asr/openai";
import { asrConfig } from "@/lib/asr/volc";
import { localWhisper, whisperSetupHint } from "@/lib/asr/whisper-local";
import { linkItemEntities } from "@/lib/graph/merge";
import { TooLargeError, VIDEO_MAX_BYTES, downloadRemote, normalizeImage } from "@/lib/media/files";
import { canDigestVideo, contactSheets, digestVideo } from "@/lib/media/frames";
import { fetchPost } from "@/lib/sources/fetch-post";
import { understand } from "@/lib/vault/understand";
import { processItem } from "./process-item";

const MB = 1024 * 1024;
const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const understanding = (over: Partial<Understanding> = {}): Understanding => ({
  title: "停止精神内耗的 9 个方法",
  contentType: "knowledge",
  category: "health",
  language: "zh",
  summary: "九个方法，逐条讲了做法。",
  points: [{ at: 65, text: "第一，别人的评价只是信息" }],
  card: [],
  quotes: [],
  tags: ["精神内耗", "情绪管理"],
  entities: [{ type: "person", name: "Michael大麦哥", about: "作者" }],
  relations: [],
  ocr: "",
  gaps: [],
  model: "claude-opus-5-5",
  ...over,
});

const post = (over: Partial<FetchedPost> = {}): FetchedPost => ({
  platform: "douyin",
  externalId: "7708299268364242185",
  kind: "video",
  title: "停止精神内耗的9个方法｜别再让自己这么累了 你有没有过这样的经历？明明一天没做多少事情",
  text: "停止精神内耗的9个方法｜别再让自己这么累了 #个人成长",
  author: { id: "a1", name: "Michael大麦哥" },
  publishedAt: "2026-11-15T12:00:00.000Z",
  stats: { ...emptyStats(), likes: 1_040_000 },
  hashtags: ["个人成长"],
  topComments: [],
  images: [{ url: "https://cdn.example/cover.jpg" }],
  video: { url: "https://cdn.example/video.mp4", width: 1920, height: 1080, bytes: null, durationS: 2318 },
  music: null,
  notes: ["这条路读不到评论内容，只有评论数"],
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: USER,
  source: "link",
  dedupe_key: "douyin:7708299268364242185",
  platform: "douyin",
  external_id: "7708299268364242185",
  url: "https://www.douyin.com/video/7708299268364242185",
  status: "fetching",
  error: null,
  kind: null,
  title: null,
  author: null,
  post: null,
  media: [],
  transcript: null,
  user_text: null,
  understanding: null,
  summary: null,
  content_type: null,
  category: null,
  tags: [],
  tags_locked: false,
  note: null,
  usage: {},
  cost_usd: 0,
  started_at: "2026-11-18T03:00:00.000Z",
  processed_at: null,
  created_at: "2026-11-18T03:00:00.000Z",
  updated_at: "2026-11-18T03:00:00.000Z",
  ...over,
});

type StoredItem = { status: string; error: string | null; title: string | null; summary: string | null; content_type: string | null; category: string | null; tags: string[]; transcript: string | null; search_text?: string; post: PostSnapshot; media: ItemMedia[] };
const item = () => fake.store.items[0] as unknown as StoredItem;
const roles = () => item().media.map((m) => m.role);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
const digest = (over: Record<string, unknown> = {}) => ({
  probe: { duration: 2318, hasAudio: true, width: 1920, height: 1080, fps: 30 },
  cuts: [{ at: 12.5, score: 0.6 }],
  frames: [
    { at: 0.2, cut: false, data: jpeg, width: 1024, height: 576 },
    { at: 600, cut: true, data: jpeg, width: 1024, height: 576 },
  ],
  overview: [{ at: 19.5, cut: false, data: jpeg }],
  motion: [],
  audio: { data: new Uint8Array([1, 2, 3]), seconds: 2318 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake = makeFakeSupabase({ items: [row()] }, { rpc: { tag_counts: () => [{ tag: "个人成长", n: 3 }], prune_orphan_entities: () => 0 } });
  vi.mocked(fetchPost).mockResolvedValue(post());
  vi.mocked(normalizeImage).mockResolvedValue({ data: jpeg, mime: "image/jpeg", width: 1280, height: 720 });
  vi.mocked(canDigestVideo).mockReturnValue(true);
  vi.mocked(digestVideo).mockResolvedValue(digest() as never);
  vi.mocked(contactSheets).mockResolvedValue([{ data: jpeg, width: 1040, height: 700, tiles: 1, from: 19.5, to: 19.5 }]);
  vi.mocked(asrConfig).mockReturnValue(null);
  vi.mocked(openaiAsrConfig).mockReturnValue({ apiKey: "k" });
  vi.mocked(transcribeWithOpenAI).mockResolvedValue({ text: "", cues: [{ at: 65, text: "第一，别人的评价只是信息" }], seconds: 2318 } as never);
  vi.mocked(localWhisper).mockReturnValue(null);
  vi.mocked(whisperSetupHint).mockReturnValue(null);
  vi.mocked(understand).mockResolvedValue(understanding());
});

describe("a video too large to archive", () => {
  const big = new Uint8Array(VIDEO_MAX_BYTES + 10 * MB);
  beforeEach(() => {
    vi.mocked(downloadRemote).mockImplementation(async (file) => (file.url.endsWith(".mp4") ? big : jpeg));
  });

  it("is still watched and listened to; only the original file is left out", async () => {
    await processItem(ID);
    // 下载时用的是「读」的上限，不是「存档」的上限
    const videoCall = vi.mocked(downloadRemote).mock.calls.find(([f]) => f.url.endsWith(".mp4"))!;
    expect(videoCall[1]).toBeGreaterThan(VIDEO_MAX_BYTES);
    // 画面和声音是从刚下载的那份数据里读的
    expect(vi.mocked(digestVideo).mock.calls).toHaveLength(1);
    expect(vi.mocked(digestVideo).mock.calls[0][0]).toBe(big);
    // 存下来的：封面、抽的帧、帧格——没有原片
    expect(roles()).toEqual(["image", "frame", "frame", "sheet"]);
    expect([...fake.files.keys()].some((k) => k.endsWith("video.mp4"))).toBe(false);
    expect(item().transcript).toBe("[1:05] 第一，别人的评价只是信息");
    expect(item().post.transcriptFrom).toBe("asr");
    expect(item().post.durationS).toBe(2318);
    expect(item().post.cuts).toEqual([12.5]);
    expect(item().post.notes).toEqual(["这条路读不到评论内容，只有评论数", `原片没有存档（${VIDEO_MAX_BYTES / MB + 10} MB，超过 ${VIDEO_MAX_BYTES / MB} MB 的上限）：画面和声音照常读，但这里不能播放，要看去原链接`]);
    expect(item().post.digestNotes).toEqual([]);
    // 模型拿到了口播和画面
    const input = vi.mocked(understand).mock.calls[0][0];
    expect(input.transcript).toContain("别人的评价只是信息");
    expect(input.images.map((i) => i.caption.slice(0, 2))).toEqual(["封面", "帧格", "视频", "视频"]);
    expect(item().status).toBe("ready");
    expect(item().error).toBeNull();
  });

  it("keeps the frames and transcript on re-analysis, when the original is no longer at hand", async () => {
    await processItem(ID);
    vi.mocked(digestVideo).mockClear();
    vi.mocked(understand).mockClear();
    Object.assign(item(), { status: "analyzing" });
    await processItem(ID);
    expect(digestVideo).not.toHaveBeenCalled();
    expect(roles()).toEqual(["image", "frame", "frame", "sheet"]);
    expect(vi.mocked(understand).mock.calls[0][0].transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");
  });

  it("says so when the sound track could not be extracted, instead of calling the video silent", async () => {
    vi.mocked(digestVideo).mockResolvedValue(digest({ audio: null }) as never);
    await processItem(ID);
    expect(item().post.digestNotes).toEqual(["音轨没导出来（ffmpeg 出错或超时），没有转写口播，只看了画面和文字"]);
    expect(item().transcript).toBeNull();
    expect(item().status).toBe("ready");
  });

  it("notes a cut-off transcript on videos longer than the transcription limit", async () => {
    vi.mocked(digestVideo).mockResolvedValue(digest({ probe: { duration: 5400, hasAudio: true, width: 1920, height: 1080, fps: 30 }, audio: { data: new Uint8Array([1]), seconds: 3600 } }) as never);
    await processItem(ID);
    expect(vi.mocked(digestVideo).mock.calls[0][2]).toMatchObject({ audioMaxSeconds: 3600 });
    expect(item().post.digestNotes).toEqual(["口播只转写了前 60 分钟（全长 90 分钟）"]);
  });
});

describe("a video beyond the read limit", () => {
  it("is not downloaded; the item is understood from cover and text, and says what it missed", async () => {
    vi.mocked(downloadRemote).mockImplementation(async (file) => {
      if (file.url.endsWith(".mp4")) throw new TooLargeError(900 * MB);
      return jpeg;
    });
    await processItem(ID);
    expect(digestVideo).not.toHaveBeenCalled();
    expect(roles()).toEqual(["image"]);
    expect(item().post.notes[1]).toBe("视频太大（900 MB），超过 600 MB 没有下载，只看了封面和文字");
    expect(item().status).toBe("ready");
  });
});

describe("a video that fails to download", () => {
  it("says why", async () => {
    vi.mocked(downloadRemote).mockImplementation(async (file) => {
      if (file.url.endsWith(".mp4")) throw new Error("下载文件(cdn.example) 失败：下载超时");
      return jpeg;
    });
    await processItem(ID);
    expect(item().post.notes[1]).toBe("视频没下载下来（下载文件(cdn.example) 失败：下载超时），只看了封面和文字");
    expect(item().status).toBe("ready");
  });
});

describe("a video the storage service refuses", () => {
  it("is still read; the page says the original was not kept and why", async () => {
    const data = new Uint8Array(120 * MB);
    vi.mocked(downloadRemote).mockImplementation(async (file) => (file.url.endsWith(".mp4") ? data : jpeg));
    // 存储桶 / 项目的单文件上限还是 50 MB 的项目：封面这种小文件收，视频不收
    const from = fake.db.storage.from.bind(fake.db.storage);
    vi.spyOn(fake.db.storage, "from").mockImplementation(((bucket: string) => {
      const api = from(bucket);
      const upload = api.upload as unknown as (path: string, body: Blob, opts: unknown) => Promise<unknown>;
      const refused = { data: null, error: { message: "The object exceeded the maximum allowed size" } };
      return { ...api, upload: (path: string, body: Blob, opts: unknown) => (path.endsWith("video.mp4") ? Promise.resolve(refused) : upload(path, body, opts)) };
    }) as never);
    await processItem(ID);
    expect(vi.mocked(digestVideo).mock.calls[0][0]).toBe(data);
    expect(roles()).toEqual(["image", "frame", "frame", "sheet"]);
    expect(item().post.notes[1]).toBe("原片没存进去（120 MB，存储服务的单文件上限不够，见 README「存档上限」）：画面和声音照常读，但这里不能播放，要看去原链接");
    expect(item().transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");
  });
});

describe("a video small enough to archive", () => {
  it("is stored, then read from storage in the next step", async () => {
    const small = new Uint8Array(3 * MB);
    vi.mocked(downloadRemote).mockImplementation(async (file) => (file.url.endsWith(".mp4") ? small : jpeg));
    await processItem(ID);
    expect([...fake.files.keys()].some((k) => k.endsWith(`${USER}/${ID}/video.mp4`))).toBe(true);
    expect(roles()).toEqual(["image", "video", "frame", "frame", "sheet"]);
    expect(vi.mocked(digestVideo).mock.calls).toHaveLength(1);
    expect(vi.mocked(digestVideo).mock.calls[0][0].byteLength).toBe(3 * MB);
    expect(item().media.find((m) => m.role === "video")?.durationS).toBe(2318);
    expect(item().post.notes).toEqual(["这条路读不到评论内容，只有评论数"]);
    expect(item().transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");
  });
});

describe("what gets saved from the understanding", () => {
  beforeEach(() => {
    vi.mocked(downloadRemote).mockResolvedValue(jpeg);
    vi.mocked(fetchPost).mockResolvedValue(post({ video: null, kind: "image" }));
  });

  it("replaces a caption-as-title with the model's title on platforms that have no real titles", async () => {
    await processItem(ID);
    expect(item().title).toBe("停止精神内耗的 9 个方法");
    expect(item().summary).toBe("九个方法，逐条讲了做法。");
    expect(item().content_type).toBe("knowledge");
    expect(item().category).toBe("health");
    expect(item().tags).toEqual(["精神内耗", "情绪管理"]);
    // 提标签时给模型看了这个人已有的标签
    expect(vi.mocked(understand).mock.calls[0][0].existingTags).toEqual(["个人成长"]);
    expect(vi.mocked(linkItemEntities).mock.calls[0][2]).toMatchObject({ userId: USER, itemId: ID, entities: [{ name: "Michael大麦哥" }] });
    expect(String(item().search_text)).toContain("第一，别人的评价只是信息");
  });

  it("keeps the platform's own title where there is one, and the user's tags once edited", async () => {
    fake = makeFakeSupabase({ items: [row({ platform: "youtube", dedupe_key: "youtube:abc", tags: ["我的标签"], tags_locked: true })] }, { rpc: { tag_counts: () => [] } });
    vi.mocked(fetchPost).mockResolvedValue(post({ platform: "youtube", title: "9 Ways to Stop Overthinking", video: null, kind: "image" }));
    await processItem(ID);
    expect(item().title).toBe("9 Ways to Stop Overthinking");
    expect(item().tags).toEqual(["我的标签"]);
  });

  it("keeps the previous result when a re-read fails", async () => {
    await processItem(ID);
    Object.assign(item(), { status: "fetching" });
    vi.mocked(fetchPost).mockRejectedValue(new Error("抖音读不到这条视频"));
    await processItem(ID);
    expect(item().status).toBe("ready");
    expect(item().error).toBe("重新读取没成，留着上次的结果：抖音读不到这条视频");
    expect(item().summary).toBe("九个方法，逐条讲了做法。");
  });

  it("fails clearly on a first read that cannot be done", async () => {
    vi.mocked(fetchPost).mockRejectedValue(new Error("读抖音视频要用 Apify（环境变量 APIFY_TOKEN 没配）"));
    await processItem(ID);
    expect(item().status).toBe("failed");
    expect(item().error).toContain("APIFY_TOKEN");
    expect(understand).not.toHaveBeenCalled();
  });
});
