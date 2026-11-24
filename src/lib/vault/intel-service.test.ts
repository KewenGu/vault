import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/user";
import type { Candidate, Listing } from "@/lib/intel/candidate";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("./service", () => ({ saveInput: vi.fn() }));

import { VaultError } from "./errors";
import { DUE_BATCH, WATCH_MAX, addWatch, checkAllWatches, checkDueWatches, checkWatch, editWatch, intelEveryMinutes, listMySignals, listMyWatches, markSignal, removeWatch, runCheck, saveSignal, type IntelDeps } from "./intel-service";
import { intelTick } from "./intel-timer";
import { saveInput } from "./service";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ITEM = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const NOW = new Date("2026-11-24T12:00:00Z");

const session = (user = USER) => ({ user: { id: user }, db: fake.db }) as unknown as Session;
const rows = (table: string) => fake.store[table] ?? [];

const post = (id: string, score: number | null, patch: Partial<Candidate> = {}): Candidate => ({
  source: "reddit",
  externalId: id,
  url: `https://www.reddit.com/comments/${id}`,
  discussionUrl: null,
  title: `帖子 ${id}`,
  excerpt: "",
  author: "u/someone",
  channel: "r/LocalLLaMA",
  score,
  comments: 3,
  publishedAt: "2026-11-24T08:00:00.000Z",
  ...patch,
});
const story = (id: string, score: number, patch: Partial<Candidate> = {}): Candidate => post(id, score, { source: "hackernews", url: `https://example.com/${id}`, discussionUrl: `https://news.ycombinator.com/item?id=${id}`, channel: "Hacker News", title: `故事 ${id}`, ...patch });

let reddit: Listing;
let hn: Listing;
let deps: IntelDeps & { listSubreddit: ReturnType<typeof vi.fn>; searchHn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  fake = makeFakeSupabase({ intel_watches: [], intel_signals: [] }, { uuidIds: true, uniqueKeys: { intel_watches: ["query"] } });
  reddit = { candidates: [], notes: [] };
  hn = { candidates: [], notes: [] };
  deps = { listSubreddit: vi.fn(async () => reddit), searchHn: vi.fn(async () => hn), now: () => NOW };
  vi.mocked(saveInput).mockReset().mockResolvedValue({ id: ITEM, existing: false });
});

