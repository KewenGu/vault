import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

vi.mock("@/lib/ai/claude", async (orig) => ({ ...(await orig<object>()), askClaude: vi.fn() }));

import { ClaudeNotConfiguredError, askClaude } from "@/lib/ai/claude";
import { recordClaudeUsage } from "@/lib/usage/meter";
import { VaultError } from "./errors";
import { DRAFT_MESSAGE, chatOnMap, createMapFor, draftMap, getMapDetail, listMyMaps, removeMap, saveMap, undoMapChange } from "./map-service";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MAP = "33333333-3333-4333-8333-333333333333";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const understanding = (summary: string, outline: { depth: number; text: string }[] = []) => ({
  title: summary,
  contentType: "knowledge",
  category: "finance",
  language: "zh",
  summary,
  points: [{ at: null, text: `${summary}的要点` }],
  outline: outline.map((n) => ({ ...n, at: null })),
  card: [],
  quotes: [],
  tags: [],
  entities: [],
  relations: [],
  ocr: "",
  gaps: [],
  model: "m",
});

const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  source: "link",
  dedupe_key: `k:${id}`,
  platform: "douyin",
  external_id: id,
  url: null,
  status: "ready",
  error: null,
  kind: "video",
  title,
  author: "小鹿聊钱",
  post: null,
  media: [],
  transcript: null,
  user_text: null,
  understanding: understanding(title),
  summary: title,
  content_type: "knowledge",
  category: "finance",
  tags: [],
  tags_locked: false,
  note: null,
  usage: {},
  cost_usd: 0,
  started_at: "2026-11-20T00:00:00.000Z",
  processed_at: "2026-11-20T00:01:00.000Z",
  created_at: "2026-11-20T00:00:00.000Z",
  updated_at: "2026-11-20T00:00:00.000Z",
  ...over,
});

const mapRow = (over: Record<string, unknown> = {}) => ({
  id: MAP,
  user_id: USER,
  title: "普通人怎么理财",
  nodes: [{ depth: 1, text: "先存应急金", item: ITEM_A }],
  sources: [ITEM_A],
  chat: [],
  usage: {},
  cost_usd: 0,
  created_at: "2026-11-21T00:00:00.000Z",
  updated_at: "2026-11-21T00:00:00.000Z",
  ...over,
});

let fake: FakeSupabase;
let session: Session;
/** 搜索函数返回哪些内容（按顺序） */
let found: string[] = [];
let searched: Record<string, unknown>[] = [];
type StoredMap = { title: string; nodes: unknown[]; sources: string[]; usage: Record<string, number>; cost_usd: number; chat: { role: string; text: string; before?: unknown }[] };
const stored = () => fake.store.maps.find((m) => m.id === MAP) as unknown as StoredMap;
const reply = (text: string) => vi.mocked(askClaude).mockImplementation(async () => {
  recordClaudeUsage("claude-opus-5-5", { input_tokens: 2000, output_tokens: 300 });
  return { text, model: "claude-opus-5-5", truncated: false };
});
const prompt = () => vi.mocked(askClaude).mock.calls.at(-1)![0].prompt;

beforeEach(() => {
  vi.mocked(askClaude).mockReset();
  found = [];
  searched = [];
  fake = makeFakeSupabase(
    {
      maps: [mapRow(), mapRow({ id: "44444444-4444-4444-8444-444444444444", user_id: OTHER, title: "别人的" })],
      items: [
        item(ITEM_A, "30 岁开始理财晚吗", { understanding: understanding("四步走", [{ depth: 1, text: "应急金" }, { depth: 2, text: "3–6 个月开支" }, { depth: 1, text: "保险" }]) }),
        item(ITEM_B, "指数基金定投"),
        item(ITEM_C, "怎么选重疾险"),
      ],
    },
    {
      uuidIds: true,
      rpc: {
        search_items: (args) => {
          searched.push(args);
          return found.map((id, i) => ({ id, keyword_hits: 1, similarity: null, score: 1 - i * 0.1 }));
        },
      },
    }
  );
  session = { user: { id: USER }, db: fake.db } as unknown as Session;
});

describe("createMapFor", () => {
  it("starts blank with a cleaned title", async () => {
    const id = await createMapFor(session, { title: "  读书\n笔记 " });
    const row = fake.store.maps.find((m) => m.id === id)!;
    expect(row).toMatchObject({ user_id: USER, title: "读书 笔记", nodes: [], sources: [] });
  });

  it("starts from a saved item: its title, its outline with the source on the branches, and the item attached", async () => {
    const id = await createMapFor(session, { itemId: ITEM_A });
    expect(fake.store.maps.find((m) => m.id === id)).toMatchObject({
      title: "30 岁开始理财晚吗",
      sources: [ITEM_A],
      nodes: [
        { depth: 1, text: "应急金", item: ITEM_A },
        { depth: 2, text: "3–6 个月开支", item: null },
        { depth: 1, text: "保险", item: ITEM_A },
      ],
    });
    await expect(createMapFor(session, { itemId: GONE })).rejects.toMatchObject({ status: 404 });
  });
});

