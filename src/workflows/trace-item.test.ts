import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { recordCall } from "@/lib/usage/meter";
import type { TraceResult } from "@/lib/vault/trace";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("@/lib/vault/trace", async (orig) => ({ ...(await orig<object>()), traceSources: vi.fn() }));

import { traceSources } from "@/lib/vault/trace";
import { traceItem } from "./trace-item";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const STARTED = "2026-11-23T08:00:00.000Z";

const result = (overview: string): TraceResult => ({ origin: "secondary", overview, sources: [], notes: [], searches: 2, fetches: 1, extraReads: [], model: "claude-opus-5-5", at: "2026-11-23T08:01:00.000Z" });
const row = () => fake.store.item_traces[0];

function seed(trace: Record<string, unknown> = {}) {
  fake = makeFakeSupabase({
    items: [{ id: ITEM, user_id: USER, source: "link", platform: "web", url: "https://blog.example.com/a", status: "ready", title: "一篇转述", author: "博客", post: { text: "据某论文……", links: [{ text: "论文", url: "https://arxiv.org/abs/1" }] }, media: [], tags: [], tags_locked: false, understanding: null, cost_usd: 0, started_at: STARTED, created_at: STARTED }],
    item_traces: [{ item_id: ITEM, user_id: USER, status: "running", error: null, result: null, usage: { claude_web_search: 4 }, cost_usd: 0.04, started_at: STARTED, updated_at: STARTED, ...trace }],
  });
}

beforeEach(() => {
  seed();
  vi.mocked(traceSources)
    .mockReset()
    .mockImplementation(async () => {
      recordCall("claude_web_search", 2);
      return result("查到了");
    });
});

describe("traceItem", () => {
  it("查完把结果写回去，用量加在以前的上面", async () => {
    await traceItem(ITEM, USER, STARTED);
    expect(row()).toMatchObject({ status: "ready", error: null, result: result("查到了"), usage: { claude_web_search: 6 }, cost_usd: 0.06 });
    // 给模型的是这条内容读到的东西
    expect(vi.mocked(traceSources).mock.calls[0][0]).toMatchObject({ origin: "网页", title: "一篇转述", body: "据某论文……", links: [{ text: "论文", url: "https://arxiv.org/abs/1" }], language: "zh" });
  });

  it("没成：原因写回去，上一次的结果留着，已经花掉的照样记", async () => {
    seed({ result: result("上一次的") });
    vi.mocked(traceSources).mockImplementation(async () => {
      recordCall("claude_web_search", 1);
      throw new Error("Claude 接口限流了，过一会儿再试");
    });
    await traceItem(ITEM, USER, STARTED);
    expect(row()).toMatchObject({ status: "failed", error: "Claude 接口限流了，过一会儿再试", result: result("上一次的"), usage: { claude_web_search: 5 } });
  });

  it("不是自己这一轮的不做：已经结束的、中途又重新开始的（开始时间对不上）、别人的", async () => {
    seed({ status: "ready" });
    await traceItem(ITEM, USER, STARTED);
    seed({ started_at: "2026-11-23T08:05:00.000Z" });
    await traceItem(ITEM, USER, STARTED);
    seed();
    await traceItem(ITEM, OTHER, STARTED);
    expect(traceSources).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "running", result: null });
  });

  it("开始时间只是写法不同（数据库读出来的带时区偏移）算同一轮", async () => {
    seed({ started_at: "2026-11-23T08:00:00+00:00" });
    await traceItem(ITEM, USER, "2026-11-23T08:00:00.000Z");
    expect(traceSources).toHaveBeenCalledTimes(1);
  });

  it("查的这会儿又点了一次重新溯源：这一轮的结果不写", async () => {
    vi.mocked(traceSources).mockImplementation(async () => {
      row().started_at = "2026-11-23T08:03:00.000Z";
      return result("晚到的");
    });
    await traceItem(ITEM, USER, STARTED);
    expect(row()).toMatchObject({ status: "running", result: null });
  });

  it("内容这会儿被删了就什么都不做", async () => {
    fake.store.items.length = 0;
    await traceItem(ITEM, USER, STARTED);
    expect(traceSources).not.toHaveBeenCalled();
  });
});
