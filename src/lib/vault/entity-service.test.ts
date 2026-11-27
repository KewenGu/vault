import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

vi.mock("@/lib/embeddings", () => ({ embedTexts: vi.fn() }));

import { embedTexts } from "@/lib/embeddings";
import { getEntityPage, mergeEntity, moveItems, removeAlias, renameEntity } from "./entity-service";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [MUNGER, CHARLIE, BOOK, BUFFETT, THEIRS, ORG] = [id(101), id(102), id(103), id(104), id(105), id(106)];
const [I1, I2, I3] = [id(1), id(2), id(3)];

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  user_id: USER,
  source: "link",
  dedupe_key: `k:${n}`,
  platform: "douyin",
  status: "ready",
  kind: "video",
  title: `内容 ${n}`,
  author: "小鹿",
  media: [],
  summary: `概括 ${n}`,
  tags: [],
  tags_locked: false,
  cost_usd: 0,
  started_at: "2026-11-01T00:00:00.000Z",
  processed_at: null,
  created_at: `2026-11-0${n}T00:00:00.000Z`,
  updated_at: "2026-11-01T00:00:00.000Z",
  ...over,
});
const entity = (eid: string, type: string, name: string, over: Record<string, unknown> = {}) => ({ id: eid, user_id: USER, type, name, aliases: [], summary: "", embedding: null, ...over });
const link = (itemId: string, entityId: string, about = "") => ({ item_id: itemId, entity_id: entityId, user_id: USER, about });
const edge = (itemId: string, src: string, dst: string, relation: string) => ({ item_id: itemId, src_id: src, dst_id: dst, relation, user_id: USER });

let fake: FakeSupabase;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let session: Session;

function setup(opts: Parameters<typeof makeFakeSupabase>[1] = {}) {
  rpcCalls = [];
  fake = makeFakeSupabase(
    {
      items: [item(1), item(2), item(3, { source: "own", platform: null, author: null, kind: "text" }), item(9, { user_id: OTHER })],
      entities: [
        entity(MUNGER, "person", "芒格", { aliases: ["Munger", "查理"], summary: "写《穷查理宝典》的人" }),
        entity(CHARLIE, "person", "查理·芒格"),
        entity(BOOK, "work", "穷查理宝典"),
        entity(BUFFETT, "person", "巴菲特", { aliases: ["股神"] }),
        entity(THEIRS, "person", "别人的芒格", { user_id: OTHER }),
        entity(ORG, "org", "伯克希尔"),
      ],
      item_entities: [link(I1, MUNGER, "书的作者"), link(I1, BOOK), link(I2, MUNGER), link(I2, BUFFETT), link(I3, MUNGER, "我想学的人"), link(I2, CHARLIE)],
      entity_edges: [edge(I1, BOOK, MUNGER, "made_by"), edge(I2, MUNGER, BUFFETT, "related")],
      item_notes: [
        { id: "n1", user_id: USER, item_id: I1, quote: "反过来想", body: "", at: 72, created_at: "2026-11-10T00:00:00.000Z", updated_at: "t" },
        { id: "n2", user_id: USER, item_id: I3, quote: "", body: "明年读完", at: null, created_at: "2026-11-12T00:00:00.000Z", updated_at: "t" },
        { id: "n3", user_id: OTHER, item_id: id(9), quote: "别人的", body: "", at: null, created_at: "2026-11-13T00:00:00.000Z", updated_at: "t" },
      ],
    },
    {
      ...opts,
      rpc: {
        // 按实体筛：连着它的内容，新存的在前
        search_items: (args, store) =>
          store.item_entities
            .filter((r) => r.entity_id === args.p_entity_id && r.user_id === args.p_user_id)
            .map((r) => ({ id: r.item_id as string, keyword_hits: 0, similarity: null, score: 0 }))
            .sort((a, b) => b.id.localeCompare(a.id))
            .slice(0, Number(args.p_limit)),
        merge_entities: (args) => {
          rpcCalls.push({ name: "merge_entities", args });
          return 3;
        },
        // 真的那个在数据库里（迁移测试测它）；这里只把关联改挂过去，够看「一条都不剩」那一步
        move_entity_links: (args, store) => {
          rpcCalls.push({ name: "move_entity_links", args });
          const picked = args.p_item_ids as string[];
          const rows = store.item_entities.filter((r) => r.entity_id === args.p_from && picked.includes(r.item_id as string));
          for (const r of rows) r.entity_id = args.p_into;
          return rows.length;
        },
        ...opts.rpc,
      },
    }
  );
  session = { user: { id: USER }, db: fake.db } as unknown as Session;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(embedTexts).mockReset();
  setup();
});

