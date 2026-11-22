import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/process-journal-audio", () => ({ processJournalAudio: vi.fn() }));
vi.mock("@/lib/media/files", async (orig) => ({ ...(await orig<object>()), archiveImage: vi.fn() }));

import { start } from "workflow/api";
import { archiveImage } from "@/lib/media/files";
import { processJournalAudio } from "@/workflows/process-journal-audio";
import { VaultError } from "./errors";
import { beginMediaUpload, createEntryFor, finishMediaUpload, getEntryDetail, listEntryMedia, listMyEntries, removeEntry, removeMedia, retryMedia, saveEntry, toMediaView } from "./journal-service";
import type { JournalMedia } from "./journal-store";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const E2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const E3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const THEIRS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const M1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const M3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";

const entry = (id: string, day: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  day,
  title: "",
  style: "fresh",
  mood: "",
  weather: "",
  doc: { v: 1, blocks: [], decos: [], strokes: [] },
  rev: 0,
  search_text: "",
  created_at: `${day}T10:00:00Z`,
  updated_at: `${day}T10:00:00Z`,
  ...over,
});

const media = (id: string, entryId: string, kind: "image" | "audio", over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  entry_id: entryId,
  kind,
  status: "ready",
  error: null,
  path: `${USER}/journal/${entryId}/${id}.${kind === "image" ? "jpg" : "m4a"}`,
  mime: kind === "image" ? "image/jpeg" : "audio/mp4",
  bytes: 1000,
  width: null,
  height: null,
  duration_s: null,
  transcript: null,
  notes: [],
  usage: {},
  cost_usd: 0,
  started_at: new Date().toISOString(),
  created_at: "2026-11-21T10:00:00Z",
  updated_at: "2026-11-21T10:00:00Z",
  ...over,
});

const session = (user = USER) => ({ user: { id: user }, db: fake.db }) as unknown as Session;
const rows = (table: string) => fake.store[table] ?? [];
const row = (table: string, id: string) => rows(table).find((r) => r.id === id)!;
const text = (id: string, t: string) => ({ id, type: "text", text: t });
const putFile = (path: string) => fake.files.set(`vault/${path}`, { body: new Uint8Array([1, 2, 3]) });

beforeEach(() => {
  vi.mocked(start).mockReset();
  vi.mocked(archiveImage).mockReset();
  fake = makeFakeSupabase({ journal_entries: [], journal_media: [] }, { uuidIds: true });
});

describe("createEntryFor", () => {
  it("needs a real day from the browser", async () => {
    await expect(createEntryFor(session(), { day: "2026-02-30" })).rejects.toThrow(VaultError);
    await expect(createEntryFor(session(), { day: undefined })).rejects.toThrow("日期不对");
    expect(rows("journal_entries")).toHaveLength(0);
  });

  it("opens a new page in the style of the page touched last", async () => {
    fake.store.journal_entries.push(entry(E1, "2026-11-19", { style: "geek", updated_at: "2026-11-20T08:00:00Z", doc: { blocks: [text("t", "写过")] } }), entry(E2, "2026-11-20", { style: "kawaii", updated_at: "2026-11-20T07:00:00Z", title: "昨天" }));
    const id = await createEntryFor(session(), { day: "2026-11-21" });
    expect(row("journal_entries", id)).toMatchObject({ user_id: USER, day: "2026-11-21", style: "geek" });
  });

  it("goes back to the day's last page while it is still blank, instead of piling up empty ones", async () => {
    fake.store.journal_entries.push(entry(E1, "2026-11-21"));
    expect(await createEntryFor(session(), { day: "2026-11-21" })).toBe(E1);
    expect(rows("journal_entries")).toHaveLength(1);
  });

  it("a page with writing, a title or a file on it is not blank", async () => {
    fake.store.journal_entries.push(entry(E1, "2026-11-21"));
    fake.store.journal_media.push(media(M1, E1, "audio", { status: "uploading" }));
    const second = await createEntryFor(session(), { day: "2026-11-21" });
    expect(second).not.toBe(E1);
    expect(rows("journal_entries")).toHaveLength(2);
  });
});

