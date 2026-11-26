import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import type { Session } from "@/lib/auth/user";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/collect-creator", () => ({ collectCreator: vi.fn(), saveCreatorPosts: vi.fn() }));
vi.mock("@/workflows/process-item", () => ({ processItem: vi.fn() }));
vi.mock("@/workflows/trace-item", () => ({ traceItem: vi.fn() }));

import { start } from "workflow/api";
import { collectCreator, saveCreatorPosts } from "@/workflows/collect-creator";
import { addCreator, cleanWant, costHint, getCreatorDetail, listMyCreators, removeCreator, resolveAccount, resumeCreator, stopCreator, syncCreator } from "./creator-service";
import { CREATOR_STUCK_MS, creatorBusy, creatorOfItem, creatorStuck, creatorTitle } from "./creator-store";
import { AccountLinkError, saveInput } from "./service";

const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const session = (id: string) => ({ user: { id }, db: fake.db }) as unknown as Session;
const now = () => new Date().toISOString();

const creatorRow = (over: Record<string, unknown> = {}) => ({ id: ID, user_id: ME, platform: "x", external_id: "karpathy", url: "https://x.com/karpathy", handle: "@karpathy", name: "Andrej Karpathy", bio: "", post_count: 10174, status: "ready", error: null, want: 20, notes: ["上一轮的话"], usage: {}, cost_usd: 0, started_at: "2026-11-26T08:00:00.000Z", synced_at: "2026-11-26T08:01:00.000Z", created_at: "2026-11-26T08:00:00.000Z", updated_at: now(), ...over });
const postRow = (n: number, status: string, itemId: string | null = null) => ({ id: `post-${n}`, user_id: ME, creator_id: ID, external_id: `10${n}`, url: `https://x.com/karpathy/status/10${n}`, kind: "text", title: `帖子 ${n}`, published_at: `2026-11-${String(n).padStart(2, "0")}T00:00:00.000Z`, pinned: false, status, item_id: itemId, created_at: "2026-11-26T08:00:00.000Z" });
const itemRow = (id: string, over: Record<string, unknown> = {}) => ({ id, user_id: ME, source: "link", platform: "x", status: "ready", media: [], tags: [], tags_locked: false, cost_usd: 0.1, started_at: "2026-11-26T08:00:00.000Z", created_at: "2026-11-26T08:00:00.000Z", ...over });

const creators = () => fake.store.creators;
const posts = () => fake.store.creator_posts;

beforeEach(() => {
  fake = makeFakeSupabase({ creators: [], creator_posts: [], items: [] }, { uuidIds: true });
  vi.mocked(start).mockReset().mockResolvedValue(undefined as never);
});