describe("saveMap / getMapDetail / removeMap", () => {
  it("saves cleaned edits and lists the attached items that still exist", async () => {
    await saveMap(session, MAP, { title: " 新标题 ", nodes: [{ depth: 4, text: " 甲 " }, { depth: 1, text: "" }], sources: [ITEM_B, GONE, "x"] });
    expect(stored()).toMatchObject({ title: "新标题", nodes: [{ depth: 1, text: "甲", item: null }], sources: [ITEM_B, GONE] });
    const detail = await getMapDetail(session, MAP);
    expect(detail.sources).toEqual([{ id: ITEM_B, title: "指数基金定投", origin: "抖音 · 小鹿聊钱" }]);
  });

  it("does not see or touch another user's map", async () => {
    const theirs = "44444444-4444-4444-8444-444444444444";
    await expect(getMapDetail(session, theirs)).rejects.toMatchObject({ status: 404 });
    await expect(saveMap(session, theirs, { title: "抢" })).rejects.toBeInstanceOf(VaultError);
    await removeMap(session, theirs);
    expect(fake.store.maps.find((m) => m.id === theirs)).toMatchObject({ title: "别人的" });
    await removeMap(session, MAP);
    expect(fake.store.maps.some((m) => m.id === MAP)).toBe(false);
  });
});

describe("before the migration has been pushed", () => {
  it("says what to do instead of a generic error", async () => {
    fake = makeFakeSupabase({}, { failSelect: { maps: { message: "Could not find the table 'public.maps' in the schema cache", code: "PGRST205" } } });
    session = { user: { id: USER }, db: fake.db } as unknown as Session;
    await expect(listMyMaps(session)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("20261121000001_maps.sql") });
    await expect(getMapDetail(session, MAP)).rejects.toBeInstanceOf(VaultError);
  });
});