describe("saveEntry", () => {
  beforeEach(() => {
    fake.store.journal_entries.push(entry(E1, "2026-11-21", { rev: 3 }), { ...entry(THEIRS, "2026-11-21"), user_id: OTHER });
    fake.store.journal_media.push(media(M1, E1, "audio", { transcript: "[0:02] 码头那家店的桂花拿铁" }));
  });

  it("saves what was given, bumps the version, and rebuilds the search text with what the recordings said", async () => {
    const doc = { blocks: [text("t1", "下午去了江边"), { id: "a1", type: "audio", media: M1 }, { id: "bad", type: "nope" }] };
    expect(await saveEntry(session(), E1, { title: "  去了趟\n江边 ", mood: "开心", weather: "下冰雹", style: "y2k", doc, rev: 3 })).toEqual({ rev: 4 });
    const saved = row("journal_entries", E1);
    expect(saved).toMatchObject({ title: "去了趟 江边", mood: "开心", weather: "", style: "y2k", rev: 4 });
    expect((saved.doc as { blocks: unknown[] }).blocks).toHaveLength(2);
    expect(saved.search_text).toBe("去了趟 江边\n开心\n下午去了江边\n码头那家店的桂花拿铁");
  });

  it("does not overwrite a page that was changed somewhere else", async () => {
    await expect(saveEntry(session(), E1, { title: "旧标签页里的", rev: 2 })).rejects.toMatchObject({ status: 409 });
    expect(row("journal_entries", E1)).toMatchObject({ title: "", rev: 3 });
  });

  it("without a version it saves over whatever is there", async () => {
    expect(await saveEntry(session(), E1, { title: "接口来的" })).toEqual({ rev: 4 });
  });

  it("refuses a day that does not exist", async () => {
    await expect(saveEntry(session(), E1, { day: "2026-11-31", rev: 3 })).rejects.toThrow("日期不对");
    expect(row("journal_entries", E1).day).toBe("2026-11-21");
  });

  it("cannot reach someone else's page", async () => {
    await expect(saveEntry(session(), THEIRS, { title: "抢" })).rejects.toMatchObject({ status: 404 });
    await expect(getEntryDetail(session(), THEIRS)).rejects.toMatchObject({ status: 404 });
    await expect(removeEntry(session(), THEIRS)).rejects.toMatchObject({ status: 404 });
    expect(row("journal_entries", THEIRS).title).toBe("");
  });
});

describe("listMyEntries / getEntryDetail", () => {
  beforeEach(() => {
    fake.store.journal_entries.push(
      entry(E1, "2026-11-19", { title: "周四", search_text: "周四\n加班 吃了面", doc: { blocks: [text("t", "加班，吃了面")] } }),
      entry(E2, "2026-11-21", { search_text: "去了江边 桂花拿铁", doc: { blocks: [text("t", "去了江边"), { id: "p", type: "photo", media: M1, caption: "" }, { id: "a", type: "audio", media: M2 }] } }),
      entry(E3, "2026-11-21", { title: "晚上", created_at: "2026-11-21T20:00:00Z", search_text: "晚上\n整理导图" }),
      { ...entry(THEIRS, "2026-11-22", { search_text: "别人的 江边" }), user_id: OTHER }
    );
    fake.store.journal_media.push(media(M1, E2, "image"), media(M2, E2, "audio"), media(M3, E2, "image"));
  });

  it("lists my pages newest day first, later page first within a day", async () => {
    const { entries, more } = await listMyEntries(session());
    expect(entries.map((e) => e.id)).toEqual([E3, E2, E1]);
    expect(more).toBe(false);
  });

  it("counts the files that are on the page, not the ones that never made it in", async () => {
    const e2 = (await listMyEntries(session())).entries.find((e) => e.id === E2)!;
    expect(e2).toMatchObject({ photos: 1, audios: 1, excerpt: "去了江边" });
    expect(e2.cover).toContain(`/media/journal/${M1}`);
  });

  it("search wants every term, and shows where it was found", async () => {
    expect((await listMyEntries(session(), { q: "江边" })).entries.map((e) => e.id)).toEqual([E2]);
    expect((await listMyEntries(session(), { q: "江边 拿铁" })).entries.map((e) => e.id)).toEqual([E2]);
    expect((await listMyEntries(session(), { q: "江边 加班" })).entries).toEqual([]);
    expect((await listMyEntries(session(), { q: "拿铁" })).entries[0].excerpt).toContain("桂花拿铁");
  });

  it("a % or _ in the query is a character to find, not a wildcard", async () => {
    expect((await listMyEntries(session(), { q: "%" })).entries).toEqual([]);
    expect((await listMyEntries(session(), { q: "_" })).entries).toEqual([]);
  });

  it("knows which page comes before and after", async () => {
    expect(await getEntryDetail(session(), E2)).toMatchObject({ older: E1, newer: E3 });
    expect(await getEntryDetail(session(), E3)).toMatchObject({ older: E2, newer: null });
    expect(await getEntryDetail(session(), E1)).toMatchObject({ older: null, newer: E2 });
  });

  it("the page comes with its files", async () => {
    const detail = await getEntryDetail(session(), E2);
    expect(detail.media.map((m) => m.id)).toEqual([M1, M2, M3]);
    expect(detail.entry).not.toHaveProperty("searchText");
  });
});

