import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchXProfile, fetchXThreadIds, fetchXTimelinePage, pickOwnPosts, readXThreadIds, readXTimeline } from "./account-x";
import { SourceFetchError } from "./types";

// 走全局 fetch（测试里换成假的）；DNS / 连接那一层在 network/public-fetch.test.ts 里测
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/network/public-fetch")>()),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noPause = async () => {};
afterEach(() => vi.unstubAllGlobals());

/** 时间线接口里的一条（FxTwitter v2 的形状，只留用得到的字段）。 */
const status = (id: string, over: Record<string, unknown> = {}) => ({
  type: "status",
  id,
  text: `第 ${id} 条\n第二行`,
  author: { screen_name: "Karpathy", name: "Andrej Karpathy" },
  created_timestamp: 1795660000,
  replying_to: null,
  reposted_by: null,
  media: {},
  ...over,
});

describe("X：一个账号的时间线", () => {
  const page = {
    code: 200,
    results: [
      status("10001", { media: { videos: [{ url: "https://video.twimg.com/a.mp4" }] } }),
      status("10002", { author: { screen_name: "someone_else" }, reposted_by: { screen_name: "karpathy" } }),
      status("10003", { replying_to: { screen_name: "karpathy", status: "10001" } }),
      status("10004", { replying_to: { screen_name: "another" } }),
      status("10005", { text: "#AI https://t.co/x 只有话题和链接\n真正的第一行", media: { photos: [{ url: "https://pbs.twimg.com/a.jpg" }] }, created_timestamp: null }),
      { id: "不是帖子" },
    ],
    cursor: { top: "T", bottom: "B" },
  };

  it("读出每一条：谁发的、是不是转发、回的是谁、有没有视频 / 图，和翻下一页的游标", () => {
    const { entries, cursor } = readXTimeline(page);
    expect(cursor).toBe("B");
    expect(entries.map((e) => [e.id, e.author, e.repost, e.replyTo, e.kind])).toEqual([
      ["10001", "karpathy", false, null, "video"],
      ["10002", "someone_else", true, null, "text"],
      ["10003", "karpathy", false, "karpathy", "text"],
      ["10004", "karpathy", false, "another", "text"],
      ["10005", "karpathy", false, null, "image"],
    ]);
    expect(entries[0].publishedAt).toBe("2026-11-26T02:26:40.000Z");
    expect(entries[4].publishedAt).toBeNull();
    // 没有下一页、不是这个形状的回包
    expect(readXTimeline({ code: 404, results: [], cursor: { top: null, bottom: null } })).toEqual({ entries: [], cursor: null });
    expect(readXTimeline(null)).toEqual({ entries: [], cursor: null });
  });

  it("只留他自己发的：转发别人的、接在自己帖子后面的、回别人的各数一数，不进清单", () => {
    const picked = pickOwnPosts(readXTimeline(page).entries, "karpathy");
    expect(picked.posts).toEqual([
      { externalId: "10001", url: "https://x.com/karpathy/status/10001", kind: "video", title: "第 10001 条", publishedAt: "2026-11-26T02:26:40.000Z", pinned: false },
      { externalId: "10005", url: "https://x.com/karpathy/status/10005", kind: "image", title: "只有话题和链接", publishedAt: null, pinned: false },
    ]);
    expect([picked.reposts, picked.threadReplies, picked.replies]).toEqual([1, 1, 1]);
  });

  it("时间线偶发回 404 + 空数组：隔一会儿再要，要到了就用", async () => {
    const calls: string[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return ++n < 3 ? json({ code: 404, results: [], cursor: { top: null, bottom: null } }, 404) : json(page);
    });
    const got = await fetchXTimelinePage("karpathy", "CUR SOR", noPause);
    expect(got.entries).toHaveLength(5);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("https://api.fxtwitter.com/2/profile/karpathy/statuses?cursor=CUR%20SOR");
  });

  it("试了 6 次都不行：抛普通错误（调用方记成「列到这里读不动了」）", async () => {
    const fetchMock = vi.fn(async () => json({ code: 404, results: [] }, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchXTimelinePage("karpathy", null, noPause)).rejects.toThrow(/时间线读不动（试了 6 次，接口回了 404）/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("X：账号信息", () => {
  const user = { screen_name: "karpathy", name: "Andrej Karpathy", description: " 讲 AI 的 ", statuses: 10174, protected: false };

  it("读出名字、简介、帖子总数", async () => {
    vi.stubGlobal("fetch", async () => json({ code: 200, user }));
    expect(await fetchXProfile("karpathy", noPause)).toEqual({ name: "Andrej Karpathy", handle: "@karpathy", bio: "讲 AI 的", postCount: 10174 });
  });

  it("真实存在的账号偶尔也回「User not found」：多问几次，问到了就不算没有", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => (++n < 4 ? json({ code: 404, message: "User not found" }, 404) : json({ code: 200, user })));
    expect((await fetchXProfile("karpathy", noPause)).name).toBe("Andrej Karpathy");
    expect(n).toBe(4);
  });

  it("连着 5 次都说没有才当账号不存在；私密账号读不了；别的状态是可以重试的错", async () => {
    const missing = vi.fn(async () => json({ code: 404, message: "User not found" }, 404));
    vi.stubGlobal("fetch", missing);
    await expect(fetchXProfile("nobody", noPause)).rejects.toThrow(SourceFetchError);
    expect(missing).toHaveBeenCalledTimes(5);
    vi.stubGlobal("fetch", async () => json({ code: 200, user: { ...user, protected: true } }));
    await expect(fetchXProfile("karpathy", noPause)).rejects.toThrow(/私密账号/);
    vi.stubGlobal("fetch", async () => json({ code: 500, message: "boom" }, 500));
    const err = await fetchXProfile("karpathy", noPause).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SourceFetchError);
  });
});

describe("X：一串帖子", () => {
  const thread = {
    code: 200,
    status: status("10001"),
    thread: [status("10001"), status("10003"), status("10009", { author: { screen_name: "someone_else" } }), status("10006"), status("10003")],
  };

  it("给出作者接着发的那几条（不含第一条、不含别人插进来的、不重复）", () => {
    expect(readXThreadIds(thread, "10001")).toEqual(["10003", "10006"]);
    expect(readXThreadIds({ code: 200, status: status("10001"), thread: null }, "10001")).toEqual([]);
  });

  it("读不到不算失败，但要让调用方知道没读成", async () => {
    vi.stubGlobal("fetch", async () => json(thread));
    expect(await fetchXThreadIds("10001")).toEqual(["10003", "10006"]);
    vi.stubGlobal("fetch", async () => json({ code: 500 }, 500));
    expect(await fetchXThreadIds("10001")).toBeNull();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchXThreadIds("10001")).toBeNull();
  });
});
