import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { listAccountStep, type ListState, type ListStep } from "./account-list";
import type { AccountRef } from "./link";
import { SourceFetchError } from "./types";

// 走全局 fetch（测试里换成假的）；DNS / 连接那一层在 network/public-fetch.test.ts 里测
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/network/public-fetch")>()),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  // 时间线读不动时每次重试之间的等待：测试里不真等
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** 一步步列到完（等待的时间直接跳过）。 */
async function listAll(ref: AccountRef, want: number, max = 50): Promise<{ steps: ListStep[]; counts: Record<string, number> }> {
  const steps: ListStep[] = [];
  const counts: Record<string, number> = {};
  let state: ListState | null = null;
  for (let i = 0; i < max; i++) {
    const run = meterInto(counts, () => listAccountStep(ref, want, state));
    // 让别人先看到失败（否则快进计时器的时候它是个没人接的 rejection）
    run.catch(() => {});
    await vi.runAllTimersAsync();
    const step = await run;
    steps.push(step);
    if (step.done) break;
    state = step.state;
  }
  return { steps, counts };
}

describe("列一个 X 账号的帖子", () => {
  const ref: AccountRef = { platform: "x", externalId: "karpathy", handle: "@karpathy", url: "https://x.com/karpathy" };
  const own = (id: number) => ({ id: String(id), text: `帖子 ${id}`, author: { screen_name: "karpathy" }, created_timestamp: 1795000000 - id * 86400, replying_to: null, reposted_by: null, media: {} });
  const repost = (id: number) => ({ ...own(id), author: { screen_name: "other" }, reposted_by: { screen_name: "karpathy" } });
  const selfReply = (id: number) => ({ ...own(id), replying_to: { screen_name: "karpathy" } });
  const profile = json({ code: 200, user: { screen_name: "karpathy", name: "Andrej Karpathy", description: "", statuses: 10174 } });

  /** 三页：每页两条自己的、一条转发、一条接在自己后面的 */
  function timeline(pages: number) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.endsWith("/profile/karpathy")) return profile.clone();
      const at = Number(new URL(url).searchParams.get("cursor") ?? 0);
      const base = 10000 + at * 10;
      return json({ code: 200, results: [own(base + 1), repost(base + 2), own(base + 3), selfReply(base + 4)], cursor: { bottom: at + 1 < pages ? String(at + 1) : null } });
    });
    return urls;
  }

  it("一页一步往回翻，够数就停；没要的（转发、接在自己后面的）记下来", async () => {
    const urls = timeline(10);
    const { steps, counts } = await listAll(ref, 5);
    expect(steps.map((s) => s.posts.map((p) => p.externalId))).toEqual([["10001", "10003"], ["10011", "10013"], ["10021"]]);
    expect(steps[0].info).toEqual({ name: "Andrej Karpathy", handle: "@karpathy", bio: "", postCount: 10174 });
    expect(steps[1].info).toBeNull();
    expect(steps.map((s) => s.done)).toEqual([false, false, true]);
    expect(steps[2].notes).toEqual(["他转发别人的 3 条没存（只存他自己发的）", "他接在自己帖子后面发的 3 条不单独存：读那一串的第一条时一起读进来"]);
    expect(urls).toEqual([
      "https://api.fxtwitter.com/2/profile/karpathy",
      "https://api.fxtwitter.com/2/profile/karpathy/statuses",
      "https://api.fxtwitter.com/2/profile/karpathy/statuses?cursor=1",
      "https://api.fxtwitter.com/2/profile/karpathy/statuses?cursor=2",
    ]);
    // X 这条路不花钱
    expect(counts).toEqual({});
  });

  it("时间线到头了还不够数：说清楚列到哪天、一共几条", async () => {
    timeline(2);
    const { steps } = await listAll(ref, 50);
    expect(steps.flatMap((s) => s.posts)).toHaveLength(4);
    expect(steps.at(-1)?.done).toBe(true);
    expect(steps.at(-1)?.notes[0]).toMatch(/^时间线到 \d{4}-\d{2}-\d{2} 就没有了，一共列出 4 条/);
  });

  it("翻到一半读不动了：已经列出来的留着，记一句更早的没列出来", async () => {
    let page = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/profile/karpathy")) return profile.clone();
      return page++ === 0 ? json({ code: 200, results: [own(10001), own(10002)], cursor: { bottom: "1" } }) : json({ code: 404, results: [] }, 404);
    });
    const { steps } = await listAll(ref, 50);
    expect(steps.map((s) => s.posts.length)).toEqual([2, 0]);
    expect(steps[1].done).toBe(true);
    expect(steps[1].notes[0]).toMatch(/^列到第 2 条（\d{4}-\d{2}-\d{2}）之后读不动了，更早的没列出来：X 的时间线读不动/);
  });

  it("第一页就读不动：这一轮算失败（抛出去）；账号不存在抛 SourceFetchError", async () => {
    vi.stubGlobal("fetch", async (url: string) => (url.endsWith("/profile/karpathy") ? profile.clone() : json({ code: 404, results: [] }, 404)));
    await expect(listAll(ref, 5)).rejects.toThrow(/时间线读不动/);
    vi.stubGlobal("fetch", async () => json({ code: 404, message: "User not found" }, 404));
    await expect(listAll(ref, 5)).rejects.toThrow(SourceFetchError);
  });
});

