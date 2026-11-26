import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import type { Session } from "@/lib/auth/user";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/process-item", () => ({ processItem: vi.fn() }));
vi.mock("@/workflows/trace-item", () => ({ traceItem: vi.fn() }));

import { start } from "workflow/api";
import { traceItem } from "@/workflows/trace-item";
import { processItem } from "@/workflows/process-item";
import { getItemTrace, markOwn, removeItem, saveOwn, startTrace } from "./service";

const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ID = "11111111-1111-4111-8111-111111111111";
const session = (id: string) => ({ user: { id }, db: fake.db }) as unknown as Session;
const bytes = new Uint8Array([1, 2, 3]);

let localDir: string;
const localVideo = (user: string) => path.join(localDir, user, ID, "video.mp4");
beforeEach(async () => {
  localDir = await mkdtemp(path.join(os.tmpdir(), "vault-service-test-"));
  vi.stubEnv("VAULT_LOCAL_MEDIA_DIR", localDir);
  fake = makeFakeSupabase({ items: [{ id: ID, user_id: ME, source: "link", status: "ready", media: [] }] }, { rpc: { prune_orphan_entities: () => 0 } });
  // 这条内容转存的东西：存储桶里的封面、帧、帧格，服务器磁盘上的大视频原片
  for (const name of ["img-01.jpg", "frame-01.jpg", "sheet-01.jpg"]) await fake.db.storage.from("vault").upload(`${ME}/${ID}/${name}`, bytes);
  await mkdir(path.dirname(localVideo(ME)), { recursive: true });
  await writeFile(localVideo(ME), bytes);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(localDir, { recursive: true, force: true });
});

describe("removeItem", () => {
  it("deletes the row, its files in storage and its original on the server's disk", async () => {
    await removeItem(session(ME), ID);
    expect(fake.store.items).toEqual([]);
    expect([...fake.files.keys()]).toEqual([]);
    expect(existsSync(localVideo(ME))).toBe(false);
    expect(existsSync(path.dirname(localVideo(ME)))).toBe(false);
  });

  it("touches nothing of an item that belongs to someone else", async () => {
    await expect(removeItem(session(OTHER), ID)).rejects.toMatchObject({ status: 404 });
    expect(fake.store.items).toHaveLength(1);
    expect([...fake.files.keys()]).toHaveLength(3);
    expect(existsSync(localVideo(ME))).toBe(true);
  });
});

describe("saveOwn", () => {
  beforeEach(() => vi.mocked(start).mockReset());

  it("saves what was written as the user's own, never reads it as a link, and starts processing", async () => {
    const saved = await saveOwn(session(ME), "  看完 https://v.douyin.com/abc/ 觉得应急金要先存够  ", "读后感");
    expect(saved.existing).toBe(false);
    expect(fake.store.items.find((i) => i.id === saved.id)).toMatchObject({ user_id: ME, source: "own", kind: "text", status: "fetching", user_text: "看完 https://v.douyin.com/abc/ 觉得应急金要先存够", note: "读后感", platform: null, url: null });
    expect(start).toHaveBeenCalledWith(processItem, [saved.id]);
  });

  it("the same words written twice are two entries", async () => {
    const first = await saveOwn(session(ME), "定投别停");
    const second = await saveOwn(session(ME), "定投别停");
    expect(second).toMatchObject({ existing: false });
    expect(second.id).not.toBe(first.id);
    expect(fake.store.items.filter((i) => i.source === "own")).toHaveLength(2);
  });

  it("needs something written, and not more than fits", async () => {
    await expect(saveOwn(session(ME), "  \n ")).rejects.toMatchObject({ message: "还没写东西" });
    await expect(saveOwn(session(ME), "长".repeat(200_001))).rejects.toMatchObject({ message: expect.stringContaining("一条最多 200,000 字") });
    expect(fake.store.items).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("says which migration to push when the database does not know this source yet", async () => {
    fake = makeFakeSupabase({ items: [] }, { failInsert: { items: { message: 'new row for relation "items" violates check constraint "items_source_check"', code: "23514" } } });
    await expect(saveOwn(session(ME), "定投别停")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("20261126000004_own_writing.sql") });
  });
});

describe("markOwn", () => {
  const TEXT = "44444444-4444-4444-8444-444444444444";
  const seedText = (over: Record<string, unknown> = {}) => {
    fake.store.items.push({ id: TEXT, user_id: ME, source: "text", kind: "text", status: "ready", user_text: "定投别停", media: [], started_at: "2026-11-20T00:00:00.000Z", ...over });
    vi.mocked(start).mockReset();
  };
  const source = () => fake.store.items.find((i) => i.id === TEXT)?.source;

  it("marks a pasted text as the user's own and back, re-analysing each time", async () => {
    seedText();
    await markOwn(session(ME), TEXT, true);
    expect(fake.store.items.find((i) => i.id === TEXT)).toMatchObject({ source: "own", status: "analyzing", user_text: "定投别停" });
    expect(start).toHaveBeenCalledWith(processItem, [TEXT]);

    fake.store.items.find((i) => i.id === TEXT)!.status = "ready";
    await markOwn(session(ME), TEXT, false);
    expect(source()).toBe("text");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does nothing when it already is what was asked", async () => {
    seedText({ source: "own" });
    await markOwn(session(ME), TEXT, true);
    expect(fake.store.items.find((i) => i.id === TEXT)).toMatchObject({ source: "own", status: "ready" });
    expect(start).not.toHaveBeenCalled();
  });

  it("only texts can be marked; not someone else's, not one being processed", async () => {
    seedText();
    await expect(markOwn(session(ME), ID, true)).rejects.toMatchObject({ message: "只有文字内容能标成自己写的" });
    await expect(markOwn(session(OTHER), TEXT, true)).rejects.toMatchObject({ status: 404 });
    fake.store.items.find((i) => i.id === TEXT)!.status = "analyzing";
    fake.store.items.find((i) => i.id === TEXT)!.started_at = new Date().toISOString();
    await expect(markOwn(session(ME), TEXT, true)).rejects.toMatchObject({ status: 409 });
    expect(source()).toBe("text");
    expect(start).not.toHaveBeenCalled();
  });

  it("says which migration to push when the database refuses the new source", async () => {
    fake = makeFakeSupabase({ items: [] }, { failUpdate: { items: { message: 'new row for relation "items" violates check constraint "items_source_check"', code: "23514" } } });
    seedText();
    await expect(markOwn(session(ME), TEXT, true)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("20261126000004_own_writing.sql") });
  });
});