describe("情报：盯着的来源", () => {
  it("加一个版块：名字收成版块名，默认 50 分的线，加完马上去看一次（看最近 3 天）", async () => {
    reddit = { candidates: [post("aaaa1", 120), post("aaaa2", 49), post("aaaa3", null)], notes: [] };
    const { watch, check } = await addWatch(session(), { kind: "subreddit", query: " https://www.reddit.com/r/LocalLLaMA/ " }, deps);
    expect(watch).toMatchObject({ kind: "subreddit", query: "LocalLLaMA", minScore: 50, keywords: "", enabled: true });
    expect(deps.listSubreddit).toHaveBeenCalledWith("LocalLLaMA", new Date("2026-11-21T12:00:00Z"));
    // 没过线的、没有分数的不要
    expect(check).toEqual({ found: 1, fresh: 1, notes: [], error: null });
    expect(rows("intel_signals")).toHaveLength(1);
    expect(rows("intel_signals")[0]).toMatchObject({ user_id: USER, watch_id: watch.id, source: "reddit", external_id: "aaaa1", status: "new", score: 120, url: "https://www.reddit.com/comments/aaaa1" });
    expect(rows("intel_watches")[0]).toMatchObject({ user_id: USER, last_checked_at: NOW.toISOString(), last_error: null });
  });

  it("加一组 HN 关键词：默认 30 分的线，分数线交给搜索接口（看最近 7 天）", async () => {
    hn = { candidates: [story("501", 44)], notes: [] };
    const { watch, check } = await addWatch(session(), { kind: "hn", query: '  "AI agent"   MCP ', minScore: "20", keywords: "不该留" }, deps);
    expect(watch).toMatchObject({ kind: "hn", query: '"AI agent" MCP', minScore: 20, keywords: "" });
    expect(deps.searchHn).toHaveBeenCalledWith('"AI agent" MCP', 20, new Date("2026-11-17T12:00:00Z"));
    expect(check.fresh).toBe(1);
    expect(rows("intel_signals")[0]).toMatchObject({ source: "hackernews", url: "https://example.com/501", discussion_url: "https://news.ycombinator.com/item?id=501" });
  });

  it("写得不对的、已经有的、太多的：说清楚，不加", async () => {
    await expect(addWatch(session(), { kind: "rss", query: "x" }, deps)).rejects.toThrow("选一种来源");
    await expect(addWatch(session(), { kind: "subreddit", query: "两个 词" }, deps)).rejects.toThrow("没认出版块名");
    await expect(addWatch(session(), { kind: "hn", query: "   " }, deps)).rejects.toThrow("写一个或几个关键词");
    await expect(addWatch(session(), { kind: "hn", query: "词".repeat(101) }, deps)).rejects.toThrow("关键词太长");
    expect(rows("intel_watches")).toHaveLength(0);

    await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    const again = addWatch(session(), { kind: "subreddit", query: "r/LocalLLaMA" }, deps);
    await expect(again).rejects.toThrow("已经在盯 r/LocalLLaMA 了");
    await expect(again).rejects.toMatchObject({ status: 409 });

    fake.store.intel_watches.push(...Array.from({ length: WATCH_MAX }, (_, i) => ({ id: `w${i}`, user_id: USER, kind: "hn", query: `q${i}` })));
    await expect(addWatch(session(), { kind: "hn", query: "one more" }, deps)).rejects.toThrow(`最多盯 ${WATCH_MAX} 个来源`);
  });

  it("版块里按关键词再筛；分数线设成 0 时没有分数的也不要", async () => {
    reddit = { candidates: [post("bbbb1", 90, { title: "Building agents with MCP" }), post("bbbb2", 90, { title: "My new GPU rig" }), post("bbbb3", null, { title: "agent question" })], notes: [] };
    const { check } = await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA", minScore: 0, keywords: " agent   rag " }, deps);
    expect(check.found).toBe(1);
    expect(rows("intel_signals").map((r) => r.external_id)).toEqual(["bbbb1"]);
    expect(rows("intel_watches")[0].keywords).toBe("agent rag");
  });

  it("改、停、删只碰得到自己的；删掉不存在的不报错", async () => {
    const { watch } = await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    await editWatch(session(), watch.id, { minScore: 200, keywords: "agent", enabled: false });
    expect(rows("intel_watches")[0]).toMatchObject({ min_score: 200, keywords: "agent", enabled: false });
    await editWatch(session(), watch.id, { minScore: -5 });
    expect(rows("intel_watches")[0].min_score).toBe(0);

    await expect(editWatch(session(OTHER), watch.id, { enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(checkWatch(session(OTHER), watch.id, deps)).rejects.toThrow("这个来源不在了");
    await removeWatch(session(OTHER), watch.id);
    expect(rows("intel_watches")).toHaveLength(1);
    expect(await listMyWatches(session(OTHER))).toEqual([]);
    await expect(removeWatch(session(), "不是 id")).rejects.toBeInstanceOf(VaultError);
    await removeWatch(session(), watch.id);
    expect(rows("intel_watches")).toHaveLength(0);
  });
});

describe("情报：去看一次", () => {
  it("见过的只更新数字，状态不动：忽略过的不会因为分数涨了又冒出来", async () => {
    reddit = { candidates: [post("cccc1", 60), post("cccc2", 70)], notes: [] };
    const { watch } = await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    const [first] = (await listMySignals(session())).signals.filter((s) => s.externalId === "cccc1");
    await markSignal(session(), first.id, "dismissed");

    reddit = { candidates: [post("cccc1", 900, { title: "改过的标题", comments: 50 }), post("cccc2", 71), post("cccc3", 55)], notes: [] };
    expect(await checkWatch(session(), watch.id, deps)).toEqual({ found: 3, fresh: 1, notes: [], error: null });
    const byId = Object.fromEntries(rows("intel_signals").map((r) => [r.external_id, r]));
    expect(byId.cccc1).toMatchObject({ status: "dismissed", score: 900, comments: 50, title: "改过的标题" });
    expect(byId.cccc2).toMatchObject({ status: "new", score: 71 });
    expect(byId.cccc3).toMatchObject({ status: "new" });
    expect(rows("intel_signals")).toHaveLength(3);
  });

  it("两个来源碰到同一条：只有一行，算先碰到的那个的", async () => {
    hn = { candidates: [story("777", 100)], notes: [] };
    const a = await addWatch(session(), { kind: "hn", query: "agent" }, deps);
    const b = await addWatch(session(), { kind: "hn", query: "MCP" }, deps);
    expect(b.check).toMatchObject({ found: 1, fresh: 0 });
    expect(rows("intel_signals")).toHaveLength(1);
    expect(rows("intel_signals")[0].watch_id).toBe(a.watch.id);
  });

  it("另一个人盯同一个版块：各记各的，互相看不到", async () => {
    reddit = { candidates: [post("dddd1", 60)], notes: [] };
    await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    fake.store.intel_watches.push({ id: "99999999-9999-4999-8999-999999999999", user_id: OTHER, kind: "subreddit", query: "localllama", keywords: "", min_score: 50, enabled: true, last_notes: [] });
    await checkWatch(session(OTHER), "99999999-9999-4999-8999-999999999999", deps);
    expect(rows("intel_signals").map((r) => r.user_id).sort()).toEqual([USER, OTHER].sort());
    expect((await listMySignals(session())).signals).toHaveLength(1);
    expect((await listMySignals(session(OTHER))).counts).toEqual({ new: 1, saved: 0, dismissed: 0 });
  });

  it("没看到的记在来源上；下次看到了就清掉", async () => {
    reddit = { candidates: [], notes: ["r/Busy 帖子太多：只看了最近 10 小时的（600 条），再往前的没看"] };
    const { watch, check } = await addWatch(session(), { kind: "subreddit", query: "Busy" }, deps);
    expect(check.notes).toHaveLength(1);
    expect((await listMyWatches(session()))[0].lastNotes).toEqual(reddit.notes);
    reddit = { candidates: [], notes: [] };
    await checkWatch(session(), watch.id, deps);
    expect((await listMyWatches(session()))[0].lastNotes).toEqual([]);
  });

  it("来源读不到：不抛错，原因记在来源上，已经发现的不动；下次读到了原因清掉", async () => {
    reddit = { candidates: [post("eeee1", 60)], notes: [] };
    const { watch } = await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    deps.listSubreddit.mockRejectedValueOnce(new Error("Reddit 存档(arctic-shift.photon-reddit.com) 请求超时"));
    expect(await checkWatch(session(), watch.id, deps)).toEqual({ found: 0, fresh: 0, notes: [], error: "Reddit 存档(arctic-shift.photon-reddit.com) 请求超时" });
    expect((await listMyWatches(session()))[0]).toMatchObject({ lastError: "Reddit 存档(arctic-shift.photon-reddit.com) 请求超时", lastCheckedAt: NOW.toISOString() });
    expect(rows("intel_signals")).toHaveLength(1);
    await checkWatch(session(), watch.id, deps);
    expect((await listMyWatches(session()))[0].lastError).toBeNull();
  });

  it("没存、放了 30 天的清掉（新的没人看、不要的）；存进收藏库的留着；别人的不碰", async () => {
    const { watch } = await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    const old = "2026-10-20T00:00:00.000Z";
    const recent = "2026-11-20T00:00:00.000Z";
    const sig = (external_id: string, status: string, found_at: string, user_id = USER) => ({ id: crypto.randomUUID(), user_id, watch_id: watch.id, source: "reddit", external_id, url: "https://www.reddit.com/comments/x", title: external_id, status, found_at });
    fake.store.intel_signals.push(sig("old-new", "new", old), sig("old-dismissed", "dismissed", old), sig("old-saved", "saved", old), sig("recent-new", "new", recent), sig("theirs", "new", old, OTHER));
    await checkWatch(session(), watch.id, deps);
    expect(rows("intel_signals").map((r) => r.external_id).sort()).toEqual(["old-saved", "recent-new", "theirs"]);
  });

  it("都看一遍：只看开着的，一个读不到不耽误别的", async () => {
    reddit = { candidates: [post("ffff1", 60)], notes: [] };
    hn = { candidates: [story("901", 60)], notes: [] };
    await addWatch(session(), { kind: "subreddit", query: "LocalLLaMA" }, deps);
    await addWatch(session(), { kind: "hn", query: "agent" }, deps);
    const { watch: off } = await addWatch(session(), { kind: "hn", query: "paused" }, deps);
    await editWatch(session(), off.id, { enabled: false });
    deps.listSubreddit.mockClear().mockRejectedValueOnce(new Error("boom"));
    deps.searchHn.mockClear();
    hn = { candidates: [story("901", 60), story("902", 61)], notes: [] };
    expect(await checkAllWatches(session(), deps)).toEqual({ checked: 2, fresh: 1, failed: 1 });
    expect(deps.searchHn).toHaveBeenCalledTimes(1);
  });
});

describe("情报：发现的内容", () => {
  const seed = async () => {
    hn = { candidates: [story("601", 100, { publishedAt: "2026-11-23T00:00:00.000Z" }), story("602", 100, { publishedAt: "2026-11-24T00:00:00.000Z" })], notes: [] };
    await addWatch(session(), { kind: "hn", query: "agent" }, deps);
    return (await listMySignals(session())).signals;
  };

  it("列出来：默认看新的，发布时间新的在前，带每一类各有多少", async () => {
    const signals = await seed();
    expect(signals.map((s) => s.externalId)).toEqual(["602", "601"]);
    await markSignal(session(), signals[0].id, "dismissed");
    const page = await listMySignals(session(), "不认识的状态");
    expect(page.signals.map((s) => s.externalId)).toEqual(["601"]);
    expect(page.counts).toEqual({ new: 1, saved: 0, dismissed: 1 });
    expect((await listMySignals(session(), "dismissed")).signals.map((s) => s.externalId)).toEqual(["602"]);
  });

  it("不要 / 放回去；别的状态不认；碰不到别人的", async () => {
    const [s] = await seed();
    await markSignal(session(), s.id, "dismissed");
    await markSignal(session(), s.id, "new");
    expect(rows("intel_signals").find((r) => r.id === s.id)?.status).toBe("new");
    await expect(markSignal(session(), s.id, "saved")).rejects.toThrow("只能标成");
    await expect(markSignal(session(OTHER), s.id, "dismissed")).rejects.toMatchObject({ status: 404 });
    await expect(saveSignal(session(OTHER), s.id)).rejects.toThrow("这一条不在了");
    expect(saveInput).not.toHaveBeenCalled();
  });

  it("存入：和自己贴它的链接一样，那一条记成存了的、指着存下的内容；再点一次不重复存", async () => {
    const [s] = await seed();
    expect(await saveSignal(session(), s.id)).toEqual({ itemId: ITEM, existing: false });
    expect(vi.mocked(saveInput).mock.calls[0][1]).toBe("https://example.com/602");
    expect(rows("intel_signals").find((r) => r.id === s.id)).toMatchObject({ status: "saved", item_id: ITEM });
    expect(await saveSignal(session(), s.id)).toEqual({ itemId: ITEM, existing: true });
    expect(saveInput).toHaveBeenCalledTimes(1);
    // 存了的不能在这里标成不要
    await expect(markSignal(session(), s.id, "dismissed")).rejects.toThrow("已经存进收藏库了");
  });

  it("存入没成（链接认不出、读取没启动）：那一条还是新的，错原样报给用户", async () => {
    const [s] = await seed();
    vi.mocked(saveInput).mockRejectedValueOnce(new VaultError("没认出这是哪个帖子"));
    await expect(saveSignal(session(), s.id)).rejects.toThrow("没认出这是哪个帖子");
    expect(rows("intel_signals").find((r) => r.id === s.id)).toMatchObject({ status: "new" });
  });
});

describe("情报：后台定时去看", () => {
  const watchRow = (id: string, user_id: string, last_checked_at: string | null, patch: Record<string, unknown> = {}) => ({ id, user_id, kind: "hn", query: id, keywords: "", min_score: 30, enabled: true, last_notes: [], last_checked_at, ...patch });

  it("多久看一次：默认 60 分钟，最少 15，0 或写错了是不自动看", () => {
    expect(intelEveryMinutes({})).toBe(60);
    expect(intelEveryMinutes({ VAULT_INTEL_EVERY_MIN: "180" })).toBe(180);
    expect(intelEveryMinutes({ VAULT_INTEL_EVERY_MIN: "5" })).toBe(15);
    expect(intelEveryMinutes({ VAULT_INTEL_EVERY_MIN: "0" })).toBe(0);
    expect(intelEveryMinutes({ VAULT_INTEL_EVERY_MIN: "abc" })).toBe(0);
  });

  it("只看到时间的（没看过的、上次看早于一个间隔的）和开着的；每个来源记在它自己的人名下", async () => {
    fake.store.intel_watches.push(
      watchRow("never", USER, null),
      watchRow("stale", OTHER, "2026-11-24T10:30:00.000Z"),
      watchRow("fresh", USER, "2026-11-24T11:30:00.000Z"),
      watchRow("paused", USER, null, { enabled: false })
    );
    deps.searchHn.mockImplementation(async (q: string) => ({ candidates: [story(`s-${q}`, 50)], notes: [] }));
    expect(await checkDueWatches({ db: fake.db, deps, everyMinutes: 60 })).toEqual({ checked: 2, fresh: 2, failed: 0 });
    expect(deps.searchHn.mock.calls.map((c) => c[0]).sort()).toEqual(["never", "stale"]);
    const owner = Object.fromEntries(rows("intel_signals").map((r) => [r.external_id, r.user_id]));
    expect(owner).toEqual({ "s-never": USER, "s-stale": OTHER });
    // 刚看过的这一轮不再看
    deps.searchHn.mockClear();
    expect((await checkDueWatches({ db: fake.db, deps, everyMinutes: 60 })).checked).toBe(0);
  });

  it("一轮有上限；关掉了（0）就什么都不做", async () => {
    fake.store.intel_watches.push(...Array.from({ length: DUE_BATCH + 4 }, (_, i) => watchRow(`w${i}`, USER, null)));
    expect((await checkDueWatches({ db: fake.db, deps, everyMinutes: 60 })).checked).toBe(DUE_BATCH);
    deps.searchHn.mockClear();
    expect(await checkDueWatches({ db: fake.db, deps, everyMinutes: 0 })).toEqual({ checked: 0, fresh: 0, failed: 0 });
    expect(deps.searchHn).not.toHaveBeenCalled();
  });

  it("数据库那头出错：记成没看成，接着看下一个", async () => {
    fake.store.intel_watches.push(watchRow("a", USER, null), watchRow("b", USER, null));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = makeFakeSupabase({ intel_watches: rows("intel_watches"), intel_signals: [] }, { failUpdate: { intel_watches: { message: "connection reset" } } });
    expect(await checkDueWatches({ db: failing.db, deps, everyMinutes: 60 })).toEqual({ checked: 2, fresh: 0, failed: 2 });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("定时器的一轮：上一轮没完不叠上去；同一个错只说一次", async () => {
    let release = () => {};
    const slow = vi.fn(() => new Promise<{ checked: number; fresh: number; failed: number }>((r) => (release = () => r({ checked: 0, fresh: 0, failed: 0 }))));
    const first = intelTick(slow);
    await intelTick(slow);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = vi.fn(async () => Promise.reject(new Error("supabaseUrl is required.")));
    await intelTick(broken);
    await intelTick(broken);
    expect(broken).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("runCheck 用的是来源自己的 user_id，不是调用的人的", async () => {
    fake.store.intel_watches.push(watchRow("x", OTHER, null));
    hn = { candidates: [story("1", 99)], notes: [] };
    const watch = { id: "x", userId: OTHER, kind: "hn" as const, query: "x", keywords: "", minScore: 30, enabled: true, lastCheckedAt: null, lastError: null, lastNotes: [], createdAt: "" };
    await runCheck(fake.db, watch, deps);
    expect(rows("intel_signals")[0].user_id).toBe(OTHER);
  });
});
