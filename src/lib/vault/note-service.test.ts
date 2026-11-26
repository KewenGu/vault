import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import { emptyStats } from "@/lib/sources/types";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

vi.mock("@/lib/embeddings", () => ({ embedTexts: vi.fn() }));

import { embedTexts } from "@/lib/embeddings";
import { recordEmbeddingUsage } from "@/lib/usage/meter";
import { VaultError } from "./errors";
import { addNote, editNote, listItemNotes, listMyNotes, removeNote } from "./note-service";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUSY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THEIRS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOTE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const THEIR_NOTE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  source: "link",
  dedupe_key: `k:${id}`,
  platform: "douyin",
  status: "ready",
  title: "30 岁开始理财晚吗",
  author: "小鹿聊钱",
  url: null,
  post: { text: "正文", publishedAt: null, stats: emptyStats(), hashtags: [], topComments: [], music: null, notes: [], authorId: null, durationS: null, digestNotes: [], transcriptFrom: null, cuts: [], links: [] },
  media: [],
  transcript: "[1:12] 应急金放货币基金",
  user_text: null,
  understanding: null,
  summary: "",
  tags: ["理财"],
  tags_locked: false,
  note: "年底前照着做",
  search_text: "旧的搜索全文",
  embedding: "[0,0]",
  usage: { "tok_embed|voyage|voyage-3.5-lite": 100 },
  cost_usd: 0.01,
  started_at: "2026-11-20T00:00:00.000Z",
  created_at: "2026-11-20T00:00:00.000Z",
  updated_at: "2026-11-20T00:00:00.000Z",
  ...over,
});
const noteRow = (id: string, over: Record<string, unknown> = {}) => ({ id, user_id: USER, item_id: ITEM, quote: "别拿应急的钱去投资", body: "", at: null, search_text: "别拿应急的钱去投资\n", created_at: "2026-11-21T00:00:00.000Z", updated_at: "2026-11-21T00:00:00.000Z", ...over });

let fake: FakeSupabase;
let session: Session;
type StoredItem = { id: string; search_text: string; embedding: string; usage: Record<string, number>; cost_usd: number };
const stored = (id = ITEM) => fake.store.items.find((i) => i.id === id) as unknown as StoredItem;
const notesInDb = () => fake.store.item_notes as unknown as { id: string; user_id: string; item_id: string; quote: string; body: string; at: number | null }[];

function setup(opts: Parameters<typeof makeFakeSupabase>[1] = {}, notes = [noteRow(NOTE), noteRow(THEIR_NOTE, { user_id: OTHER, item_id: THEIRS, quote: "别人划的" })]) {
  fake = makeFakeSupabase({ items: [item(ITEM), item(BUSY, { status: "analyzing" }), item(THEIRS, { user_id: OTHER, title: "别人的" })], item_notes: notes }, { uuidIds: true, ...opts });
  session = { user: { id: USER }, db: fake.db } as unknown as Session;
}

beforeEach(() => {
  vi.stubEnv("VOYAGE_API_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(embedTexts).mockReset();
  vi.mocked(embedTexts).mockImplementation(async () => {
    recordEmbeddingUsage("voyage", "voyage-3.5-lite", 50);
    return [[0.5, 0.5]];
  });
  setup();
});

describe("addNote", () => {
  it("saves a highlight with its time, and puts it into the item's search text and vector", async () => {
    const { notes, warning } = await addNote(session, ITEM, { quote: "  应急金放\n货币基金 ", at: 72, body: "" });
    expect(warning).toBeNull();
    expect(notes.map((n) => n.quote)).toEqual(["别拿应急的钱去投资", "应急金放 货币基金"]);
    expect(notes[1]).toMatchObject({ itemId: ITEM, body: "", at: 72 });
    expect(notesInDb().at(-1)).toMatchObject({ user_id: USER, item_id: ITEM });

    // 搜索全文重新拼了：原来的东西还在，两条笔记都进去了
    const row = stored();
    for (const part of ["30 岁开始理财晚吗", "年底前照着做", "别拿应急的钱去投资", "应急金放 货币基金", "[1:12] 应急金放货币基金"]) expect(row.search_text).toContain(part);
    // 向量按带着笔记的文字重新算，花的钱加在这条内容的账上
    expect(vi.mocked(embedTexts).mock.calls[0][0][0]).toContain("应急金放 货币基金");
    expect(row.embedding).toBe("[0.5,0.5]");
    expect(row.usage["tok_embed|voyage|voyage-3.5-lite"]).toBe(150);
    expect(row.cost_usd).toBeGreaterThan(0);
  });

  it("saves a thought with no highlight; a time without a highlight is dropped", async () => {
    const { notes } = await addNote(session, ITEM, { body: "下个月开始定投\n先 500", at: 30 });
    expect(notes.at(-1)).toMatchObject({ quote: "", body: "下个月开始定投\n先 500", at: null });
    expect(stored().search_text).toContain("下个月开始定投");
  });

  it("needs something to save, a real item of this user, and stops at the per-item cap", async () => {
    await expect(addNote(session, ITEM, { quote: "  ", body: "\n" })).rejects.toBeInstanceOf(VaultError);
    await expect(addNote(session, THEIRS, { body: "写在别人的内容上" })).rejects.toMatchObject({ status: 404 });
    await expect(addNote(session, "not-an-id", { body: "x" })).rejects.toMatchObject({ status: 404 });
    expect(notesInDb()).toHaveLength(2);
    expect(embedTexts).not.toHaveBeenCalled();

    setup({}, Array.from({ length: 200 }, (_, i) => noteRow(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)));
    await expect(addNote(session, ITEM, { body: "第 201 条" })).rejects.toThrow(/最多 200 条/);
  });

  it("the note is kept when the vector service fails, and the user is told it is not in semantic search yet", async () => {
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("Voyage 503"));
    const { notes, warning } = await addNote(session, ITEM, { body: "下个月开始定投" });
    expect(notes).toHaveLength(2);
    expect(warning).toContain("语义搜索的索引这次没更新成");
    // 按字面搜的那一半照样更新了，旧的向量留着
    expect(stored().search_text).toContain("下个月开始定投");
    expect(stored().embedding).toBe("[0,0]");
  });

  it("the note is kept when the index cannot be written at all, with a plain warning", async () => {
    setup({ failUpdate: { items: { message: "timeout" } } });
    const { notes, warning } = await addNote(session, ITEM, { body: "下个月开始定投" });
    expect(notes).toHaveLength(2);
    expect(warning).toContain("暂时搜不到这条笔记");
  });

  it("without a vector service only the search text is refreshed; an item still being processed is left to its own indexing step", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    expect((await addNote(session, ITEM, { body: "没配向量也能记" })).warning).toBeNull();
    expect(embedTexts).not.toHaveBeenCalled();
    expect(stored().search_text).toContain("没配向量也能记");

    vi.stubEnv("VOYAGE_API_KEY", "test-key");
    const { notes, warning } = await addNote(session, BUSY, { body: "处理中写的" });
    expect(notes).toHaveLength(1);
    expect(warning).toBeNull();
    expect(embedTexts).not.toHaveBeenCalled();
    expect(stored(BUSY).search_text).toBe("旧的搜索全文");
  });
});