describe("列一个 TikTok / 抖音账号的作品（Apify）", () => {
  const ref: AccountRef = { platform: "tiktok", externalId: "tedtoks", handle: "@tedtoks", url: "https://www.tiktok.com/@tedtoks" };
  const video = (n: number, over: Record<string, unknown> = {}) => ({ id: `770000000000000000${n}`, text: `视频 ${n}`, createTime: 1795000000 + n * 3600, authorMeta: { name: "tedtoks", nickName: "TED Talks", signature: "", video: 1206 }, ...over });

  type Call = { method: string; url: string; body: unknown; auth: string | null };
  /** 假的 Apify：开始运行 → 问 statuses 里的状态（一次一个）→ 取结果。 */
  function apify(statuses: string[], items: unknown[]) {
    const calls: Call[] = [];
    let poll = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") });
      const run = (status: string) => json({ data: { id: "RUN1", defaultDatasetId: "DS1", status, statusMessage: status === "FAILED" ? "blocked by TikTok" : "" } });
      if (url.includes("/acts/") && url.includes("/runs")) return run("READY");
      if (url.endsWith("/abort")) return run("ABORTING");
      if (url.includes("/actor-runs/RUN1")) return run(statuses[Math.min(poll++, statuses.length - 1)]);
      if (url.includes("/datasets/DS1/items")) return json(items);
      return json({ error: "unexpected" }, 500);
    });
    return calls;
  }

  it("没配 APIFY_TOKEN：说清楚要配什么", async () => {
    await expect(listAll(ref, 5)).rejects.toThrow("列 TikTok 账号的作品要用 Apify（环境变量 APIFY_TOKEN 没配）");
  });

  it("开始运行 → 等它跑完 → 取结果：从新到旧，只要最近的 N 条；按列出来的条数记账", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    const calls = apify(["RUNNING", "RUNNING", "SUCCEEDED"], [video(1, { isPinned: true }), video(5), video(4), video(3), video(2)]);
    const { steps, counts } = await listAll(ref, 3);
    expect(steps.map((s) => [s.done, s.waitS])).toEqual([[false, 8], [false, 10], [false, 10], [true, 0]]);
    expect(steps[3].posts.map((p) => p.title)).toEqual(["视频 5", "视频 4", "视频 3"]);
    expect(steps[3].info).toMatchObject({ name: "TED Talks", postCount: 1206 });
    expect(steps[3].notes).toEqual([]);
    expect(counts).toEqual({ apify_tiktok_profile_post: 5 });
    // 令牌在请求头里，不在地址里；这次运行设了收费上限
    expect(calls[0]).toMatchObject({ method: "POST", auth: "Bearer apify_secret_1", body: { profiles: ["tedtoks"], resultsPerPage: 3 } });
    expect(calls[0].url).toBe("https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/runs?timeout=900&maxTotalChargeUsd=0.11");
    expect(calls.every((c) => !c.url.includes("apify_secret_1"))).toBe(true);
    expect(calls.at(-1)?.url).toBe("https://api.apify.com/v2/datasets/DS1/items?clean=true&offset=0&limit=53");
  });

  it("actor 可以用环境变量换", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    vi.stubEnv("APIFY_DOUYIN_PROFILE_ACTOR", "someone~other-actor");
    const calls = apify(["SUCCEEDED"], [{ id: "7534316807973260587", type: "video", title: "一条", createTime: 1754266200, authorMeta: { name: "木木英语", awemeCount: 212 } }]);
    const douyin: AccountRef = { platform: "douyin", externalId: "MS4wLjABAAAAk1tZ", handle: "", url: "https://www.douyin.com/user/MS4wLjABAAAAk1tZ" };
    const { steps, counts } = await listAll(douyin, 20);
    expect(calls[0].url).toContain("/acts/someone~other-actor/runs");
    expect(calls[0].body).toEqual({ profileUrls: [douyin.url], maxPostsPerProfile: 20 });
    expect(steps.at(-1)?.posts.map((p) => p.url)).toEqual(["https://www.douyin.com/video/7534316807973260587"]);
    // 平台说有 212 个、只列出 1 个：记下来
    expect(steps.at(-1)?.notes).toEqual(["抖音说这个账号一共 212 个作品，这次只列出 1 个：剩下的可能是私密的、被平台藏起来的，或者 actor 没翻到"]);
    expect(counts).toEqual({ apify_douyin_profile_post: 1 });
  });

  it("运行没跑成：已经列出来的照样用、记一句；一条都没有就是失败", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    apify(["FAILED"], [video(1), video(2)]);
    const partial = await listAll(ref, 5);
    expect(partial.steps.at(-1)?.posts).toHaveLength(2);
    expect(partial.steps.at(-1)?.notes[0]).toBe("列作品的那次运行没跑完（FAILED：blocked by TikTok）：只拿到它已经列出来的");
    apify(["FAILED"], []);
    await expect(listAll(ref, 5)).rejects.toThrow("列作品的那次运行没跑完（FAILED：blocked by TikTok），一条都没列出来");
  });

  it("跑完了但什么都没有：没有账号信息 = 账号读不到；有账号信息 = 他没有公开的作品", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    apify(["SUCCEEDED"], []);
    await expect(listAll(ref, 5)).rejects.toThrow(/没读到这个 TikTok 账号：可能不存在、设成了私密/);
    apify(["SUCCEEDED"], [{ authorMeta: { name: "tedtoks", nickName: "TED Talks", video: 0 } }]);
    const { steps } = await listAll(ref, 5);
    expect(steps.at(-1)).toMatchObject({ done: true, posts: [], notes: ["这个账号没有公开的作品"] });
  });

  it("等了 15 分钟还没跑完：让它停下，拿已经列出来的", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    const calls = apify(["RUNNING"], [video(1)]);
    const { steps } = await listAll(ref, 5, 200);
    expect(steps.at(-1)?.done).toBe(true);
    expect(steps.at(-1)?.notes[0]).toBe("列作品等了 15 分钟还没跑完，停下了：只拿到它已经列出来的");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/actor-runs/RUN1/abort"))).toBe(true);
  });
});