describe("认出贴进来的是哪个账号", () => {
  it("主页的链接、带着话的分享文案都认；帖子的链接、别的东西说清楚该贴什么", async () => {
    expect(await resolveAccount("  https://x.com/karpathy ")).toMatchObject({ platform: "x", externalId: "karpathy" });
    expect(await resolveAccount("来看看这个人 https://www.tiktok.com/@tedtoks 讲得很好")).toMatchObject({ platform: "tiktok", externalId: "tedtoks" });
    await expect(resolveAccount("https://x.com/karpathy/status/2106418403661779046")).rejects.toThrow(/这是一条帖子的链接，不是账号的主页/);
    await expect(resolveAccount("https://example.com/someone")).rejects.toThrow(/这是一条帖子的链接/);
    await expect(resolveAccount("没有链接")).rejects.toThrow(/没认出这是哪个账号的主页/);
    await expect(resolveAccount("")).rejects.toThrow(/没认出这是哪个账号的主页/);
  });

  it("要存多少条：1 到 1000 的整数", () => {
    expect(cleanWant("50")).toBe(50);
    expect(cleanWant(1000)).toBe(1000);
    for (const bad of ["", "abc", "0", "-3", "2.5", null, undefined, {}]) expect(() => cleanWant(bad), String(bad)).toThrow(/填一个 1 以上的整数/);
    expect(() => cleanWant(1001)).toThrow(/一次最多列 1000 条/);
  });

  it("在存一条内容的入口贴了主页：不存，带上认出来的账号（页面带去确认页，接口放进回包）", async () => {
    const err = await saveInput(session(ME), "https://x.com/karpathy").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountLinkError);
    expect((err as AccountLinkError).account).toEqual({ platform: "x", externalId: "karpathy", handle: "@karpathy", url: "https://x.com/karpathy" });
    expect(fake.store.items).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("addCreator / syncCreator", () => {
  it("加一个博主：建一行（正在列），后台任务拿着这一轮的开始时间开始", async () => {
    const saved = await addCreator(session(ME), "https://x.com/Karpathy", "50");
    expect(saved.existing).toBe(false);
    expect(creators()).toHaveLength(1);
    expect(creators()[0]).toMatchObject({ id: saved.id, user_id: ME, platform: "x", external_id: "karpathy", url: "https://x.com/Karpathy", handle: "@Karpathy", status: "listing", want: 50 });
    expect(vi.mocked(start).mock.calls).toEqual([[collectCreator, [saved.id, ME, creators()[0].started_at]]]);
  });

  it("后台任务起不来：标成失败并带上原因，不挂在「正在列」", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(start).mockRejectedValue(new Error("workflow runtime unavailable"));
    await addCreator(session(ME), "https://x.com/karpathy", 20);
    expect(creators()[0]).toMatchObject({ status: "failed", error: "后台任务没启动：workflow runtime unavailable" });
  });

  it("已经加过：没在跑就按这次的条数再同步一遍（清掉上一轮的话）；正在跑就不动", async () => {
    fake.store.creators.push(creatorRow());
    const again = await addCreator(session(ME), "https://x.com/karpathy", 100);
    expect(again).toEqual({ id: ID, existing: true });
    expect(creators()).toHaveLength(1);
    expect(creators()[0]).toMatchObject({ status: "listing", want: 100, notes: [], error: null });
    expect(creators()[0].started_at).not.toBe("2026-11-26T08:00:00.000Z");
    expect(vi.mocked(start).mock.calls).toEqual([[collectCreator, [ID, ME, creators()[0].started_at]]]);

    vi.mocked(start).mockClear();
    const startedAt = creators()[0].started_at;
    expect(await addCreator(session(ME), "https://x.com/karpathy", 300)).toEqual({ id: ID, existing: true });
    expect(creators()[0]).toMatchObject({ want: 100, started_at: startedAt });
    expect(start).not.toHaveBeenCalled();
  });

  it("两个人各加各的，互不相干", async () => {
    await addCreator(session(ME), "https://x.com/karpathy", 20);
    const theirs = await addCreator(session(OTHER), "https://x.com/karpathy", 20);
    expect(theirs.existing).toBe(false);
    expect(creators().map((c) => c.user_id)).toEqual([ME, OTHER]);
  });

  it("正在存的时候不能再同步；别人的、不存在的是 404", async () => {
    fake.store.creators.push(creatorRow({ status: "saving" }));
    await expect(syncCreator(session(ME), ID, 20)).rejects.toMatchObject({ status: 409 });
    await expect(syncCreator(session(OTHER), ID, 20)).rejects.toMatchObject({ status: 404 });
    await expect(syncCreator(session(ME), "not-a-uuid", 20)).rejects.toMatchObject({ status: 404 });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("停下 / 接着存 / 移除", () => {
  it("停：状态回到 ready，还排着队的搁下；已经存的不动", async () => {
    fake.store.creators.push(creatorRow({ status: "saving" }));
    fake.store.creator_posts.push(postRow(1, "saved", "item-1"), postRow(2, "pending"), postRow(3, "pending"));
    await stopCreator(session(ME), ID);
    expect(creators()[0].status).toBe("ready");
    expect(posts().map((p) => p.status)).toEqual(["saved", "held", "held"]);
    // 别人停不了我的
    creators()[0].status = "saving";
    await expect(stopCreator(session(OTHER), ID)).rejects.toMatchObject({ status: 404 });
    expect(creators()[0].status).toBe("saving");
  });

  it("接着存：搁着的重新排队，不重新列作品，直接开始存", async () => {
    fake.store.creators.push(creatorRow());
    fake.store.creator_posts.push(postRow(1, "saved", "item-1"), postRow(2, "held"), postRow(3, "held"));
    await resumeCreator(session(ME), ID);
    expect(posts().map((p) => p.status)).toEqual(["saved", "pending", "pending"]);
    expect(creators()[0]).toMatchObject({ status: "saving", notes: ["上一轮的话"] });
    expect(vi.mocked(start).mock.calls).toEqual([[saveCreatorPosts, [ID, ME, creators()[0].started_at]]]);
  });

  it("中断了的（进行中但很久没动静）可以接着存；真在跑的不行；没有可存的说清楚", async () => {
    const stale = new Date(Date.now() - CREATOR_STUCK_MS - 60_000).toISOString();
    fake.store.creators.push(creatorRow({ status: "saving", updated_at: stale }));
    fake.store.creator_posts.push(postRow(1, "pending"));
    expect(creatorStuck({ status: "saving", updatedAt: stale })).toBe(true);
    expect(creatorBusy({ status: "saving", updatedAt: stale })).toBe(false);
    await resumeCreator(session(ME), ID);
    expect(start).toHaveBeenCalledTimes(1);
    // 刚开始的这一轮在跑：再点是 409
    creators()[0].updated_at = now();
    await expect(resumeCreator(session(ME), ID)).rejects.toMatchObject({ status: 409 });
    creators()[0].status = "ready";
    posts()[0].status = "saved";
    await expect(resumeCreator(session(ME), ID)).rejects.toThrow(/清单里没有还没存的作品/);
  });

  it("移除：只删博主这一行，存进收藏库的内容留着；别人的删不了", async () => {
    fake.store.creators.push(creatorRow());
    fake.store.items.push(itemRow("item-1"));
    await expect(removeCreator(session(OTHER), ID)).rejects.toMatchObject({ status: 404 });
    expect(creators()).toHaveLength(1);
    await removeCreator(session(ME), ID);
    expect(creators()).toEqual([]);
    expect(fake.store.items).toHaveLength(1);
  });
});

describe("读", () => {
  it("列表带着清单里各种状态的条数；只有自己的", async () => {
    fake.store.creators.push(creatorRow(), creatorRow({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", user_id: OTHER }));
    fake.store.creator_posts.push(postRow(1, "saved", "item-1"), postRow(2, "pending"), postRow(3, "held"), postRow(4, "held"));
    const list = await listMyCreators(session(ME));
    expect(list.map((c) => [c.id, c.counts])).toEqual([[ID, { saved: 1, pending: 1, held: 2 }]]);
    expect(await listMyCreators(session(OTHER))).toHaveLength(1);
  });

  it("一个博主的页面：整份清单（从新到旧）、已存的内容、存过又删掉的条数；别人的是 404", async () => {
    fake.store.creators.push(creatorRow());
    fake.store.creator_posts.push(postRow(1, "saved", "item-1"), postRow(2, "saved", null), postRow(3, "held"), postRow(4, "saved", "item-4"));
    fake.store.items.push(itemRow("item-1", { title: "旧的" }), itemRow("item-4", { title: "新的" }), itemRow("item-x", { title: "不相干的" }));
    const detail = await getCreatorDetail(session(ME), ID);
    expect(detail.posts.map((p) => p.externalId)).toEqual(["104", "103", "102", "101"]);
    expect(detail.items.map((i) => i.title)).toEqual(["新的", "旧的"]);
    expect(detail).toMatchObject({ counts: { saved: 3, pending: 0, held: 1 }, removed: 1, page: 1, pages: 1 });
    await expect(getCreatorDetail(session(OTHER), ID)).rejects.toMatchObject({ status: 404 });
  });

  it("一条内容是从哪个博主那里存进来的", async () => {
    fake.store.creators.push(creatorRow());
    fake.store.creator_posts.push(postRow(1, "saved", "item-1"));
    expect((await creatorOfItem(fake.db, ME, "item-1"))?.id).toBe(ID);
    expect(await creatorOfItem(fake.db, ME, "item-2")).toBeNull();
    expect(await creatorOfItem(fake.db, OTHER, "item-1")).toBeNull();
  });

  it("花费的参考：这个平台上自己处理好的内容平均每条多少；没存过是 null", async () => {
    fake.store.items.push(itemRow("a", { cost_usd: 0.1 }), itemRow("b", { cost_usd: 0.3 }), itemRow("c", { cost_usd: 9, platform: "douyin" }), itemRow("d", { cost_usd: 9, status: "failed" }), itemRow("e", { cost_usd: 9, user_id: OTHER }));
    expect(await costHint(session(ME), "x")).toEqual({ avgUsd: 0.2, n: 2 });
    expect(await costHint(session(ME), "tiktok")).toBeNull();
  });

  it("页面上叫他什么：名字 → @用户名 → 平台", () => {
    expect(creatorTitle({ name: "木木英语", handle: "抖音号 1", platform: "douyin" })).toBe("木木英语");
    expect(creatorTitle({ name: "", handle: "@tedtoks", platform: "tiktok" })).toBe("@tedtoks");
    expect(creatorTitle({ name: "", handle: "", platform: "douyin" })).toBe("抖音博主");
  });
});