describe("startTrace", () => {
  const understanding = { title: "一篇转述", contentType: "knowledge", category: "tech", language: "zh", summary: "概括", points: [], outline: [], card: [], quotes: [], tags: [], entities: [], relations: [], ocr: "", gaps: [], model: "m" };
  const seed = (item: Record<string, unknown> = {}, traces: Record<string, unknown>[] = []) => {
    fake = makeFakeSupabase({
      items: [{ id: ID, user_id: ME, source: "link", platform: "web", status: "ready", media: [], tags: [], tags_locked: false, post: { text: "据某论文……" }, understanding, started_at: "2026-11-23T07:00:00Z", created_at: "2026-11-23T07:00:00Z", ...item }],
      item_traces: traces,
    });
  };
  beforeEach(() => {
    seed();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.mocked(start).mockReset();
  });

  it("starts the background task and reports the trace as running", async () => {
    const trace = await startTrace(session(ME), ID);
    expect(trace).toMatchObject({ itemId: ID, status: "running", result: null });
    expect(fake.store.item_traces).toHaveLength(1);
    expect(fake.store.item_traces[0]).toMatchObject({ item_id: ID, user_id: ME, status: "running" });
    // 后台任务拿着这一轮的开始时间：写结果时对得上才写
    expect(start).toHaveBeenCalledWith(traceItem, [ID, ME, fake.store.item_traces[0].started_at]);
    expect(await getItemTrace(session(ME), ID)).toMatchObject({ status: "running" });
    expect(await getItemTrace(session(OTHER), ID)).toBeNull();
  });

  it("re-running keeps the last result and what was spent, and starts a new round", async () => {
    const last = { origin: "secondary", overview: "上一次的", sources: [], notes: [], searches: 1, fetches: 0, model: "m", at: "2026-11-23T07:30:00.000Z" };
    seed({}, [{ item_id: ID, user_id: ME, status: "ready", error: null, result: last, usage: { claude_web_search: 1 }, cost_usd: 0.01, started_at: "2026-11-23T07:29:00.000Z", updated_at: "2026-11-23T07:30:00.000Z" }]);
    const trace = await startTrace(session(ME), ID);
    expect(trace).toMatchObject({ status: "running", result: last, usage: { claude_web_search: 1 }, costUsd: 0.01 });
    expect(trace.startedAt).not.toBe("2026-11-23T07:29:00.000Z");
    expect(fake.store.item_traces).toHaveLength(1);
  });

  it("refuses while a trace is running, but a stuck one can be started again", async () => {
    seed({}, [{ item_id: ID, user_id: ME, status: "running", error: null, result: null, usage: {}, cost_usd: 0, started_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    await expect(startTrace(session(ME), ID)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/正在溯源/) });
    expect(start).not.toHaveBeenCalled();
    fake.store.item_traces[0].started_at = new Date(Date.now() - 60 * 60_000).toISOString();
    await expect(startTrace(session(ME), ID)).resolves.toMatchObject({ status: "running" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("says why it cannot start: someone else's item, not processed yet, nothing to read, no API key", async () => {
    await expect(startTrace(session(OTHER), ID)).rejects.toMatchObject({ status: 404 });
    await expect(startTrace(session(ME), "not-a-uuid")).rejects.toMatchObject({ status: 404 });
    seed({ status: "analyzing" });
    await expect(startTrace(session(ME), ID)).rejects.toMatchObject({ status: 409 });
    seed({ post: { text: "" } });
    await expect(startTrace(session(ME), ID)).rejects.toThrow(/没有能拿去核对出处的文字/);
    seed();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(startTrace(session(ME), ID)).rejects.toMatchObject({ status: 503 });
    expect(start).not.toHaveBeenCalled();
    expect(fake.store.item_traces).toEqual([]);
  });

  it("marks the trace failed when the background task cannot be started", async () => {
    vi.mocked(start).mockRejectedValueOnce(new Error("workflow runtime unavailable"));
    const trace = await startTrace(session(ME), ID);
    expect(trace).toMatchObject({ status: "failed", error: "后台任务没启动：workflow runtime unavailable" });
  });

  it("tells the user to push the migration when the table is not there yet", async () => {
    fake = makeFakeSupabase({ items: fake.store.items }, { failSelect: { item_traces: { message: "Could not find the table", code: "PGRST205" } } });
    await expect(getItemTrace(session(ME), ID)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/20261123000001_item_traces\.sql/) });
  });
});
