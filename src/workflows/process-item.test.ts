import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { emptyStats, type FetchedPost, type ItemMedia, type PostSnapshot } from "@/lib/sources/types";
import type { Understanding } from "@/lib/vault/understand";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("@/lib/sources/fetch-post", () => ({ fetchPost: vi.fn() }));
vi.mock("@/lib/sources/ytdlp", async (orig) => ({ ...(await orig<object>()), ytdlpDownload: vi.fn() }));
vi.mock("@/lib/media/files", async (orig) => ({ ...(await orig<object>()), downloadRemote: vi.fn(), downloadRemoteToFile: vi.fn(), normalizeImage: vi.fn(), visionImage: vi.fn(async (data: Uint8Array) => data) }));
vi.mock("@/lib/media/frames", async (orig) => ({ ...(await orig<object>()), canDigestVideo: vi.fn(), digestVideo: vi.fn(), digestVideoFile: vi.fn(), contactSheets: vi.fn() }));
vi.mock("@/lib/asr/volc", async (orig) => ({ ...(await orig<object>()), asrConfig: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/asr/openai", async (orig) => ({ ...(await orig<object>()), openaiAsrConfig: vi.fn(), transcribeWithOpenAI: vi.fn() }));
vi.mock("@/lib/asr/whisper-local", async (orig) => ({ ...(await orig<object>()), localWhisper: vi.fn(), whisperSetupHint: vi.fn(), transcribeLocally: vi.fn() }));
vi.mock("@/lib/vault/understand", async (orig) => ({ ...(await orig<object>()), understand: vi.fn() }));
vi.mock("@/lib/graph/merge", async (orig) => ({ ...(await orig<object>()), linkItemEntities: vi.fn(async () => ({ linked: 0, created: 0, merged: 0, edges: 0 })) }));

import { openaiAsrConfig, transcribeWithOpenAI } from "@/lib/asr/openai";
import { asrConfig } from "@/lib/asr/volc";
import { localWhisper, whisperSetupHint } from "@/lib/asr/whisper-local";
import { linkItemEntities } from "@/lib/graph/merge";
import { TooLargeError, VIDEO_MAX_BYTES, downloadRemote, downloadRemoteToFile, normalizeImage } from "@/lib/media/files";
import { canDigestVideo, contactSheets, digestVideo, digestVideoFile } from "@/lib/media/frames";
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
/**
 * 视频是直接下载到磁盘上的。这里假装下载了一个 `bytes` 大的视频：磁盘上只写几个字节（读它的 ffmpeg 都是替身），报的大小是 `bytes`。
 * 返回一个函数，告诉你它被写到了哪儿。
 */
const videoOnDisk = (bytes: number) => {
  let where = "";
  vi.mocked(downloadRemoteToFile).mockImplementation(async (_file, dest) => {
    where = dest;
    await writeFile(dest, jpeg);
    return bytes;
  });
  return () => where;
};
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
  vi.mocked(downloadRemote).mockResolvedValue(jpeg);
  vi.mocked(digestVideo).mockResolvedValue(digest() as never);
  vi.mocked(digestVideoFile).mockResolvedValue(digest() as never);
  vi.mocked(contactSheets).mockResolvedValue([{ data: jpeg, width: 1040, height: 700, tiles: 1, from: 19.5, to: 19.5 }]);
  vi.mocked(asrConfig).mockReturnValue(null);
  vi.mocked(openaiAsrConfig).mockReturnValue({ apiKey: "k" });
  vi.mocked(transcribeWithOpenAI).mockResolvedValue({ text: "", cues: [{ at: 65, text: "第一，别人的评价只是信息" }], seconds: 2318 } as never);
  vi.mocked(localWhisper).mockReturnValue(null);
  vi.mocked(whisperSetupHint).mockReturnValue(null);
  vi.mocked(understand).mockResolvedValue(understanding());
});

describe("a video too large to archive", () => {
  let source: () => string;
  beforeEach(() => {
    source = videoOnDisk(VIDEO_MAX_BYTES + 10 * MB);
  });

  it("is read from the original on disk, and nothing of the video is stored", async () => {
    await processItem(ID);
    // 视频下载到磁盘上，不进内存；下载时用的是「读」的上限，不是「存档」的上限
    expect(vi.mocked(downloadRemote).mock.calls.some(([f]) => f.url.endsWith(".mp4"))).toBe(false);
    const [file, dest, readMax] = vi.mocked(downloadRemoteToFile).mock.calls[0];
    expect(file.url).toBe("https://cdn.example/video.mp4");
    expect(dest).toBe(source());
    expect(readMax).toBeGreaterThan(VIDEO_MAX_BYTES);
    // 画面和声音只读一遍，读的是刚下载的原片，直接从磁盘上读
    expect(digestVideo).not.toHaveBeenCalled();
    expect(vi.mocked(digestVideoFile).mock.calls).toHaveLength(1);
    expect(vi.mocked(digestVideoFile).mock.calls[0][0]).toBe(source());
    // 大文件不测切点（省一遍整片解码）
    expect(vi.mocked(digestVideoFile).mock.calls[0][1]).toMatchObject({ detectCuts: false });
    // 读完之后磁盘上那份删掉了
    expect(existsSync(source())).toBe(false);
    // 存下来的：封面、抽的帧、帧格。视频本身不存，也不压副本
    expect(roles()).toEqual(["image", "frame", "frame", "sheet"]);
    expect([...fake.files.keys()].some((k) => k.endsWith("video.mp4"))).toBe(false);
    expect(item().transcript).toBe("[1:05] 第一，别人的评价只是信息");
    expect(item().post.transcriptFrom).toBe("asr");
    expect(item().post.durationS).toBe(2318);
    expect(item().post.cuts).toEqual([12.5]);
    const limit = VIDEO_MAX_BYTES / MB;
    expect(item().post.notes).toEqual(["这条路读不到评论内容，只有评论数", `原片没有存档（${limit + 10} MB，超过 ${limit} MB 的存档上限）：画面和声音照常读，但这里不能播放，要看去原链接`]);
    expect(item().post.digestNotes).toEqual([]);
    // 模型拿到了口播和画面
    const input = vi.mocked(understand).mock.calls[0][0];
    expect(input.transcript).toContain("别人的评价只是信息");
    expect(input.images.map((i) => i.caption.slice(0, 2))).toEqual(["封面", "帧格", "视频", "视频"]);
    expect(item().status).toBe("ready");
    expect(item().error).toBeNull();
  });

  it("keeps the frames and transcript read from the original on re-analysis", async () => {
    await processItem(ID);
    vi.mocked(digestVideoFile).mockClear();
    vi.mocked(understand).mockClear();
    Object.assign(item(), { status: "analyzing" });
    await processItem(ID);
    expect(digestVideo).not.toHaveBeenCalled();
    expect(digestVideoFile).not.toHaveBeenCalled();
    expect(roles()).toEqual(["image", "frame", "frame", "sheet"]);
    expect(vi.mocked(understand).mock.calls[0][0].transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");
  });

  it("keeps what was read from the original for items saved back when a compressed copy was stored", async () => {
    // 2026-11-19 之前存的大视频：存储桶里是压缩副本，帧和口播是当时从原片读的。重新分析时不从副本重读
    const dir = `${USER}/${ID}`;
    const media: ItemMedia[] = [
      { role: "video", path: `${dir}/video.mp4`, mime: "video/mp4", width: 640, height: 360, bytes: 44 * MB, durationS: 2318, compressed: true },
      { role: "frame", path: `${dir}/frame-01.jpg`, mime: "image/jpeg", width: 1024, height: 576, bytes: 3, at: 0.2 },
    ];
    fake = makeFakeSupabase({ items: [row({ status: "analyzing", kind: "video", media, transcript: "[1:05] 第一，别人的评价只是信息", post: { text: "停止精神内耗的9个方法", notes: [], digestNotes: [], transcriptFrom: "asr" } })] }, { rpc: { tag_counts: () => [], prune_orphan_entities: () => 0 } });
    await processItem(ID);
    expect(digestVideo).not.toHaveBeenCalled();
    expect(roles()).toEqual(["video", "frame"]);
    expect(vi.mocked(understand).mock.calls[0][0].transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");
  });

  it("says so when the sound track could not be extracted, instead of calling the video silent", async () => {
    vi.mocked(digestVideoFile).mockResolvedValue(digest({ audio: null }) as never);
    await processItem(ID);
    expect(item().post.digestNotes).toEqual(["音轨没导出来（ffmpeg 出错或超时），没有转写口播，只看了画面和文字"]);
    expect(item().transcript).toBeNull();
    expect(item().status).toBe("ready");
  });

  it("notes a cut-off transcript on videos longer than the transcription limit", async () => {
    vi.mocked(digestVideoFile).mockResolvedValue(digest({ probe: { duration: 5400, hasAudio: true, width: 1920, height: 1080, fps: 30 }, audio: { data: new Uint8Array([1]), seconds: 3600 } }) as never);
    await processItem(ID);
    expect(vi.mocked(digestVideoFile).mock.calls[0][1]).toMatchObject({ audioMaxSeconds: 3600 });
    expect(item().post.digestNotes).toEqual(["口播只转写了前 60 分钟（全长 90 分钟）"]);
  });
});

describe("a video beyond the read limit", () => {
  it("is not downloaded; the item is understood from cover and text, and says what it missed", async () => {
    vi.mocked(downloadRemoteToFile).mockRejectedValue(new TooLargeError(900 * MB));
    await processItem(ID);
    expect(digestVideo).not.toHaveBeenCalled();
    expect(digestVideoFile).not.toHaveBeenCalled();
    expect(roles()).toEqual(["image"]);
    expect(item().post.notes[1]).toBe("视频太大（900 MB），超过 600 MB 没有下载，只看了封面和文字");
    expect(item().status).toBe("ready");
  });
});

describe("a video that fails to download", () => {
  it("says why", async () => {
    vi.mocked(downloadRemoteToFile).mockRejectedValue(new Error("下载文件(cdn.example) 失败：下载超时"));
    await processItem(ID);
    expect(item().post.notes[1]).toBe("视频没下载下来（下载文件(cdn.example) 失败：下载超时），只看了封面和文字");
    expect(item().status).toBe("ready");
  });
});

describe("a video the storage service refuses", () => {
  it("is still read; the page says the original was not kept and why", async () => {
    // 存档上限设得比存储服务肯收的大时（VAULT_STORE_MAX_MB 调高了、套餐没跟上）：这里用一个上限以内的文件
    const source = videoOnDisk(40 * MB);
    // 存储桶 / 项目的单文件上限还是 50 MB 的项目：封面这种小文件收，视频不收
    const from = fake.db.storage.from.bind(fake.db.storage);
    vi.spyOn(fake.db.storage, "from").mockImplementation(((bucket: string) => {
      const api = from(bucket);
      const upload = api.upload as unknown as (path: string, body: Blob, opts: unknown) => Promise<unknown>;
      const refused = { data: null, error: { message: "The object exceeded the maximum allowed size" } };
      return { ...api, upload: (path: string, body: Blob, opts: unknown) => (path.endsWith("video.mp4") ? Promise.resolve(refused) : upload(path, body, opts)) };
    }) as never);
    const getBucket = vi.fn(async () => ({ data: { file_size_limit: 20 * MB } as { file_size_limit: number | null }, error: null }));
    Object.assign(fake.db.storage, { getBucket });
    await processItem(ID);
    // 没存进去的那份还在磁盘上：直接从那儿读，读完删掉
    expect(vi.mocked(digestVideoFile).mock.calls[0][0]).toBe(source());
    expect(existsSync(source())).toBe(false);
    expect(roles()).toEqual(["image", "frame", "frame", "sheet"]);
    // 存储桶的上限比文件小：点名是桶，给出要跑的迁移
    expect(item().post.notes[1]).toBe("原片没存进去（40 MB，存储桶的单文件上限是 20 MB：在 Supabase 的 SQL Editor 里运行迁移 20261118000001_bucket_limit.sql）：画面和声音照常读，但这里不能播放，要看去原链接");
    expect(item().transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");

    // 桶的上限够了还被拒：那就是项目全局的上限
    getBucket.mockResolvedValue({ data: { file_size_limit: 200 * MB }, error: null });
    Object.assign(item(), { status: "fetching" });
    await processItem(ID);
    expect(item().post.notes[1]).toBe("原片没存进去（40 MB，Supabase 项目的全局上传上限不够（免费套餐封顶 50 MB）：把 .env.local 里的 VAULT_STORE_MAX_MB 去掉或调回 50）：画面和声音照常读，但这里不能播放，要看去原链接");
  });
});

describe("a video small enough to archive", () => {
  it("is stored, then read from storage in the next step", async () => {
    const source = videoOnDisk(3 * MB);
    await processItem(ID);
    expect([...fake.files.keys()].some((k) => k.endsWith(`${USER}/${ID}/video.mp4`))).toBe(true);
    expect(roles()).toEqual(["image", "video", "frame", "frame", "sheet"]);
    expect(item().media.find((m) => m.role === "video")?.bytes).toBe(3 * MB);
    // 下载的那份存进存储桶之后就删了；画面和声音是下一步从存储桶里取出来读的
    expect(existsSync(source())).toBe(false);
    expect(digestVideoFile).not.toHaveBeenCalled();
    expect(vi.mocked(digestVideo).mock.calls).toHaveLength(1);
    expect(vi.mocked(digestVideo).mock.calls[0][0]).toEqual(jpeg);
    expect(vi.mocked(digestVideo).mock.calls[0][2]).toMatchObject({ detectCuts: true });
    expect(item().media.find((m) => m.role === "video")?.durationS).toBe(2318);
    expect(item().post.notes).toEqual(["这条路读不到评论内容，只有评论数"]);
    expect(item().transcript).toContain("别人的评价只是信息");
    expect(item().status).toBe("ready");
  });
});

describe("what gets saved from the understanding", () => {
  beforeEach(() => {
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
