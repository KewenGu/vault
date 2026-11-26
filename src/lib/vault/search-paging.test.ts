import { beforeEach, describe, expect, it } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { PAGE_SIZE, SEARCH_CAP, searchItems } from "./search";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
/** 第 n 条：n 越大存得越晚 */
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  user_id: USER,
  source: "link",
  dedupe_key: `k${n}`,
  platform: "douyin",
  status: "ready",
  kind: "video",
  title: `第 ${n} 条`,
  media: [],
  summary: "",
  content_type: n % 2 ? "recipe" : "place",
  category: "food",
  tags: n % 3 === 0 ? ["三亚"] : [],
  tags_locked: false,
  cost_usd: 0,
  started_at: "2026-11-01T00:00:00.000Z",
  processed_at: null,
  created_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
  updated_at: "2026-11-01T00:00:00.000Z",
  ...over,
});

let fake: FakeSupabase;
let rpcCalls: Record<string, unknown>[] = [];
/** search_items 返回多少行（id 从 1 起） */
let ranked = 0;

beforeEach(() => {
  rpcCalls = [];
  ranked = 0;
  fake = makeFakeSupabase(
    { items: [...Array.from({ length: 150 }, (_, i) => item(i + 1)), item(900, { status: "uploading" }), item(901, { user_id: OTHER })] },
    {
      rpc: {
        search_items: (args) => {
          rpcCalls.push(args);
          return Array.from({ length: Math.min(ranked, Number(args.p_limit)) }, (_, i) => ({ id: id(i + 1), keyword_hits: 1, similarity: null, score: 1 - i / 1000 }));
        },
      },
    }
  );
});

const titles = (r: Awaited<ReturnType<typeof searchItems>>) => r.hits.map((h) => h.item.title);

describe("searchItems — browsing page by page", () => {
  it("lists newest first straight from the table, with the exact total, all the way to the oldest", async () => {
    const first = await searchItems(fake.db, USER, { offset: 0 });
    expect(first.hits).toHaveLength(PAGE_SIZE);
    expect(titles(first).slice(0, 2)).toEqual(["第 150 条", "第 149 条"]);
    expect(first).toMatchObject({ total: 150, capped: false, semantic: false });

    const last = await searchItems(fake.db, USER, { offset: 120 });
    expect(last.hits).toHaveLength(30);
    expect(titles(last).at(-1)).toBe("第 1 条");
    expect(last.total).toBe(150);
    // 只是列出时不调搜索函数（它最多给 200 条，翻不到后面）
    expect(rpcCalls).toHaveLength(0);
    // 别人的、还在等上传的都不在里面
    const all = [...first.hits, ...(await searchItems(fake.db, USER, { offset: 60 })).hits, ...last.hits];
    expect(new Set(all.map((h) => h.item.id)).size).toBe(150);
    expect(all.every((h) => h.item.userId === USER && h.item.status !== "uploading")).toBe(true);
  });

  it("applies the same filters as the search function, and counts only what matches", async () => {
    const places = await searchItems(fake.db, USER, { filters: { contentType: "place" }, offset: 0, limit: 10 });
    expect(places.total).toBe(75);
    expect(titles(places).slice(0, 2)).toEqual(["第 150 条", "第 148 条"]);
    const tagged = await searchItems(fake.db, USER, { filters: { tag: "三亚", contentType: "recipe" }, offset: 0 });
    expect(tagged.total).toBe(25);
    expect(tagged.hits.every((h) => h.item.tags.includes("三亚") && h.item.contentType === "recipe")).toBe(true);
    expect((await searchItems(fake.db, USER, { filters: { platform: "youtube" }, offset: 0 })).total).toBe(0);
  });

  it("a page past the end is empty but still knows the total", async () => {
    const past = await searchItems(fake.db, USER, { offset: 600 });
    expect(past.hits).toEqual([]);
    expect(past.total).toBe(150);
  });
});

describe("searchItems — paging through search results", () => {
  it("asks the search function for everything it can give, slices the page out, and says when the cap was hit", async () => {
    ranked = 500;
    const second = await searchItems(fake.db, USER, { q: "牛腩", offset: 60 });
    expect(rpcCalls[0]).toMatchObject({ p_limit: SEARCH_CAP, p_terms: ["牛腩"] });
    expect(second.hits).toHaveLength(60);
    expect(second.hits[0].item.id).toBe(id(61));
    expect(second).toMatchObject({ total: SEARCH_CAP, capped: true });

    ranked = 70;
    const short = await searchItems(fake.db, USER, { q: "牛腩", offset: 60 });
    expect(short.hits.map((h) => h.item.id)).toEqual(Array.from({ length: 10 }, (_, i) => id(61 + i)));
    expect(short).toMatchObject({ total: 70, capped: false });
  });

  it("filtering by a graph entity goes through the search function too", async () => {
    ranked = 5;
    const r = await searchItems(fake.db, USER, { filters: { entityId: "e1" }, offset: 0 });
    expect(rpcCalls[0]).toMatchObject({ p_entity_id: "e1", p_limit: SEARCH_CAP });
    expect(r).toMatchObject({ total: 5, capped: false });
  });

  it("callers that only want the top few (no offset) get exactly what they asked for", async () => {
    ranked = 500;
    const r = await searchItems(fake.db, USER, { q: "牛腩", limit: 12 });
    expect(rpcCalls[0]).toMatchObject({ p_limit: 12 });
    expect(r.hits).toHaveLength(12);
    expect(r).toMatchObject({ total: 12, capped: false });
  });
});