const row = (eid: string) => fake.store.entities.find((e) => e.id === eid);

describe("getEntityPage", () => {
  it("gathers what the library holds about one entity: its items with its role in each, related entities, the user's own notes", async () => {
    const page = await getEntityPage(session, MUNGER);
    expect(page.entity).toEqual({ id: MUNGER, type: "person", name: "芒格", aliases: ["Munger", "查理"], summary: "写《穷查理宝典》的人" });
    expect(page.items.map((i) => [i.item.id, i.about])).toEqual([[I3, "我想学的人"], [I2, ""], [I1, "书的作者"]]);
    expect(page).toMatchObject({ total: 3, capped: false, gaps: [] });
    // 明说了关系的在前（带方向），再是只在同一条内容里出现过的
    expect(page.neighbors.map((n) => `${n.name}:${n.relation}:${n.outgoing}:${n.weight}`)).toEqual(["巴菲特:related:true:1", "穷查理宝典:made_by:false:1", "查理·芒格:cooccur:false:1"]);
    expect(page.notes.map((n) => [n.note.id, n.itemTitle])).toEqual([["n2", "内容 3"], ["n1", "内容 1"]]);
    // 合并、移动时提示用的名字：同一类里别的，提到的内容多的在前；别人的、别的类的不在里面
    expect(page.names).toEqual(["巴菲特", "查理·芒格"]);
  });

  it("is a 404 for someone else's entity, a missing one, or something that is not an id", async () => {
    await expect(getEntityPage(session, THEIRS)).rejects.toMatchObject({ status: 404 });
    await expect(getEntityPage(session, id(999))).rejects.toMatchObject({ status: 404 });
    await expect(getEntityPage(session, "芒格")).rejects.toMatchObject({ status: 404 });
  });

  it("still shows the items when the graph or the notes cannot be read, and says what is missing", async () => {
    setup({ failSelect: { entity_edges: { message: "connection reset" }, item_notes: { message: "connection reset" } } });
    const page = await getEntityPage(session, MUNGER);
    expect(page.items).toHaveLength(3);
    expect(page.neighbors).toEqual([]);
    expect(page.notes).toEqual([]);
    expect(page.gaps).toEqual([expect.stringContaining("没读到和它有关系的其他实体"), expect.stringContaining("没读到你在这些内容上划的线和写的批注")]);
  });
});