describe("editNote / removeNote", () => {
  it("changes what the user wrote, never the quoted passage, and reindexes", async () => {
    const { notes } = await editNote(session, NOTE, { body: " 这句要记住 " });
    expect(notes).toMatchObject([{ id: NOTE, quote: "别拿应急的钱去投资", body: "这句要记住" }]);
    expect(stored().search_text).toContain("这句要记住");
    // 清空批注：划线还在
    expect((await editNote(session, NOTE, { body: "" })).notes).toMatchObject([{ quote: "别拿应急的钱去投资", body: "" }]);
    expect(stored().search_text).not.toContain("这句要记住");
  });

  it("will not empty a note that is only the user's words", async () => {
    const { notes } = await addNote(session, ITEM, { body: "只有这句话" });
    await expect(editNote(session, notes[1].id, { body: "  " })).rejects.toThrow(/删掉它/);
    expect(notesInDb().find((n) => n.id === notes[1].id)?.body).toBe("只有这句话");
  });

  it("removing a note takes it out of the search text", async () => {
    expect(stored().search_text).toBe("旧的搜索全文");
    const { notes } = await removeNote(session, NOTE);
    expect(notes).toEqual([]);
    expect(notesInDb().some((n) => n.id === NOTE)).toBe(false);
    expect(stored().search_text).not.toContain("别拿应急的钱去投资");
    expect(stored().search_text).toContain("30 岁开始理财晚吗");
  });

  it("cannot touch another user's note", async () => {
    await expect(editNote(session, THEIR_NOTE, { body: "抢" })).rejects.toMatchObject({ status: 404 });
    await expect(removeNote(session, THEIR_NOTE)).rejects.toMatchObject({ status: 404 });
    await expect(removeNote(session, "nope")).rejects.toMatchObject({ status: 404 });
    expect(notesInDb().find((n) => n.id === THEIR_NOTE)).toMatchObject({ quote: "别人划的", body: "" });
    expect(await listItemNotes(session, THEIRS)).toEqual([]);
  });
});

describe("listMyNotes", () => {
  it("lists my notes newest first with the item each hangs on, and finds by the words in them", async () => {
    setup({}, [
      noteRow(NOTE),
      noteRow("00000000-0000-4000-8000-000000000001", { quote: "", body: "下个月开始定投", search_text: "\n下个月开始定投", created_at: "2026-11-22T00:00:00.000Z" }),
      noteRow(THEIR_NOTE, { user_id: OTHER, item_id: THEIRS, quote: "别人划的定投", search_text: "别人划的定投\n" }),
    ]);
    const all = await listMyNotes(session);
    expect(all.more).toBe(false);
    expect(all.notes.map((n) => n.note.body || n.note.quote)).toEqual(["下个月开始定投", "别拿应急的钱去投资"]);
    expect(all.notes[0].item).toEqual({ id: ITEM, title: "30 岁开始理财晚吗", origin: "抖音 · 小鹿聊钱" });
    expect((await listMyNotes(session, { q: "定投" })).notes.map((n) => n.note.body)).toEqual(["下个月开始定投"]);
    expect((await listMyNotes(session, { q: "应急 投资" })).notes.map((n) => n.note.id)).toEqual([NOTE]);
    expect((await listMyNotes(session, { q: "火星" })).notes).toEqual([]);
  });
});

describe("before the migration has been pushed", () => {
  it("says what to do instead of a generic error", async () => {
    setup({ failSelect: { item_notes: { message: "Could not find the table 'public.item_notes' in the schema cache", code: "PGRST205" } } });
    await expect(listItemNotes(session, ITEM)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("20261126000003_item_notes.sql") });
    await expect(listMyNotes(session)).rejects.toMatchObject({ status: 503 });
    await expect(addNote(session, ITEM, { body: "x" })).rejects.toMatchObject({ status: 503 });
  });
});
