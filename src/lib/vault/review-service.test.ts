import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

vi.mock("@/lib/ai/claude", async (original) => ({ ...(await original<typeof import("@/lib/ai/claude")>()), askClaude: vi.fn() }));

import { askClaude } from "@/lib/ai/claude";
import { reviewTitle } from "./review";
import { getResurfaced, getReview, writeWeekReview } from "./review-service";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// 看的人在北京：2026-11-27（周五），这一周是 11-23 – 11-29，在库里是 11-22T16:00Z – 11-29T16:00Z
const TODAY = "2026-11-27";
const TZ = -480;
const WEEK = "2026-11-23";

const item = (n: number, createdAt: string, over: Record<string, unknown> = {}) => ({
  id: id(n),
  user_id: USER,
  source: "link",
  dedupe_key: `k:${n}`,
  platform: "douyin",
  status: "ready",
  kind: "video",
  title: `内容 ${n}`,
  author: "阿书",
  media: [],
  summary: `概括 ${n}`,
  content_type: "knowledge",
  category: "health",
  tags: [],
  tags_locked: false,
  note: null,
  cost_usd: 0,
  started_at: createdAt,
  processed_at: null,
  created_at: createdAt,
  updated_at: createdAt,
  ...over,
});
const entity = (n: number, name: string) => ({ id: id(n), user_id: USER, type: "concept", name, aliases: [], summary: "" });
const link = (itemN: number, entityN: number) => ({ item_id: id(itemN), entity_id: id(entityN), user_id: USER, about: "" });
const askRow = (n: number, title: string, updatedAt: string) => ({ id: id(n), user_id: USER, title, chat: [{ role: "user", text: title, at: updatedAt }], sources: [], usage: {}, cost_usd: 0, created_at: updatedAt, updated_at: updatedAt });

let fake: FakeSupabase;
let session: Session;

function setup(over: Record<string, Record<string, unknown>[]> = {}, opts: Parameters<typeof makeFakeSupabase>[1] = {}) {
  fake = makeFakeSupabase(
    {
      items: [
        // 这一周（北京时间）：周一凌晨存的那条在 UTC 里还是周日
        item(1, "2026-11-22T16:30:00.000Z", { tags: ["练肩", "健身"] }),
        item(2, "2026-11-25T03:00:00.000Z", { tags: ["练肩"], category: "health" }),
        item(3, "2026-11-26T03:00:00.000Z", { category: "finance", tags: ["理财"] }),
        item(4, "2026-11-27T01:00:00.000Z", { source: "own", platform: null, author: null, kind: "text", category: "finance", user_text: "定投别停，跌的时候更要买", title: "定投的打算" }),
        item(5, "2026-11-27T02:00:00.000Z", { status: "analyzing", category: null, summary: null }),
        item(6, "2026-11-27T02:30:00.000Z", { status: "uploading" }),
        // 上一周和更早的
        item(7, "2026-11-22T15:00:00.000Z"),
        item(8, "2026-11-10T03:00:00.000Z"),
        item(9, "2026-10-27T03:00:00.000Z", { title: "一个月前的今天存的" }),
        item(10, "2025-11-27T03:00:00.000Z", { title: "一年前的今天存的" }),
        item(11, "2026-11-26T03:00:00.000Z", { user_id: OTHER }),
      ],
      entities: [entity(101, "三角肌"), entity(102, "应急金"), entity(103, "只出现一次的")],
      item_entities: [link(1, 101), link(2, 101), link(3, 102), link(4, 102), link(2, 103), link(8, 101)],
      item_notes: [
        { id: "n1", user_id: USER, item_id: id(8), quote: "写在以前存的内容上", body: "", at: null, created_at: "2026-11-26T05:00:00.000Z", updated_at: "t" },
        { id: "n2", user_id: USER, item_id: id(2), quote: "中束是羽状肌", body: "所以能天天练？", at: 72, created_at: "2026-11-25T05:00:00.000Z", updated_at: "t" },
        { id: "n3", user_id: USER, item_id: id(8), quote: "上一周写的", body: "", at: null, created_at: "2026-11-20T05:00:00.000Z", updated_at: "t" },
      ],
      asks: [askRow(201, "这一周问的", "2026-11-26T08:00:00.000Z"), askRow(202, "上个月问的", "2026-10-26T08:00:00.000Z")],
      ...over,
    },
    opts
  );
  session = { user: { id: USER }, db: fake.db } as unknown as Session;
}

