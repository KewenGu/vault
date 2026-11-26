import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { RELATED_MAX, RELATED_MIN_SIMILARITY, findRelated, rankRelated } from "./related";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ME = id(1);
const SANYA = "e0000001-0000-4000-8000-000000000000";
const HOTEL = "e0000002-0000-4000-8000-000000000000";
const XHS = "e0000003-0000-4000-8000-000000000000";

describe("rankRelated", () => {
  it("puts similar items first, lifts the ones that also share something, and orders shared entities rarest first", () => {
    const ranked = rankRelated([
      { id: "plain", similarity: 0.8, shared: [] },
      { id: "boosted", similarity: 0.7, shared: [{ id: "common", others: 10 }, { id: "rare", others: 1 }] },
      { id: "entity-only", similarity: null, shared: [{ id: "rare", others: 1 }] },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["boosted", "plain", "entity-only"]);
    expect(ranked[0].shared.map((s) => s.id)).toEqual(["rare", "common"]);
    expect(ranked[0].score).toBeCloseTo(0.95);
  });

  it("does not call two items related because they both mention something everything mentions", () => {
    const ranked = rankRelated([
      { id: "hub-only", similarity: null, shared: [{ id: "xhs", others: 40 }] },
      { id: "two-of-three", similarity: null, shared: [{ id: "a", others: 3 }, { id: "b", others: 3 }] },
      { id: "one-of-two", similarity: null, shared: [{ id: "c", others: 2 }] },
      { id: "one-of-three", similarity: null, shared: [{ id: "d", others: 3 }] },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["two-of-three", "one-of-two"]);
  });

  it("keeps a similar item even when it shares nothing, and caps the list", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, similarity: 0.9 - i * 0.01, shared: [] }));
    expect(rankRelated(many).map((r) => r.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(rankRelated(many, 2)).toHaveLength(2);
  });
});

const item = (n: number, title: string, over: Record<string, unknown> = {}) => ({
  id: id(n),
  user_id: USER,
  source: "link",
  dedupe_key: `k${n}`,
  platform: "xhs",
  status: "ready",
  title,
  author: "",
  media: [],
  summary: `${title}的概括`,
  tags: [],
  tags_locked: false,
  embedding: "[1,0]",
  cost_usd: 0,
  started_at: "2026-11-20T00:00:00.000Z",
  processed_at: "2026-11-20T00:01:00.000Z",
  created_at: "2026-11-20T00:00:00.000Z",
  updated_at: "2026-11-20T00:00:00.000Z",
  ...over,
});
const mention = (itemN: number, entity: string, user = USER) => ({ item_id: id(itemN), entity_id: entity, user_id: user, about: "" });

let fake: FakeSupabase;
/** search_items 返回什么（按顺序）；null = 让它报错 */
let similar: { id: string; similarity: number }[] | null = [];
let searched: Record<string, unknown>[] = [];

function setup(seed: { items?: Record<string, unknown>[]; item_entities?: Record<string, unknown>[] } = {}) {
  fake = makeFakeSupabase(
    {
      items: seed.items ?? [item(1, "三亚亲子酒店测评"), item(2, "三亚本地人去的海鲜店"), item(3, "亚特兰蒂斯值不值"), item(4, "新手力量训练"), item(5, "别人的三亚攻略", { user_id: OTHER })],
      entities: [
        { id: SANYA, user_id: USER, type: "place", name: "三亚" },
        { id: HOTEL, user_id: USER, type: "place", name: "亚特兰蒂斯" },
        { id: XHS, user_id: USER, type: "org", name: "小红书" },
      ],
      item_entities: seed.item_entities ?? [mention(1, SANYA), mention(1, HOTEL), mention(1, XHS), mention(2, SANYA), mention(3, HOTEL), mention(3, SANYA), mention(4, XHS), mention(5, SANYA, OTHER)],
    },
    {
      rpc: {
        search_items: (args) => {
          searched.push(args);
          if (similar === null) throw new Error("boom");
          return similar.map((s, i) => ({ id: s.id, keyword_hits: 0, similarity: s.similarity, score: 1 - i * 0.01 }));
        },
      },
    }
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  similar = [];
  searched = [];
  setup();
});

