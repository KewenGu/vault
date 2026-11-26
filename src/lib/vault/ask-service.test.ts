import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

vi.mock("@/lib/ai/claude", async (orig) => ({ ...(await orig<object>()), askClaude: vi.fn() }));

import { ClaudeNotConfiguredError, askClaude } from "@/lib/ai/claude";
import { recordClaudeUsage } from "@/lib/usage/meter";
import { askVault, getAskDetail, listMyAsks, removeAsk } from "./ask-service";
import { VaultError } from "./errors";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ASK = "33333333-3333-4333-8333-333333333333";
const THEIRS = "44444444-4444-4444-8444-444444444444";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const understanding = (summary: string) => ({
  title: summary,
  contentType: "knowledge",
  category: "finance",
  language: "zh",
  summary,
  points: [{ at: null, text: `${summary}的要点` }],
  outline: [],
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

const earlierAnswer = { role: "assistant", text: "先存应急金[1]。", at: "2026-11-25T00:00:00.000Z", cites: [{ id: ITEM_A, title: "30 岁开始理财晚吗", origin: "抖音 · 小鹿聊钱" }], notes: [], seen: 3, total: 3 };
const askRow = (over: Record<string, unknown> = {}) => ({
  id: ASK,
  user_id: USER,
  title: "怎么开始理财",
  chat: [{ role: "user", text: "怎么开始理财", at: "2026-11-25T00:00:00.000Z" }, earlierAnswer],
  sources: [ITEM_A],
  usage: { "tok_in|anthropic|claude-opus-5-5": 1000 },
  cost_usd: 0.01,
  created_at: "2026-11-25T00:00:00.000Z",
  updated_at: "2026-11-25T00:00:00.000Z",
  ...over,
});

let fake: FakeSupabase;
let session: Session;
/** 搜索函数返回哪些内容（按顺序）；searchFails = 搜索函数报错 */
let found: string[] = [];
let searched: Record<string, unknown>[] = [];
type StoredAsk = { id: string; user_id: string; title: string; sources: string[]; usage: Record<string, number>; cost_usd: number; chat: { role: string; text: string; cites?: { id: string }[]; notes?: string[]; seen?: number; total?: number | null }[] };
const asks = () => fake.store.asks as unknown as StoredAsk[];
const mine = () => asks().filter((a) => a.user_id === USER);
const reply = (text: string, truncated = false) =>
  vi.mocked(askClaude).mockImplementation(async () => {
    recordClaudeUsage("claude-opus-5-5", { input_tokens: 2000, output_tokens: 300 });
    return { text, model: "claude-opus-5-5", truncated };
  });
const prompt = () => vi.mocked(askClaude).mock.calls.at(-1)![0].prompt;

function setup(seed: { asks?: Record<string, unknown>[]; items?: Record<string, unknown>[] } = {}, opts: Parameters<typeof makeFakeSupabase>[1] = {}) {
  fake = makeFakeSupabase(
    {
      asks: seed.asks ?? [askRow(), askRow({ id: THEIRS, user_id: OTHER, title: "别人问的" })],
      items: seed.items ?? [item(ITEM_A, "30 岁开始理财晚吗", { note: "年底前照着做" }), item(ITEM_B, "指数基金定投"), item(ITEM_C, "怎么选重疾险")],
    },
    {
      uuidIds: true,
      rpc: {
        search_items: (args) => {
          searched.push(args);
          return found.map((id, i) => ({ id, keyword_hits: 0, similarity: 0.6, score: 1 - i * 0.1 }));
        },
      },
      ...opts,
    }
  );
  session = { user: { id: USER }, db: fake.db } as unknown as Session;
}

beforeEach(() => {
  vi.mocked(askClaude).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  found = [];
  searched = [];
  setup();
});

describe("askVault — a new question", () => {
  it("searches the library, shows the model what it found (with the user's own note), and keeps the answer with its sources", async () => {
    found = [ITEM_B, ITEM_A];
    reply("<answer>定投选宽基指数 [S1]。\n应急金先留出来 [S2]。</answer>");
    const detail = await askVault(session, { question: "  怎么开始\n定投？ " });

    expect(searched[0]).toMatchObject({ p_user_id: USER });
    expect(prompt()).toContain("[S1] 指数基金定投（抖音 · 小鹿聊钱，2026-11-20 存的）");
    expect(prompt()).toContain("[S2] 30 岁开始理财晚吗");
    expect(prompt()).toContain("他存的时候写的备注：年底前照着做");
    expect(prompt()).toContain("处理好的内容一共 3 条，这次按他的问题找出了其中 2 条");
    expect(prompt()).toContain("<他这次问的>\n怎么开始\n定投？\n</他这次问的>");
    expect(prompt()).not.toContain("<之前的对话>");

    const row = mine().find((a) => a.id === detail.ask.id)!;
    expect(row).toMatchObject({ title: "怎么开始 定投？", sources: [ITEM_B, ITEM_A] });
    expect(row.chat).toMatchObject([
      { role: "user", text: "怎么开始\n定投？" },
      { role: "assistant", text: "定投选宽基指数[1]。\n应急金先留出来[2]。", cites: [{ id: ITEM_B, title: "指数基金定投", origin: "抖音 · 小鹿聊钱" }, { id: ITEM_A }], seen: 2, total: 3 },
    ]);
    expect(row.usage).toEqual({ "tok_in|anthropic|claude-opus-5-5": 2000, "tok_out|anthropic|claude-opus-5-5": 300 });
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(detail.gone).toEqual([]);
    expect(detail.ask.costUsd).toBe(row.cost_usd);
  });

  it("tells the model which entries are the user's own writing, with his words", async () => {
    setup({ items: [item(ITEM_A, "30 岁开始理财晚吗"), item(ITEM_B, "定投的打算", { source: "own", platform: null, author: null, kind: "text", user_text: "定投别停，跌的时候更要买" })] });
    found = [ITEM_A, ITEM_B];
    reply("<answer>你写过定投别停 [S2]</answer>");
    await askVault(session, { question: "我对定投是怎么想的" });
    expect(prompt()).toContain("[S2] 定投的打算（自己写的，");
    expect(prompt()).toContain("〔他自己写的〕");
    expect(prompt()).toContain("他写的原文：\n定投别停，跌的时候更要买");
    // 存下来的别人的内容不带这些
    expect(prompt().split("[S2]")[0]).not.toContain("他自己写的");
  });

  it("brings along what the user highlighted and wrote on the items it found", async () => {
    setup({ items: [item(ITEM_A, "30 岁开始理财晚吗"), item(ITEM_B, "指数基金定投")] });
    fake.store.item_notes = [
      { id: "n1", user_id: USER, item_id: ITEM_A, quote: "应急金放货币基金", body: "我放余额宝", at: 72, created_at: "2026-11-21T00:00:00.000Z", updated_at: "t" },
      { id: "n2", user_id: OTHER, item_id: ITEM_B, quote: "别人划的", body: "", at: null, created_at: "2026-11-21T00:00:00.000Z", updated_at: "t" },
    ];
    found = [ITEM_A, ITEM_B];
    reply("<answer>你当时写的是放余额宝 [S1]</answer>");
    await askVault(session, { question: "我当时应急金怎么打算的" });
    expect(prompt()).toContain("他在这条上划的线、写的批注：\n- 划线（1:12）：「应急金放货币基金」——他写的：我放余额宝");
    expect(prompt()).not.toContain("别人划的");
  });

  it("answers without the notes when their table is not there yet, and says so when reading them fails", async () => {
    setup({}, { failSelect: { item_notes: { message: "Could not find the table 'public.item_notes' in the schema cache", code: "PGRST205" } } });
    found = [ITEM_A];
    reply("<answer>有 [S1]</answer>");
    let answer = (await askVault(session, { question: "一" })).ask.chat[1];
    expect(answer.role === "assistant" && answer.notes.some((n) => n.includes("批注"))).toBe(false);

    setup({}, { failSelect: { item_notes: { message: "connection reset" } } });
    found = [ITEM_A];
    reply("<answer>有 [S1]</answer>");
    answer = (await askVault(session, { question: "二" })).ask.chat[1];
    expect(answer.text).toBe("有[1]");
    expect(answer.role === "assistant" && answer.notes.some((n) => n.includes("没读到你在这些内容上划的线和写的批注"))).toBe(true);
    expect(prompt()).toContain("没读到你在这些内容上划的线和写的批注");
  });

  it("says so without calling the model when the search finds nothing", async () => {
    const detail = await askVault(session, { question: "火星上怎么种土豆" });
    expect(askClaude).not.toHaveBeenCalled();
    const answer = detail.ask.chat[1];
    expect(answer).toMatchObject({ role: "assistant", cites: [], seen: 0, total: 3 });
    expect(answer.text).toContain("没在收藏库里找到");
    // 没配语义搜索时只按字面找：这一点要告诉他，不然「没找到」会被当成「没存过」
    expect(answer.role === "assistant" && answer.notes.join()).toContain("只按字面");
    expect(detail.ask.costUsd).toBe(0);
  });

  it("tells an empty library apart from a miss", async () => {
    setup({ asks: [], items: [] });
    const detail = await askVault(session, { question: "我存过什么" });
    expect(detail.ask.chat[1].text).toContain("还没有处理好的内容");
    expect(askClaude).not.toHaveBeenCalled();
  });

  it("leaves out items that are not processed yet, and says how many", async () => {
    setup({ items: [item(ITEM_A, "好的"), item(ITEM_B, "还在处理", { status: "analyzing", understanding: null }), item(ITEM_C, "失败的", { status: "failed", understanding: null })] });
    found = [ITEM_B, ITEM_A, ITEM_C];
    reply("<answer>只有这一条 [S1]</answer>");
    const detail = await askVault(session, { question: "有什么" });
    expect(prompt()).toContain("[S1] 好的");
    expect(prompt()).not.toContain("还在处理");
    expect(prompt()).toContain("有 2 条还没处理好");
    const answer = detail.ask.chat[1];
    expect(answer).toMatchObject({ seen: 1, total: 1 });
    expect(answer.role === "assistant" && answer.notes.some((n) => n.includes("有 2 条还没处理好"))).toBe(true);
  });

  it("keeps a cut-off answer, drops citations that point at nothing, and flags an answer with no sources", async () => {
    found = [ITEM_A];
    reply("<answer>甲 [S1]。乙 [S8]。写到一半", true);
    let answer = (await askVault(session, { question: "问一" })).ask.chat[1];
    expect(answer.text).toBe("甲[1]。乙。写到一半");
    expect(answer.role === "assistant" && answer.notes).toEqual(expect.arrayContaining([expect.stringContaining("被截断"), expect.stringContaining("1 处出处的编号对不上")]));

    reply("<answer>这是常识，和你的收藏无关。</answer>");
    answer = (await askVault(session, { question: "问二" })).ask.chat[1];
    expect(answer).toMatchObject({ cites: [] });
    expect(answer.role === "assistant" && answer.notes.some((n) => n.includes("没有标出处"))).toBe(true);
  });

  it("rejects an empty or oversized question before doing anything", async () => {
    await expect(askVault(session, { question: "   " })).rejects.toBeInstanceOf(VaultError);
    await expect(askVault(session, { question: "长".repeat(2001) })).rejects.toThrow(/太长/);
    expect(searched).toHaveLength(0);
    expect(askClaude).not.toHaveBeenCalled();
  });
});

describe("askVault — failures leave nothing half-saved", () => {
  it("does not answer when the search itself fails", async () => {
    setup({}, { rpc: { search_items: () => { throw new Error("boom"); } } });
    await expect(askVault(session, { question: "怎么理财" })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("搜索收藏库出错") });
    expect(askClaude).not.toHaveBeenCalled();
    expect(mine()).toHaveLength(1);
  });

  it("turns the model's failures into messages for the user and saves no new question", async () => {
    found = [ITEM_A];
    vi.mocked(askClaude).mockRejectedValueOnce(new ClaudeNotConfiguredError());
    await expect(askVault(session, { question: "一" })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    vi.mocked(askClaude).mockRejectedValueOnce(new Error("Claude 接口限流了，过一会儿再试"));
    await expect(askVault(session, { question: "二" })).rejects.toMatchObject({ status: 502 });
    vi.mocked(askClaude).mockRejectedValueOnce(new Error("模型拒绝处理这条内容（policy）"));
    await expect(askVault(session, { question: "三" })).rejects.toThrow("模型拒绝回答这个问题（policy）");
    vi.mocked(askClaude).mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(askVault(session, { question: "四" })).rejects.toBeInstanceOf(TypeError);
    expect(mine()).toHaveLength(1);
  });

  it("an unusable answer to a follow-up keeps the conversation as it was but still books what it cost", async () => {
    found = [ITEM_B];
    reply("<answer>   </answer>");
    await expect(askVault(session, { id: ASK, question: "然后呢" })).rejects.toMatchObject({ status: 502 });
    const row = mine()[0];
    expect(row.chat).toHaveLength(2);
    expect(row.usage["tok_in|anthropic|claude-opus-5-5"]).toBe(3000);
    expect(row.cost_usd).toBeGreaterThan(0.01);
  });

  it("checks the table exists before spending on the model", async () => {
    setup({}, { failSelect: { asks: { message: "Could not find the table 'public.asks' in the schema cache", code: "PGRST205" } } });
    found = [ITEM_A];
    await expect(askVault(session, { question: "怎么理财" })).rejects.toMatchObject({ status: 503, message: expect.stringContaining("20261126000002_asks.sql") });
    await expect(listMyAsks(session)).rejects.toMatchObject({ status: 503 });
    expect(askClaude).not.toHaveBeenCalled();
  });
});

describe("askVault — a follow-up", () => {
  it("brings back what earlier answers cited, searches with the previous question too, and shows the earlier turns", async () => {
    found = [ITEM_C, ITEM_A];
    reply("<answer>重疾险看保额 [S2]，应急金照旧 [S1]。</answer>");
    const detail = await askVault(session, { id: ASK, question: "那保险呢" });

    // 引用过的排在前面、标出来；搜索又找到它时不重复
    expect(prompt()).toContain("[S1] 30 岁开始理财晚吗（抖音 · 小鹿聊钱，2026-11-20 存的）〔之前的回答引用过〕");
    expect(prompt()).toContain("[S2] 怎么选重疾险");
    expect(prompt()).not.toContain("[S3]");
    expect(prompt()).toContain("<之前的对话>\n他：怎么开始理财\n你：先存应急金。\n</之前的对话>");
    expect(JSON.stringify(searched[0].p_terms)).toContain("那保险呢");
    expect(JSON.stringify(searched[0].p_terms)).toContain("怎么开始理财");

    expect(detail.ask.chat).toHaveLength(4);
    expect(detail.ask.chat[3]).toMatchObject({ text: "重疾险看保额[1]，应急金照旧[2]。", cites: [{ id: ITEM_C }, { id: ITEM_A }] });
    const row = mine()[0];
    expect(row.title).toBe("怎么开始理财");
    expect(row.sources).toEqual([ITEM_A, ITEM_C]);
    expect(row.usage["tok_in|anthropic|claude-opus-5-5"]).toBe(3000);
  });

  it("an item cited earlier and deleted since is reported as gone and no longer carried", async () => {
    setup({ items: [item(ITEM_B, "指数基金定投")] });
    expect((await getAskDetail(session, ASK)).gone).toEqual([ITEM_A]);
    found = [ITEM_B];
    reply("<answer>定投 [S1]</answer>");
    const detail = await askVault(session, { id: ASK, question: "定投呢" });
    expect(prompt()).not.toContain("之前的回答引用过〕");
    expect(mine()[0].sources).toEqual([ITEM_B]);
    expect(detail.gone).toEqual([ITEM_A]);
  });
});

describe("other people's questions", () => {
  it("cannot be read, continued or deleted", async () => {
    await expect(getAskDetail(session, THEIRS)).rejects.toMatchObject({ status: 404 });
    await expect(askVault(session, { id: THEIRS, question: "接着问" })).rejects.toMatchObject({ status: 404 });
    await expect(askVault(session, { id: "not-an-id", question: "接着问" })).rejects.toMatchObject({ status: 404 });
    expect(askClaude).not.toHaveBeenCalled();
    await removeAsk(session, THEIRS);
    expect(asks().find((a) => a.id === THEIRS)).toMatchObject({ title: "别人问的" });
    expect((await listMyAsks(session)).map((a) => a.id)).toEqual([ASK]);
  });

  it("lists mine with the number of questions and the start of the last answer; deleting removes it", async () => {
    expect(await listMyAsks(session)).toEqual([{ id: ASK, title: "怎么开始理财", updatedAt: "2026-11-25T00:00:00.000Z", turns: 1, excerpt: "先存应急金。" }]);
    await removeAsk(session, ASK);
    expect(mine()).toHaveLength(0);
    await expect(removeAsk(session, "nope")).rejects.toMatchObject({ status: 404 });
  });
});