describe("chatOnMap", () => {
  it("shows the model the current map, the attached items and what the search found; applies its map", async () => {
    found = [ITEM_A, ITEM_B, ITEM_C];
    reply("<reply>加了定投这个分支。</reply>\n<outline>\n- 先存应急金 [S1]\n  - 3–6 个月开支 [S1]\n- 定投 [S2]\n</outline>");
    const detail = await chatOnMap(session, MAP, { message: "把定投也并进来" });

    expect(prompt()).toContain("<现在的导图>\n- 先存应急金 [S1]");
    expect(prompt()).toContain("[S1] 30 岁开始理财晚吗（抖音 · 小鹿聊钱）〔已经挂在这张图上〕");
    expect(prompt()).toContain("[S2] 指数基金定投（抖音 · 小鹿聊钱）\n");
    expect(prompt()).toContain("[S3] 怎么选重疾险");
    expect(prompt()).toContain("<他这次说的话>\n把定投也并进来");
    expect(searched[0]).toMatchObject({ p_user_id: USER, p_terms: ["普通人怎么理财", "把定投也并进来"] });

    expect(detail.map.nodes).toEqual([
      { depth: 1, text: "先存应急金", item: ITEM_A },
      { depth: 2, text: "3–6 个月开支", item: ITEM_A },
      { depth: 1, text: "定投", item: ITEM_B },
    ]);
    // 用到的那条挂上了，搜到但没用的那条没挂
    expect(detail.map.sources).toEqual([ITEM_A, ITEM_B]);
    expect(detail.sources.map((s) => s.title)).toEqual(["30 岁开始理财晚吗", "指数基金定投"]);
    expect(detail.map.chat).toMatchObject([
      { role: "user", text: "把定投也并进来" },
      { role: "assistant", text: "加了定投这个分支。", changed: true, before: [{ depth: 1, text: "先存应急金", item: ITEM_A }] },
    ]);
    expect(Object.keys(stored().usage).length).toBeGreaterThan(0);
    expect(stored().cost_usd).toBeGreaterThan(0);
  });

  it("says what it could not look at", async () => {
    fake.store.items.push(item(GONE, "还在处理的", { status: "analyzing", understanding: null }));
    fake.store.maps[0].sources = [ITEM_A, GONE];
    reply("<reply>好。</reply>");
    const detail = await chatOnMap(session, MAP, { message: "看看结构" });
    const notes = detail.map.chat.at(-1);
    expect(notes).toMatchObject({ role: "assistant", changed: false });
    expect(notes?.role === "assistant" && notes.notes).toEqual([expect.stringContaining("1 条还没处理好"), expect.stringContaining("语义搜索这次不可用")]);
    expect(prompt()).toContain("<读取情况>\n- 这张图挂着的收藏里有 1 条还没处理好");
  });

  it("saves the editor's pending edits first, and keeps them when the model fails", async () => {
    vi.mocked(askClaude).mockRejectedValue(new Error("Claude 接口限流了，过一会儿再试"));
    await expect(chatOnMap(session, MAP, { message: "展开", title: "改过的标题", nodes: [{ depth: 1, text: "我刚写的", item: null }] })).rejects.toMatchObject({ message: "Claude 接口限流了，过一会儿再试", status: 502 });
    expect(stored()).toMatchObject({ title: "改过的标题", nodes: [{ depth: 1, text: "我刚写的", item: null }], chat: [] });

    vi.mocked(askClaude).mockRejectedValue(new ClaudeNotConfiguredError());
    await expect(chatOnMap(session, MAP, { message: "展开" })).rejects.toMatchObject({ message: expect.stringContaining("ANTHROPIC_API_KEY") });
    vi.mocked(askClaude).mockRejectedValue(new TypeError("fetch failed"));
    await expect(chatOnMap(session, MAP, { message: "展开" })).rejects.toBeInstanceOf(TypeError);
  });

  it("does not apply a truncated answer, and an answer without a map changes nothing", async () => {
    vi.mocked(askClaude).mockResolvedValue({ text: "<reply>改了</reply><outline>\n- 甲\n- 乙", model: "m", truncated: true });
    await expect(chatOnMap(session, MAP, { message: "重排" })).rejects.toMatchObject({ status: 502 });
    expect(stored()).toMatchObject({ nodes: [{ depth: 1, text: "先存应急金", item: ITEM_A }], chat: [] });

    reply("<reply>结构没问题。</reply>");
    const detail = await chatOnMap(session, MAP, { message: "结构行吗" });
    expect(detail.map.nodes).toEqual([{ depth: 1, text: "先存应急金", item: ITEM_A }]);
    const last = detail.map.chat.at(-1);
    expect(last).toMatchObject({ role: "assistant", changed: false });
    expect(last && "before" in last ? last.before : undefined).toBeUndefined();
  });

  it("rejects an empty or oversized message, and drops attached items that were deleted", async () => {
    await expect(chatOnMap(session, MAP, { message: "  " })).rejects.toBeInstanceOf(VaultError);
    await expect(chatOnMap(session, MAP, { message: "长".repeat(2001) })).rejects.toBeInstanceOf(VaultError);
    expect(askClaude).not.toHaveBeenCalled();
    fake.store.maps[0].sources = [GONE, ITEM_A];
    reply("<reply>好。</reply>");
    expect((await chatOnMap(session, MAP, { message: "看看" })).map.sources).toEqual([ITEM_A]);
  });
});

describe("draftMap", () => {
  it("searches by the title only and records the canned request", async () => {
    found = [ITEM_B];
    reply("<reply>起草好了。</reply><outline>\n- 定投 [S2]\n  - 每月固定扣款\n- 应急金 [S1]\n</outline>");
    const detail = await draftMap(session, MAP);
    expect(searched[0]).toMatchObject({ p_terms: ["普通人怎么理财"] });
    expect(detail.map.chat[0]).toMatchObject({ role: "user", text: DRAFT_MESSAGE });
    expect(detail.map.nodes.map((n) => n.text)).toEqual(["定投", "每月固定扣款", "应急金"]);
  });

  it("needs a title", async () => {
    fake.store.maps[0].title = "";
    await expect(draftMap(session, MAP)).rejects.toMatchObject({ message: expect.stringContaining("起个标题") });
    expect(askClaude).not.toHaveBeenCalled();
  });
});

describe("undoMapChange", () => {
  it("puts back the map from before the last change, once; an earlier change can no longer be undone", async () => {
    reply("<reply>一改。</reply><outline>\n- 甲\n- 乙\n</outline>");
    await chatOnMap(session, MAP, { message: "一" });
    reply("<reply>二改。</reply><outline>\n- 甲\n- 乙\n- 丙\n</outline>");
    await chatOnMap(session, MAP, { message: "二" });
    expect(stored().chat.filter((m) => m.before).map((m) => m.text)).toEqual(["二改。"]);

    const detail = await undoMapChange(session, MAP);
    expect(detail.map.nodes.map((n) => n.text)).toEqual(["甲", "乙"]);
    expect(detail.map.chat.at(-1)).toMatchObject({ text: "二改。", undone: true });
    await expect(undoMapChange(session, MAP)).rejects.toMatchObject({ status: 409 });
  });
});