describe("findRelated", () => {
  it("asks the search function for neighbours of the item's own vector, and says why each one is related", async () => {
    similar = [{ id: ME, similarity: 1 }, { id: id(3), similarity: 0.75 }, { id: id(4), similarity: 0.7 }];
    const { items, notes } = await findRelated(fake.db, USER, { id: ME, status: "ready" });

    expect(searched[0]).toMatchObject({ p_user_id: USER, p_terms: [], p_embedding: "[1,0]", p_min_similarity: RELATED_MIN_SIMILARITY });
    // 自己不算；3 内容相近又都提到酒店和三亚，排最前；4 只是相近；2 只靠都提到三亚（另外只有两条提到，够稀有）
    expect(items.map((r) => r.item.title)).toEqual(["亚特兰蒂斯值不值", "新手力量训练", "三亚本地人去的海鲜店"]);
    expect(items[0]).toMatchObject({ similarity: 0.75, shared: [{ id: HOTEL, name: "亚特兰蒂斯", type: "place" }, { id: SANYA, name: "三亚" }] });
    // 4 也提到了「小红书」，那是它们共同提到的东西，照实列出来
    expect(items[1]).toMatchObject({ similarity: 0.7, shared: [{ name: "小红书" }] });
    expect(items[2]).toMatchObject({ similarity: null, shared: [{ name: "三亚" }] });
    expect(notes).toEqual([]);
  });

  it("never shows another user's items", async () => {
    similar = [{ id: id(5), similarity: 0.99 }];
    const { items } = await findRelated(fake.db, USER, { id: ME, status: "ready" });
    expect(items.map((r) => r.item.id)).not.toContain(id(5));
  });

  it("an item without a vector still gets its entity neighbours, and the page is told what was not looked at", async () => {
    setup({ items: [item(1, "三亚亲子酒店测评", { embedding: null }), item(2, "三亚本地人去的海鲜店"), item(3, "亚特兰蒂斯值不值")] });
    const { items, notes } = await findRelated(fake.db, USER, { id: ME, status: "ready" });
    expect(searched).toHaveLength(0);
    expect(items.map((r) => r.item.title)).toEqual(["亚特兰蒂斯值不值", "三亚本地人去的海鲜店"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("没有向量");
  });

  it("when the vector query fails it falls back to entities and says so; with nothing shared either, the list is empty", async () => {
    similar = null;
    const first = await findRelated(fake.db, USER, { id: ME, status: "ready" });
    // 4 和它都提到「小红书」，而且只有它们两条提到：在这个小库里它算稀有的，排在只共有「三亚」（另有两条提到）的 2 前面
    expect(first.items.map((r) => r.item.title)).toEqual(["亚特兰蒂斯值不值", "新手力量训练", "三亚本地人去的海鲜店"]);
    expect(first.items.every((r) => r.similarity === null)).toBe(true);
    expect(first.notes[0]).toContain("查询出错");

    setup({ item_entities: [] });
    similar = [];
    expect(await findRelated(fake.db, USER, { id: ME, status: "ready" })).toEqual({ items: [], notes: [] });
  });

  it("leaves out items that are not processed, and does not look at all for an item that is not ready itself", async () => {
    setup({ items: [item(1, "我"), item(2, "还在处理", { status: "analyzing" }), item(3, "失败了", { status: "failed" }), item(4, "好的")], item_entities: [] });
    similar = [{ id: id(2), similarity: 0.9 }, { id: id(3), similarity: 0.85 }, { id: id(4), similarity: 0.8 }];
    expect((await findRelated(fake.db, USER, { id: ME, status: "ready" })).items.map((r) => r.item.title)).toEqual(["好的"]);

    searched = [];
    expect(await findRelated(fake.db, USER, { id: ME, status: "analyzing" })).toEqual({ items: [], notes: [] });
    expect(searched).toHaveLength(0);
  });

  it("uses the entities the caller already loaded, and never lists more than the cap", async () => {
    setup({ items: [item(1, "我"), ...Array.from({ length: 9 }, (_, i) => item(i + 2, `第 ${i + 2} 条`))], item_entities: [] });
    similar = Array.from({ length: 9 }, (_, i) => ({ id: id(i + 2), similarity: 0.9 - i * 0.01 }));
    const { items } = await findRelated(fake.db, USER, { id: ME, status: "ready" }, []);
    expect(items).toHaveLength(RELATED_MAX);
    expect(items[0].item.title).toBe("第 2 条");
    expect(fake.ops.filter((o) => o.includes("entities"))).toEqual([]);
  });
});
