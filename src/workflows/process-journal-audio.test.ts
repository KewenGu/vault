import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("@/lib/media/frames", async (orig) => ({ ...(await orig<object>()), canDigestVideo: vi.fn() }));
vi.mock("@/lib/media/audio", () => ({ extractSpeechAudio: vi.fn() }));
vi.mock("@/lib/vault/journal-audio", async (orig) => ({ ...(await orig<object>()), toPlayableAudio: vi.fn() }));
vi.mock("@/lib/vault/speech", async (orig) => ({ ...(await orig<object>()), transcribeSpeech: vi.fn() }));

import { extractSpeechAudio } from "@/lib/media/audio";
import { canDigestVideo } from "@/lib/media/frames";
import { toPlayableAudio } from "@/lib/vault/journal-audio";
import { transcribeSpeech } from "@/lib/vault/speech";
import { processJournalAudio } from "./process-journal-audio";

const USER = "11111111-1111-4111-8111-111111111111";
const ENTRY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MEDIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const DIR = `${USER}/journal/${ENTRY}`;
const RAW = `${DIR}/${MEDIA}-raw.webm`;
const PLAYABLE = `${DIR}/${MEDIA}.m4a`;

const row = () => fake.store.journal_media.find((r) => r.id === MEDIA)!;
const entryRow = () => fake.store.journal_entries[0];
const files = () => [...fake.files.keys()].sort();

function seed(media: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) {
  fake = makeFakeSupabase({
    journal_entries: [{ id: ENTRY, user_id: USER, day: "2026-11-21", title: "去了趟江边", style: "fresh", mood: "", weather: "", doc: { blocks: [{ id: "t", type: "text", text: "下午去了江边" }] }, rev: 2, search_text: "去了趟江边\n下午去了江边", created_at: "2026-11-21T10:00:00Z", updated_at: "2026-11-21T10:00:00Z", ...entry }],
    journal_media: [{ id: MEDIA, user_id: USER, entry_id: ENTRY, kind: "audio", status: "processing", error: null, path: RAW, mime: "audio/webm", bytes: 4000, transcript: null, notes: [], usage: {}, cost_usd: 0, ...media }],
  });
  fake.files.set(`vault/${RAW}`, { body: new Uint8Array([1, 2, 3]) });
}

beforeEach(() => {
  seed();
  vi.mocked(canDigestVideo).mockReset().mockReturnValue(true);
  vi.mocked(toPlayableAudio).mockReset().mockResolvedValue(new Uint8Array(900));
  vi.mocked(extractSpeechAudio).mockReset().mockResolvedValue({ probe: { duration: 34.26, hasAudio: true, width: null, height: null, fps: null }, data: new Uint8Array(100), seconds: 34.26 });
  vi.mocked(transcribeSpeech)
    .mockReset()
    .mockImplementation(async (counts) => {
      counts.asr_flash_sec = 35;
      return { transcript: "[0:02] 今天风特别大\n[0:11] 下次要少糖", cues: [], notes: [] };
    });
});