beforeEach(() => {
  vi.mocked(askClaude).mockReset();
  setup();
});

const titles = (items: { title: string }[]) => items.map((i) => i.title);

describe("getReview", () => {
  it("gathers the week in the reader's own time zone: what was saved, what recurs, what was written and asked", async () => {
    const { week, today } = await getReview(session, { today: TODAY, tz: TZ });
    expect(today).toBe(TODAY);
    expect(week).toMatchObject({ week: WEEK, lastDay: "2026-11-29", label: "11 月 23 日 – 29 日", more: false, aiReviewId: null, gaps: [] });
    // 周一凌晨（UTC 还是周日）存的算这一周；UTC 周日下午 3 点（北京周日 23 点）存的不算；还在等上传的、别人的不在里面
    expect(titles(week.items)).toEqual(["内容 5", "定投的打算", "内容 3", "内容 2", "内容 1"]);
    expect(week.byCategory.map((g) => [g.label, titles(g.items)])).toEqual([
      ["健康与健身", ["内容 2", "内容 1"]],
      ["理财", ["定投的打算", "内容 3"]],
    ]);
    // 不止一条内容提到的才算；以前的内容提到的不算进这一周的次数
    expect(week.entities.map((e) => `${e.name}×${e.count}`)).toEqual(["三角肌×2", "应急金×2"]);
    expect(week.tags).toEqual([{ tag: "练肩", count: 2 }]);
    expect(titles(week.own)).toEqual(["定投的打算"]);
    // 这一周写的笔记，写在以前存的内容上的也算
    expect(week.notes.map((n) => [n.note.id, n.itemTitle])).toEqual([["n1", "内容 8"], ["n2", "内容 2"]]);
    expect(week.asks.map((a) => a.title)).toEqual(["这一周问的"]);
  });

  it("shows another week when asked, and finds the AI review written for it", async () => {
    setup({ asks: [askRow(203, reviewTitle("2026-11-16"), "2026-11-23T08:00:00.000Z")] });
    const { week } = await getReview(session, { today: TODAY, tz: TZ, week: "2026-11-22" });
    expect(week.week).toBe("2026-11-16");
    expect(titles(week.items)).toEqual(["内容 7"]);
    expect(week.aiReviewId).toBe(id(203));
    expect(week.notes.map((n) => n.note.id)).toEqual(["n3"]);
  });

  it("resurfaces a few older items for the day, plus what was saved on this day in the past", async () => {
    const { resurfaced } = await getReview(session, { today: TODAY, tz: TZ });
    // 候选是这一周之前存的、处理好的（7、8、9、10），一天挑 3 条；同一天再问还是这 3 条
    expect(resurfaced!.picks).toHaveLength(3);
    expect(resurfaced!.picks.every((i) => ["内容 7", "内容 8", "一个月前的今天存的", "一年前的今天存的"].includes(i.title))).toBe(true);
    expect(titles((await getResurfaced(session, { today: TODAY, tz: TZ }))!.picks)).toEqual(titles(resurfaced!.picks));
    expect(resurfaced!.lookBack.map((x) => [x.label, x.item.title])).toEqual([["1 个月前", "一个月前的今天存的"], ["1 年前", "一年前的今天存的"]]);
  });

  it("an empty library has nothing to resurface; a bad date is refused", async () => {
    setup({ items: [], item_entities: [], item_notes: [], asks: [] });
    const review = await getReview(session, { today: TODAY, tz: TZ });
    expect(review.week.items).toEqual([]);
    expect(review.resurfaced).toEqual({ picks: [], lookBack: [] });
    await expect(getReview(session, { today: "昨天" })).rejects.toMatchObject({ status: 400 });
    await expect(getResurfaced(session, { today: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("still lists the week when the graph, the notes or the asks cannot be read, and says what is missing", async () => {
    setup({}, { failSelect: { item_entities: { message: "connection reset" }, item_notes: { message: "connection reset" }, asks: { message: "connection reset" } } });
    const { week } = await getReview(session, { today: TODAY, tz: TZ });
    expect(week.items).toHaveLength(5);
    expect(week.gaps).toEqual([expect.stringContaining("常出现的人和东西"), expect.stringContaining("划的线和写的批注"), expect.stringContaining("问过的问题")]);
    // 表还没建（迁移没推）就是没有，不算出错
    setup({}, { failSelect: { item_notes: { message: "no table", code: "PGRST205" }, asks: { message: "no table", code: "PGRST205" } } });
    expect((await getReview(session, { today: TODAY, tz: TZ })).week.gaps).toEqual([]);
  });
});

describe("writeWeekReview", () => {
  const reply = (text: string) => vi.mocked(askClaude).mockResolvedValueOnce({ text, model: "m", truncated: false, usage: { input: 1000, output: 200 } } as never);
  const prompt = () => vi.mocked(askClaude).mock.calls[0][0].prompt as string;
  const stored = (askId: string) => fake.store.asks.find((a) => a.id === askId) as { title: string; chat: { role: string; text: string; cites?: { id: string }[]; notes?: string[]; seen?: number }[]; sources: string[] };

  it("gives the model the week's processed items with the user's own words, and stores the review as an ask with its sources", async () => {
    reply("<answer>这一周两条线。练肩：少推多飞 [S3][S4]。理财：你写过定投别停 [S1]，还有一处编的 [S9]。</answer>");
    const made = await writeWeekReview(session, { week: TODAY, tz: TZ });
    expect(made.existing).toBe(false);
    // 处理好的 4 条，新存的在前；还在处理的不给模型看
    expect(prompt()).toContain("[S1] 定投的打算（自己写的，11-27 写的");
    expect(prompt()).toContain("他写的原文：定投别停，跌的时候更要买");
    expect(prompt()).toContain("[S3] 内容 2");
    expect(prompt()).toContain("- 划线（1:12）：「中束是羽状肌」——他写的：所以能天天练？");
    expect(prompt()).not.toContain("内容 5");
    expect(prompt()).not.toContain("内容 7");
    const ask = stored(made.id);
    expect(ask.title).toBe(reviewTitle(WEEK));
    expect(ask.chat[0]).toMatchObject({ role: "user", text: "回顾 11 月 23 日 – 29 日 这一周存的和写的" });
    expect(ask.chat[1]).toMatchObject({ role: "assistant", text: "这一周两条线。练肩：少推多飞[1][2]。理财：你写过定投别停[3]，还有一处编的。", seen: 4 });
    expect(ask.chat[1].cites!.map((c) => c.id)).toEqual([id(2), id(1), id(4)]);
    expect(ask.chat[1].notes).toEqual([expect.stringContaining("1 处出处的编号对不上")]);
    expect(ask.sources).toEqual([id(2), id(1), id(4)]);
    // 回顾页认得出这一周写过了
    expect((await getReview(session, { today: TODAY, tz: TZ })).week.aiReviewId).toBe(made.id);
  });

  it("does not pay twice for the same week", async () => {
    reply("<answer>回顾 [S1]</answer>");
    const first = await writeWeekReview(session, { week: WEEK, tz: TZ });
    expect(await writeWeekReview(session, { week: "2026-11-29", tz: TZ })).toEqual({ id: first.id, existing: true });
    expect(askClaude).toHaveBeenCalledTimes(1);
  });

  it("has nothing to review in an empty week, and says so before calling the model", async () => {
    await expect(writeWeekReview(session, { week: "2026-09-01", tz: TZ })).rejects.toMatchObject({ message: expect.stringContaining("没什么可回顾的") });
    await expect(writeWeekReview(session, { week: "哪一周" })).rejects.toMatchObject({ status: 400 });
    expect(askClaude).not.toHaveBeenCalled();
  });

  it("an empty reply is an error the user can act on, and nothing is stored", async () => {
    reply("<answer>  </answer>");
    await expect(writeWeekReview(session, { week: WEEK, tz: TZ })).rejects.toMatchObject({ status: 502 });
    expect(fake.store.asks.some((a) => a.title === reviewTitle(WEEK))).toBe(false);
  });

  it("only the most recent items go to the model when the week is very full, and the review says so", async () => {
    setup({ items: Array.from({ length: 70 }, (_, i) => item(i + 1, new Date(Date.UTC(2026, 10, 24, 0, i)).toISOString())), item_entities: [], item_notes: [], asks: [] });
    reply("<answer>很多 [S1]</answer>");
    const made = await writeWeekReview(session, { week: WEEK, tz: TZ });
    expect(prompt()).toContain("[S60]");
    expect(prompt()).not.toContain("[S61]");
    expect(prompt()).toContain("这一周存了 70 条，只看了最近存的 60 条");
    expect(stored(made.id).chat[1].notes).toEqual([expect.stringContaining("只看了最近存的 60 条")]);
  });
});