describe("photos and recordings", () => {
  beforeEach(() => {
    fake.store.journal_entries.push(entry(E1, "2026-11-21"), { ...entry(THEIRS, "2026-11-21"), user_id: OTHER });
  });

  it("registers the file and hands out an upload address inside this page's folder", async () => {
    const ticket = await beginMediaUpload(session(), E1, { name: "录音 1542.webm", mime: "audio/webm;codecs=opus", size: 4000 });
    expect(ticket.media).toMatchObject({ kind: "audio", status: "uploading" });
    expect(ticket.upload.path).toBe(`${USER}/journal/${E1}/${ticket.media.id}-raw.webm`);
    expect(row("journal_media", ticket.media.id)).toMatchObject({ user_id: USER, entry_id: E1, kind: "audio", status: "uploading", mime: "audio/webm" });
    expect(fake.ops).toContain(`sign-upload:vault/${ticket.upload.path}`);
  });

  it("takes photos and recordings only, on my own pages only, up to the limit", async () => {
    await expect(beginMediaUpload(session(), E1, { name: "a.pdf", mime: "application/pdf", size: 10 })).rejects.toThrow("只能放照片和录音");
    await expect(beginMediaUpload(session(), THEIRS, { name: "a.jpg", mime: "image/jpeg", size: 10 })).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 60; i++) fake.store.journal_media.push(media(crypto.randomUUID(), E1, "image"));
    await expect(beginMediaUpload(session(), E1, { name: "a.jpg", mime: "image/jpeg", size: 10 })).rejects.toThrow("最多放 60 个文件");
    expect(rows("journal_media")).toHaveLength(60);
  });

  it("a photo is turned into a JPEG on the spot and the upload is removed", async () => {
    const raw = `${USER}/journal/${E1}/${M1}-raw.heic`;
    fake.store.journal_media.push(media(M1, E1, "image", { status: "uploading", path: raw, mime: "image/heic" }));
    putFile(raw);
    vi.mocked(archiveImage).mockResolvedValue({ data: new Uint8Array(500), mime: "image/jpeg", width: 1600, height: 1200 });
    const view = await finishMediaUpload(session(), M1);
    expect(view).toMatchObject({ status: "ready", width: 1600, height: 1200 });
    expect(row("journal_media", M1)).toMatchObject({ path: `${USER}/journal/${E1}/${M1}.jpg`, mime: "image/jpeg", bytes: 500 });
    expect([...fake.files.keys()]).toEqual([`vault/${USER}/journal/${E1}/${M1}.jpg`]);
    expect(start).not.toHaveBeenCalled();
  });

  it("a photo that cannot be read is marked failed, with what to do", async () => {
    const raw = `${USER}/journal/${E1}/${M1}-raw.heic`;
    fake.store.journal_media.push(media(M1, E1, "image", { status: "uploading", path: raw }));
    putFile(raw);
    vi.mocked(archiveImage).mockRejectedValue(new Error("unsupported"));
    expect(await finishMediaUpload(session(), M1)).toMatchObject({ status: "failed", error: expect.stringContaining("HEIC") });
  });

  it("refuses to finish an upload whose file never arrived", async () => {
    fake.store.journal_media.push(media(M1, E1, "audio", { status: "uploading", path: `${USER}/journal/${E1}/${M1}-raw.webm` }));
    await expect(finishMediaUpload(session(), M1)).rejects.toMatchObject({ status: 409 });
    expect(row("journal_media", M1).status).toBe("uploading");
  });

  it("a recording goes to the background to be transcribed", async () => {
    const raw = `${USER}/journal/${E1}/${M1}-raw.webm`;
    fake.store.journal_media.push(media(M1, E1, "audio", { status: "uploading", path: raw }));
    putFile(raw);
    expect(await finishMediaUpload(session(), M1)).toMatchObject({ status: "processing" });
    expect(start).toHaveBeenCalledWith(processJournalAudio, [M1, USER]);
    // 再调一次（页面重试）：不重复开任务
    await finishMediaUpload(session(), M1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("says so when the background task cannot start, instead of waiting forever", async () => {
    const raw = `${USER}/journal/${E1}/${M1}-raw.webm`;
    fake.store.journal_media.push(media(M1, E1, "audio", { status: "uploading", path: raw }));
    putFile(raw);
    vi.mocked(start).mockRejectedValue(new Error("workflow world not reachable"));
    expect(await finishMediaUpload(session(), M1)).toMatchObject({ status: "failed", error: expect.stringContaining("后台任务没启动") });
  });

  it("transcribes a recording again on request, but not while it is already running", async () => {
    fake.store.journal_media.push(media(M1, E1, "audio", { notes: ["没有转写说的话：没配 VOLC_SPEECH_API_KEY"] }), media(M2, E1, "audio", { status: "processing" }), media(M3, E1, "image"));
    expect(await retryMedia(session(), M1)).toMatchObject({ status: "processing" });
    expect(start).toHaveBeenCalledWith(processJournalAudio, [M1, USER]);
    await expect(retryMedia(session(), M2)).rejects.toMatchObject({ status: 409 });
    await expect(retryMedia(session(), M3)).rejects.toThrow("只有录音");
    await expect(retryMedia(session(OTHER), M1)).rejects.toMatchObject({ status: 404 });
  });

  it("a recording stuck in processing can be retried", async () => {
    fake.store.journal_media.push(media(M1, E1, "audio", { status: "processing", started_at: "2026-11-01T00:00:00Z" }));
    expect((await listEntryMedia(session(), E1))[0]).toMatchObject({ status: "failed", error: expect.stringContaining("中断") });
    expect(await retryMedia(session(), M1)).toMatchObject({ status: "processing" });
  });

  it("removing a file removes its row and every copy of it in storage, and nothing else", async () => {
    fake.store.journal_media.push(media(M1, E1, "audio"), media(M2, E1, "image"));
    putFile(`${USER}/journal/${E1}/${M1}.m4a`);
    putFile(`${USER}/journal/${E1}/${M1}-raw.webm`);
    putFile(`${USER}/journal/${E1}/${M2}.jpg`);
    await removeMedia(session(OTHER), M1);
    expect(rows("journal_media")).toHaveLength(2);
    await removeMedia(session(), M1);
    expect(rows("journal_media").map((r) => r.id)).toEqual([M2]);
    expect([...fake.files.keys()]).toEqual([`vault/${USER}/journal/${E1}/${M2}.jpg`]);
  });

  it("removing a page removes its files from storage", async () => {
    fake.store.journal_media.push(media(M1, E1, "image"));
    putFile(`${USER}/journal/${E1}/${M1}.jpg`);
    putFile(`${OTHER}/journal/${THEIRS}/x.jpg`);
    await removeEntry(session(), E1);
    expect(rows("journal_entries").map((r) => r.id)).toEqual([THEIRS]);
    expect([...fake.files.keys()]).toEqual([`vault/${OTHER}/journal/${THEIRS}/x.jpg`]);
  });
});

describe("toMediaView", () => {
  const base: JournalMedia = { id: M1, userId: USER, entryId: E1, kind: "audio", status: "ready", error: null, path: "p", mime: "audio/mp4", bytes: 1, width: null, height: null, durationS: 34.2, transcript: "[0:02] 今天风特别大\n[0:11] 下次要少糖", notes: ["只转写了前 60 分钟"], usage: {}, costUsd: 0, startedAt: "2026-11-21T10:00:00Z", createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T10:05:00Z" };
  const at = Date.parse("2026-11-21T10:00:00Z");

  it("gives the page the transcript as timed lines, what was not done, and an address that changes with the file", () => {
    const view = toMediaView(base, at);
    expect(view.cues).toEqual([{ at: 2, text: "今天风特别大" }, { at: 11, text: "下次要少糖" }]);
    expect(view.notes).toEqual(["只转写了前 60 分钟"]);
    expect(view.url).toBe(`/media/journal/${M1}?v=${Date.parse(base.updatedAt)}`);
    expect(view).not.toHaveProperty("path");
  });

  it("an upload or a transcription that has been going too long is shown as failed", () => {
    expect(toMediaView({ ...base, status: "uploading" }, at + 5 * 60_000).status).toBe("uploading");
    expect(toMediaView({ ...base, status: "uploading" }, at + 16 * 60_000)).toMatchObject({ status: "failed", error: "文件没有传完" });
    expect(toMediaView({ ...base, status: "processing" }, at + 5 * 60_000).status).toBe("processing");
    expect(toMediaView({ ...base, status: "processing" }, at + 21 * 60_000).status).toBe("failed");
  });
});