describe("processJournalAudio", () => {
  it("makes the recording playable, transcribes it, records the cost, and makes it searchable", async () => {
    await processJournalAudio(MEDIA, USER);
    expect(row()).toMatchObject({ status: "ready", error: null, path: PLAYABLE, mime: "audio/mp4", bytes: 900, duration_s: 34.26, transcript: "[0:02] 今天风特别大\n[0:11] 下次要少糖", notes: [], usage: { asr_flash_sec: 35 } });
    expect(row().cost_usd).toBeGreaterThan(0);
    // 换了格式：只留转好的那份
    expect(files()).toEqual([`vault/${PLAYABLE}`]);
    expect(entryRow().search_text).toBe("去了趟江边\n下午去了江边\n今天风特别大下次要少糖");
    // 转写不算「自己改了一次」：版本号不动，页面开着的那一份照常能保存
    expect(entryRow().rev).toBe(2);
    expect(vi.mocked(transcribeSpeech).mock.calls[0][2]).toBe("zh");
  });

  it("lets the recogniser pick the language when the page is written in English", async () => {
    seed({}, { title: "A walk by the river", doc: { blocks: [{ id: "t", type: "text", text: "Went out at three in the afternoon." }] } });
    await processJournalAudio(MEDIA, USER);
    expect(vi.mocked(transcribeSpeech).mock.calls[0][2]).toBeNull();
  });

  it("keeps an mp3 as it is (everything else is re-encoded so it plays and seeks everywhere)", async () => {
    seed({ path: `${DIR}/${MEDIA}-raw.mp3`, mime: "audio/mpeg" });
    fake.files.clear();
    fake.files.set(`vault/${DIR}/${MEDIA}-raw.mp3`, { body: new Uint8Array([1]) });
    await processJournalAudio(MEDIA, USER);
    expect(toPlayableAudio).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "ready", path: `${DIR}/${MEDIA}-raw.mp3`, mime: "audio/mpeg" });
    expect(files()).toEqual([`vault/${DIR}/${MEDIA}-raw.mp3`]);
  });

  it("without ffmpeg the recording is kept and the page is told what was not done", async () => {
    vi.mocked(canDigestVideo).mockReturnValue(false);
    await processJournalAudio(MEDIA, USER);
    expect(row()).toMatchObject({ status: "ready", path: RAW, transcript: null });
    expect(row().notes).toEqual([expect.stringContaining("没有 ffmpeg")]);
    expect(transcribeSpeech).not.toHaveBeenCalled();
    expect(files()).toEqual([`vault/${RAW}`]);
  });

  it("no speech recogniser configured: still ready and playable, with the reason listed", async () => {
    vi.mocked(transcribeSpeech).mockResolvedValue({ transcript: null, cues: [], notes: ["没有转写说的话：没配 VOLC_SPEECH_API_KEY；没配 OPENAI_API_KEY"] });
    await processJournalAudio(MEDIA, USER);
    expect(row()).toMatchObject({ status: "ready", path: PLAYABLE, transcript: null, notes: ["没有转写说的话：没配 VOLC_SPEECH_API_KEY；没配 OPENAI_API_KEY"] });
  });

  it("a failed conversion keeps the original and says so; a failed transcription does not lose the converted file", async () => {
    vi.mocked(toPlayableAudio).mockRejectedValue(new Error("ffmpeg 出错（退出码 1）"));
    await processJournalAudio(MEDIA, USER);
    expect(row()).toMatchObject({ status: "ready", path: RAW, transcript: "[0:02] 今天风特别大\n[0:11] 下次要少糖" });
    expect(row().notes).toEqual([expect.stringContaining("没能转成通用的格式")]);

    seed();
    vi.mocked(toPlayableAudio).mockResolvedValue(new Uint8Array(900));
    vi.mocked(extractSpeechAudio).mockRejectedValue(new Error("这个文件里没有声音"));
    await processJournalAudio(MEDIA, USER);
    expect(row()).toMatchObject({ status: "ready", path: PLAYABLE, transcript: null, notes: ["没有转成文字：这个文件里没有声音"] });
  });

  it("says how much of a long recording was transcribed", async () => {
    vi.mocked(extractSpeechAudio).mockResolvedValue({ probe: { duration: 5400, hasAudio: true, width: null, height: null, fps: null }, data: new Uint8Array(100), seconds: 3600 });
    await processJournalAudio(MEDIA, USER);
    expect(row().notes).toEqual(["只转写了前 60 分钟"]);
  });

  it("is marked failed when the file cannot be read at all", async () => {
    fake.files.clear();
    await processJournalAudio(MEDIA, USER);
    expect(row()).toMatchObject({ status: "failed", error: expect.stringContaining("读取录音失败") });
  });

  it("does nothing for a file that is not waiting, or not this user's", async () => {
    seed({ status: "ready" });
    await processJournalAudio(MEDIA, USER);
    expect(fake.ops).toEqual([]);
    seed();
    await processJournalAudio(MEDIA, "22222222-2222-4222-8222-222222222222");
    expect(row().status).toBe("processing");
    expect(transcribeSpeech).not.toHaveBeenCalled();
  });

  it("deleted while it was being processed: writes nothing back and leaves no file behind", async () => {
    vi.mocked(transcribeSpeech).mockImplementation(async () => {
      // 转写的这会儿，用户把这段录音删了
      fake.store.journal_media.length = 0;
      fake.files.delete(`vault/${RAW}`);
      return { transcript: "[0:02] 今天风特别大", cues: [], notes: [] };
    });
    await processJournalAudio(MEDIA, USER);
    expect(fake.store.journal_media).toEqual([]);
    expect(files()).toEqual([]);
    expect(entryRow().search_text).toBe("去了趟江边\n下午去了江边");
  });
});
