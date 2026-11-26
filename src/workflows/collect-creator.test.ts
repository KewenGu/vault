import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import type { ListStep } from "@/lib/sources/account-list";
import { parseLink } from "@/lib/sources/link";
import { SourceFetchError } from "@/lib/sources/types";
import { recordCall } from "@/lib/usage/meter";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("workflow", () => ({ sleep: vi.fn(async () => {}) }));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => {}) }));
vi.mock("@/lib/sources/account-list", () => ({ listAccountStep: vi.fn() }));
vi.mock("./process-item", () => ({ processItem: vi.fn() }));

import { sleep } from "workflow";
import { start } from "workflow/api";
import { listAccountStep } from "@/lib/sources/account-list";
import { collectCreator, saveCreatorPosts } from "./collect-creator";
import { processItem } from "./process-item";

const USER = "11111111-1111-4111-8111-111111111111";
const CREATOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STARTED = "2026-11-26T08:00:00.000Z";
const postId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const creator = () => fake.store.creators[0];
const posts = () => fake.store.creator_posts;
const items = () => fake.store.items;

/** 清单里的一条：n 越大发得越晚（先存）。 */
const postRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: postId(n),
  user_id: USER,
  creator_id: CREATOR,
  external_id: `10${n}`,
  url: `https://x.com/karpathy/status/10${n}`,
  kind: "text",
  title: `帖子 ${n}`,
  published_at: `2026-11-${String(n).padStart(2, "0")}T00:00:00.000Z`,
  pinned: false,
  status: "pending",
  item_id: null,
  created_at: STARTED,
  ...over,
});

function seed(over: Record<string, unknown> = {}, postRows: Record<string, unknown>[] = [], itemRows: Record<string, unknown>[] = []) {
  fake = makeFakeSupabase({
    creators: [{ id: CREATOR, user_id: USER, platform: "x", external_id: "karpathy", url: "https://x.com/karpathy", handle: "@karpathy", name: "", bio: "", post_count: null, status: "listing", error: null, want: 3, notes: [], usage: {}, cost_usd: 0, started_at: STARTED, synced_at: null, created_at: STARTED, updated_at: STARTED, ...over }],
    creator_posts: postRows,
    items: itemRows,
  });
}

const listed = (n: number) => ({ externalId: `10${n}`, url: `https://x.com/karpathy/status/10${n}`, kind: "text" as const, title: `帖子 ${n}`, publishedAt: `2026-11-${String(n).padStart(2, "0")}T00:00:00.000Z`, pinned: false });
const step = (over: Partial<ListStep>): ListStep => ({ done: false, state: null, waitS: 0, info: null, posts: [], notes: [], ...over });

