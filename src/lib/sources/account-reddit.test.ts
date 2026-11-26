import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRedditUserName, fetchRedditUserPosts, readRedditListing } from "./account-reddit";
import { parseLink } from "./link";

// 走全局 fetch（测试里换成假的）；DNS / 连接那一层在 network/public-fetch.test.ts 里测
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/network/public-fetch")>()),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 存档 2026-11-26 实际返回的形状（带 fields 时只有这几项；没有 post_hint 的那一行就不带这一项）。 */
const row = (id: string, over: Record<string, unknown> = {}) => ({ author: "spez", created_utc: 1793304517, id, subreddit: "u_spez", title: " About that login screen ", url: `https://www.reddit.com/user/spez/comments/${id}/about_that_login_screen/`, ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("列一个 Reddit 用户的帖子：认存档的输出", () => {
  it("链接是 reddit.com/comments/<id>（和单独贴链接认出来的一样）；是哪一类从 post_hint 和地址猜，链接帖先不说", () => {
    const page = readRedditListing(
      [
        row("1xiupm0", { author: "Spez" }),
        row("1VGBKGE", { post_hint: "self", created_utc: 1785945836.7 }),
        row("1tvsa59", { subreddit: "redditstock", url: "https://v.redd.it/abc123", created_utc: 1780499467 }),
        row("1tp51gf", { post_hint: "hosted:video", url: "https://www.reddit.com/r/x/comments/1tp51gf/y/" }),
        row("1t4nr7v", { url: "https://i.redd.it/pic.jpg" }),
        row("1t4nmrc", { url: "https://www.reddit.com/gallery/1t4nmrc" }),
        row("1t07i8q", { post_hint: "link", url: "https://example.com/article", created_utc: 1777579814 }),
        // 重复的、别人的、不是帖子的不要
        row("1xiupm0"),
        row("1zzzzzz", { author: "someone_else" }),
        { id: "不是 id" },
      ],
      "spez",
    );
    expect(page.name).toBe("Spez");
    expect(page.rows).toBe(10);
    // 往回翻用的是这一页最旧那条的时间
    expect(page.before).toBe(1777579814);
    expect(page.posts.map((p) => [p.externalId, p.kind])).toEqual([
      ["1xiupm0", "text"],
      ["1vgbkge", "text"],
      ["1tvsa59", "video"],
      ["1tp51gf", "video"],
      ["1t4nr7v", "image"],
      ["1t4nmrc", "image"],
      ["1t07i8q", null],
    ]);
    expect(page.posts[0]).toEqual({ externalId: "1xiupm0", url: "https://www.reddit.com/comments/1xiupm0", kind: "text", title: "About that login screen", publishedAt: "2026-10-29T20:08:37.000Z", pinned: false });
    for (const p of page.posts) expect(parseLink(p.url)).toEqual({ platform: "reddit", externalId: p.externalId, url: p.url });
    expect(readRedditListing([], "spez")).toEqual({ name: "", posts: [], before: null, rows: 0 });
  });

  it("问存档：用户名、条数（1–100）、往回翻的时间都在地址里；返回的不是清单就报错", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return json({ data: [row("1xiupm0")] });
    });
    expect((await fetchRedditUserPosts("Spez", null)).posts).toHaveLength(1);
    await fetchRedditUserPosts("some-one_2", 1777579814, 500);
    expect(urls).toEqual([
      "https://arctic-shift.photon-reddit.com/api/posts/search?author=Spez&sort=desc&limit=100&fields=id,author,subreddit,created_utc,title,post_hint,url",
      "https://arctic-shift.photon-reddit.com/api/posts/search?author=some-one_2&sort=desc&limit=100&fields=id,author,subreddit,created_utc,title,post_hint,url&before=1777579814",
    ]);
    vi.stubGlobal("fetch", async () => json({ data: null }));
    await expect(fetchRedditUserPosts("spez", null)).rejects.toThrow("Reddit 存档返回的不是帖子的清单");
  });

  it("存档见没见过这个用户：只认用户名完全一样的（不分大小写），给出他自己写的大小写", async () => {
    vi.stubGlobal("fetch", async () => json({ data: [{ author: "spezza", id: "1" }, { author: "Spez", id: "1w72", _meta: { num_posts: 549 } }] }));
    expect(await fetchRedditUserName("spez")).toBe("Spez");
    expect(await fetchRedditUserName("spe")).toBeNull();
    vi.stubGlobal("fetch", async () => json({ data: [] }));
    expect(await fetchRedditUserName("nobody_here")).toBeNull();
  });
});