describe("renameEntity / removeAlias", () => {
  it("keeps the old name as an alias, so later items using it still land here", async () => {
    const renamed = await renameEntity(session, MUNGER, { name: "  查理·T·芒格 ", summary: "伯克希尔的副董事长" });
    expect(renamed).toMatchObject({ name: "查理·T·芒格", aliases: ["Munger", "查理", "芒格"], summary: "伯克希尔的副董事长" });
    expect(row(MUNGER)).toMatchObject({ name: "查理·T·芒格", aliases: ["Munger", "查理", "芒格"] });
  });

  it("an alias promoted to the name stops being an alias; changing only the description leaves the names alone", async () => {
    expect((await renameEntity(session, MUNGER, { name: "munger" })).aliases).toEqual(["查理", "芒格"]);
    expect((await renameEntity(session, BUFFETT, { summary: "伯克希尔的董事长" }))).toMatchObject({ name: "巴菲特", aliases: ["股神"], summary: "伯克希尔的董事长" });
  });

  it("refuses an empty name, and a name another entity of the same type already has", async () => {
    await expect(renameEntity(session, MUNGER, { name: "   " })).rejects.toMatchObject({ message: "名字不能是空的" });
    setup({ failUpdate: { entities: { message: "duplicate key value violates unique constraint \"entities_name_key\"", code: "23505" } } });
    await expect(renameEntity(session, MUNGER, { name: "巴菲特" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已经有一个叫「巴菲特」的人物了") });
    await expect(renameEntity(session, THEIRS, { name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("drops an alias that was merged in by mistake", async () => {
    expect((await removeAlias(session, MUNGER, "查理")).aliases).toEqual(["Munger"]);
    expect(row(MUNGER)?.aliases).toEqual(["Munger"]);
    await expect(removeAlias(session, THEIRS, "x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("mergeEntity", () => {
  it("finds the target by name or alias within the same type and merges in the database", async () => {
    expect(await mergeEntity(session, MUNGER, "查理·芒格")).toEqual({ id: CHARLIE, name: "查理·芒格", moved: 3 });
    expect(await mergeEntity(session, MUNGER, "股神")).toMatchObject({ id: BUFFETT });
    expect(await mergeEntity(session, MUNGER, BOOK)).toMatchObject({ id: BOOK });
    // 同一类里没有、别的类里正好有一个叫这个名字的，也认
    expect(await mergeEntity(session, MUNGER, "伯克希尔")).toMatchObject({ id: ORG });
    expect(rpcCalls.map((c) => c.args)).toEqual([CHARLIE, BUFFETT, BOOK, ORG].map((into) => ({ p_user_id: USER, p_from: MUNGER, p_into: into })));
  });

  it("does not merge into itself, into nothing, or into someone else's", async () => {
    // 它自己的名字和别名不算「另一个」
    await expect(mergeEntity(session, MUNGER, "芒格")).rejects.toMatchObject({ status: 404 });
    await expect(mergeEntity(session, MUNGER, "Munger")).rejects.toMatchObject({ status: 404 });
    await expect(mergeEntity(session, MUNGER, MUNGER)).rejects.toMatchObject({ status: 404 });
    await expect(mergeEntity(session, MUNGER, "别人的芒格")).rejects.toMatchObject({ status: 404 });
    await expect(mergeEntity(session, MUNGER, THEIRS)).rejects.toMatchObject({ status: 404 });
    await expect(mergeEntity(session, MUNGER, " ")).rejects.toMatchObject({ status: 400 });
    expect(rpcCalls).toEqual([]);
  });

  it("says which migration to push when the database functions are not there yet", async () => {
    setup({ failRpc: { merge_entities: { message: "Could not find the function public.merge_entities", code: "PGRST202" } } });
    await expect(mergeEntity(session, MUNGER, "查理·芒格")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("20261127000001_entity_ops.sql") });
  });
});

describe("moveItems", () => {
  it("moves the picked items to an existing entity and leaves the rest", async () => {
    expect(await moveItems(session, MUNGER, [I2, "不是 id", I2], "巴菲特")).toEqual({ id: BUFFETT, name: "巴菲特", created: false, moved: 1, emptied: false });
    expect(rpcCalls).toEqual([{ name: "move_entity_links", args: { p_user_id: USER, p_from: MUNGER, p_into: BUFFETT, p_item_ids: [I2] } }]);
    expect(row(MUNGER)).toBeDefined();
  });

  it("splitting out one of its aliases makes a new entity of the same type, and the alias goes with it", async () => {
    const moved = await moveItems(session, MUNGER, [I3], "查理");
    expect(moved).toMatchObject({ name: "查理", created: true, moved: 1, emptied: false });
    expect(row(moved.id)).toMatchObject({ user_id: USER, type: "person", name: "查理", embedding: null });
    expect(row(MUNGER)?.aliases).toEqual(["Munger"]);
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("gives the new entity a vector when the vector service is configured, and survives it failing", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "k");
    vi.mocked(embedTexts).mockResolvedValueOnce([[0.1, 0.2]]);
    expect(row((await moveItems(session, MUNGER, [I3], "查理·布朗")).id)?.embedding).toBe("[0.1,0.2]");
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("voyage down"));
    expect(row((await moveItems(session, MUNGER, [I2], "另一个查理")).id)).toMatchObject({ name: "另一个查理", embedding: null });
  });

  it("removes the entity once nothing is left on it", async () => {
    expect(await moveItems(session, MUNGER, [I1, I2, I3], "查理·芒格")).toMatchObject({ id: CHARLIE, moved: 3, emptied: true });
    expect(row(MUNGER)).toBeUndefined();
  });

  it("needs items and a destination that is not itself; nothing moves otherwise", async () => {
    await expect(moveItems(session, MUNGER, [], "巴菲特")).rejects.toMatchObject({ message: "先勾上要移走的内容" });
    await expect(moveItems(session, MUNGER, [I1], "")).rejects.toMatchObject({ status: 400 });
    await expect(moveItems(session, MUNGER, [I1], "芒格")).rejects.toMatchObject({ message: "这就是它自己" });
    await expect(moveItems(session, MUNGER, Array.from({ length: 201 }, (_, n) => id(n + 1000)), "巴菲特")).rejects.toMatchObject({ message: "一次最多移 200 条" });
    await expect(moveItems(session, THEIRS, [I1], "巴菲特")).rejects.toMatchObject({ status: 404 });
    expect(rpcCalls).toEqual([]);
    expect(fake.store.entities).toHaveLength(6);
  });
});