beforeEach(() => {
  seed();
  vi.mocked(sleep).mockClear();
  vi.mocked(start).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(listAccountStep).mockReset();
  // 处理一条内容：标成处理好了
  vi.mocked(processItem)
    .mockReset()
    .mockImplementation(async (itemId: string) => {
      const row = items().find((i) => i.id === itemId);
      if (row) row.status = "ready";
    });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("collectCreator：列作品，列完一条条存", () => {
  it("一步步列（两步之间按要求等），清单落库，然后从最新的开始每次两条存完", async () => {
    vi.mocked(listAccountStep)
      .mockImplementationOnce(async () => step({ state: { via: "apify", runId: "R", datasetId: "D", polls: 0 }, waitS: 8 }))
      .mockImplementationOnce(async () => {
        recordCall("apify_tiktok_profile_post", 3);
        return step({ done: true, info: { name: "Andrej Karpathy", handle: "@karpathy", bio: "讲 AI 的", postCount: 10174 }, posts: [listed(1), listed(3), listed(2)], notes: ["他转发别人的 4 条没存（只存他自己发的）"] });
      });
    await collectCreator(CREATOR, USER, STARTED);

    // 第二步拿到的是第一步给的状态；等了 8 秒
    expect(vi.mocked(listAccountStep).mock.calls.map((c) => [c[0].externalId, c[1], c[2]])).toEqual([
      ["karpathy", 3, null],
      ["karpathy", 3, { via: "apify", runId: "R", datasetId: "D", polls: 0 }],
    ]);
    expect(vi.mocked(sleep).mock.calls).toEqual([["8s"]]);
    expect(creator()).toMatchObject({ status: "ready", error: null, name: "Andrej Karpathy", bio: "讲 AI 的", post_count: 10174, notes: ["他转发别人的 4 条没存（只存他自己发的）"], usage: { apify_tiktok_profile_post: 3 }, cost_usd: 0.006 });
    expect(creator().synced_at).toEqual(expect.any(String));
    // 最新的先存，一次两条
    expect(vi.mocked(processItem).mock.calls.map((c) => items().find((i) => i.id === c[0])?.external_id)).toEqual(["103", "102", "101"]);
    expect(posts().map((p) => [p.external_id, p.status, p.item_id === p.id])).toEqual([["101", "saved", true], ["103", "saved", true], ["102", "saved", true]]);
    // 每一条是收藏库里普通的一条链接内容；X 的带着「把后面那一串也读进来」
    expect(items()[0]).toMatchObject({ user_id: USER, source: "link", platform: "x", external_id: "103", dedupe_key: "x:103", url: "https://x.com/karpathy/status/103", title: "帖子 3", kind: "text", post: { withThread: true } });
  });

  it("账号读不到（不存在、私密、没配令牌）：原因写回去，不重试、不往下存", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listAccountStep).mockRejectedValue(new SourceFetchError("@karpathy 是私密账号，帖子读不了"));
    await collectCreator(CREATOR, USER, STARTED);
    expect(vi.mocked(listAccountStep)).toHaveBeenCalledTimes(1);
    expect(creator()).toMatchObject({ status: "failed", error: "@karpathy 是私密账号，帖子读不了" });
    expect(processItem).not.toHaveBeenCalled();
  });

  it("网络抖动这类错在一步里重试；三次都不行才算失败，已经花掉的照样记", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.mocked(listAccountStep)
      .mockRejectedValueOnce(new Error("Apify(api.apify.com) 连接失败: ECONNRESET"))
      .mockImplementationOnce(async () => step({ done: true, posts: [listed(1)] }));
    let run = collectCreator(CREATOR, USER, STARTED);
    await vi.runAllTimersAsync();
    await run;
    expect(creator().status).toBe("ready");
    expect(posts()).toHaveLength(1);

    seed();
    vi.mocked(listAccountStep)
      .mockReset()
      .mockImplementation(async () => {
        recordCall("apify_tiktok_profile_post", 1);
        throw new Error("Apify(api.apify.com) 请求超时");
      });
    run = collectCreator(CREATOR, USER, STARTED);
    await vi.runAllTimersAsync();
    await run;
    expect(vi.mocked(listAccountStep)).toHaveBeenCalledTimes(3);
    expect(creator()).toMatchObject({ status: "failed", error: "Apify(api.apify.com) 请求超时", usage: { apify_tiktok_profile_post: 3 } });
  });

  it("不是自己这一轮的不做：已经结束的、中途又重新开始的（开始时间对不上）", async () => {
    seed({ status: "ready" });
    await collectCreator(CREATOR, USER, STARTED);
    seed({ started_at: "2026-11-26T09:00:00.000Z" });
    await collectCreator(CREATOR, USER, STARTED);
    expect(listAccountStep).not.toHaveBeenCalled();
  });

  it("再同步：清单里已经有的不动，只有新的排队存", async () => {
    seed({}, [postRow(1, { status: "saved", item_id: "old-item" }), postRow(2, { status: "held" })]);
    vi.mocked(listAccountStep).mockImplementationOnce(async () => step({ done: true, posts: [listed(3), listed(2), listed(1)] }));
    await collectCreator(CREATOR, USER, STARTED);
    expect(posts().map((p) => [p.external_id, p.status])).toEqual([["101", "saved"], ["102", "held"], ["103", "saved"]]);
    expect(processItem).toHaveBeenCalledTimes(1);
  });
});

describe("saveCreatorPosts：一条条存", () => {
  it("用户以前单独存过的那一条不重新处理，清单指到已有的那条", async () => {
    seed({ status: "saving" }, [postRow(1), postRow(2)], [{ id: "mine-before", user_id: USER, source: "link", dedupe_key: "x:102", status: "ready", platform: "x", external_id: "102", media: [] }]);
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(posts().map((p) => [p.external_id, p.status, p.item_id])).toEqual([["101", "saved", postId(1)], ["102", "saved", "mine-before"]]);
    expect(vi.mocked(processItem).mock.calls).toEqual([[postId(1)]]);
    expect(creator().status).toBe("ready");
  });

  it("上一次建到一半断了：自己建的那条没处理完的重新来，处理好了的不重做", async () => {
    const mine = (n: number, status: string) => ({ id: postId(n), user_id: USER, source: "link", dedupe_key: `x:10${n}`, status, platform: "x", external_id: `10${n}`, url: `https://x.com/karpathy/status/10${n}`, media: [], tags: [], tags_locked: false, started_at: "2026-11-26T07:00:00.000Z", created_at: STARTED, error: "上次的错" });
    seed({ status: "saving" }, [postRow(1), postRow(2)], [mine(1, "ready"), mine(2, "fetching")]);
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(vi.mocked(processItem).mock.calls).toEqual([[postId(2)]]);
    // 重新来的那条换了开始时间、清了报错（不然页面上马上显示成卡住了）
    expect(items()[1].started_at).not.toBe("2026-11-26T07:00:00.000Z");
    expect(items()[1].error).toBeNull();
    expect(posts().every((p) => p.status === "saved")).toBe(true);
  });

  it("中途用户点了停：正在处理的这一批照样标成已存，后面的不再拿", async () => {
    seed({ status: "saving" }, [postRow(1), postRow(2), postRow(3), postRow(4)]);
    vi.mocked(processItem).mockImplementation(async (itemId: string) => {
      const row = items().find((i) => i.id === itemId);
      if (row) row.status = "ready";
      // 停：状态回到 ready，还排着队的搁下
      creator().status = "ready";
      for (const p of posts()) if (p.status === "pending") p.status = "held";
    });
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(processItem).toHaveBeenCalledTimes(2);
    expect(posts().map((p) => [p.external_id, p.status])).toEqual([["101", "held"], ["102", "held"], ["103", "saved"], ["104", "saved"]]);
    expect(items()).toHaveLength(2);
  });

  it("一条处理失败是那条内容自己的事：清单上照样算存了，接着存后面的", async () => {
    seed({ status: "saving" }, [postRow(1), postRow(2), postRow(3)]);
    vi.mocked(processItem).mockImplementation(async (itemId: string) => {
      const row = items().find((i) => i.id === itemId);
      if (row) row.status = row.external_id === "103" ? "failed" : "ready";
    });
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(items().map((i) => [i.external_id, i.status])).toEqual([["103", "failed"], ["102", "ready"], ["101", "ready"]]);
    expect(posts().every((p) => p.status === "saved")).toBe(true);
    expect(creator().status).toBe("ready");
  });

  it("VAULT_CREATOR_PARALLEL 定一次处理几条", async () => {
    vi.stubEnv("VAULT_CREATOR_PARALLEL", "1");
    seed({ status: "saving" }, [postRow(1), postRow(2)]);
    let running = 0;
    let most = 0;
    vi.mocked(processItem).mockImplementation(async () => {
      most = Math.max(most, ++running);
      await Promise.resolve();
      running--;
    });
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(most).toBe(1);
    expect(processItem).toHaveBeenCalledTimes(2);
  });

  it("作品很多：存满 20 批就另起一次运行接着存，自己这次到此为止", async () => {
    seed({ status: "saving" }, Array.from({ length: 45 }, (_, i) => postRow(i + 1, { published_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString() })));
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(processItem).toHaveBeenCalledTimes(40);
    expect(posts().filter((p) => p.status === "pending")).toHaveLength(5);
    expect(creator().status).toBe("saving");
    expect(vi.mocked(start).mock.calls).toEqual([[saveCreatorPosts, [CREATOR, USER, STARTED]]]);
    // 接上的那一次把剩下的存完
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(posts().every((p) => p.status === "saved")).toBe(true);
    expect(creator().status).toBe("ready");
  });

  it("接着存的那次运行没起来：原因写回去，不挂在「正在存」", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seed({ status: "saving" }, Array.from({ length: 41 }, (_, i) => postRow(i + 1, { published_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString() })));
    vi.mocked(start).mockRejectedValue(new Error("workflow runtime unavailable"));
    await saveCreatorPosts(CREATOR, USER, STARTED);
    expect(creator()).toMatchObject({ status: "failed", error: "存到一半后台任务没接上：workflow runtime unavailable" });
  });

  it("B 站：视频和单独贴链接时一样按网页存（平台是 web，id 是整理过的地址的哈希）；以前这样存过的不重复", async () => {
    const bili = (n: number, bv: string, over: Record<string, unknown> = {}) => postRow(n, { external_id: bv, url: `https://www.bilibili.com/video/${bv}`, kind: "video", ...over });
    const before = parseLink("https://www.bilibili.com/video/BV1HBnH6JEAZ/?spm_id_from=333.1007&vd_source=abc")!;
    seed({ status: "saving", platform: "bilibili", external_id: "88461692", url: "https://space.bilibili.com/88461692" }, [bili(1, "BV1HBnH6JEAZ"), bili(2, "BV1u7hQ6rEQB")], [{ id: "mine-before", user_id: USER, source: "link", dedupe_key: `web:${before.externalId}`, status: "ready", platform: "web", external_id: before.externalId, url: before.url, media: [] }]);
    await saveCreatorPosts(CREATOR, USER, STARTED);
    const fresh = items().find((i) => i.id === postId(2));
    const ref = parseLink("https://www.bilibili.com/video/BV1u7hQ6rEQB")!;
    expect(fresh).toMatchObject({ source: "link", platform: "web", external_id: ref.externalId, dedupe_key: `web:${ref.externalId}`, url: "https://www.bilibili.com/video/BV1u7hQ6rEQB", kind: "video" });
    // 不是 X：不带「把后面那一串也读进来」
    expect(fresh?.post).toBeUndefined();
    expect(vi.mocked(processItem).mock.calls).toEqual([[postId(2)]]);
    expect(posts().map((p) => [p.external_id, p.status, p.item_id])).toEqual([["BV1HBnH6JEAZ", "saved", "mine-before"], ["BV1u7hQ6rEQB", "saved", postId(2)]]);
  });

  it("别人的博主碰不到", async () => {
    seed({ status: "saving" }, [postRow(1)]);
    await saveCreatorPosts(CREATOR, "22222222-2222-4222-8222-222222222222", STARTED);
    expect(processItem).not.toHaveBeenCalled();
    expect(posts()[0].status).toBe("pending");
  });
});
