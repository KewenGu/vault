import { afterEach, describe, expect, it, vi } from "vitest";
import { hnSearchUrl, mapHnHit, plainText, searchHn } from "./hackernews";

/** hn.algolia.com 真实返回的两条（2026-11-24 读的；正文截短了）：一条指向别处的 Show HN，一条没有链接的 Ask HN。 */
const showHn = {
  _tags: ["story", "author_desilva78_", "story_50562508", "show_hn"],
  author: "desilva78_",
  created_at: "2026-11-19T16:46:14Z",
  created_at_i: 1795106774,
  num_comments: 11,
  objectID: "50562508",
  points: 21,
  story_id: 50562508,
  story_text: "Hey HN, we’re Nel and Kosi.<p>We noticed personal agents were terrible at buying stuff.<p>It currently works on these sites:<p>- Walmart\n- Albertsons",
  title: "Show HN: AgentMall – Let your AI agent buy groceries",
  url: "https://getagentmall.com",
};
const askHn = {
  author: "LetThingsBeDiff",
  created_at_i: 1795216712,
  num_comments: 852,
  objectID: "50583761",
  points: 742,
  story_text: "I&#x27;m Senior software engineer in the US (DMV area), with 15y of experience. Can&#x27;t find a job &amp; spent my savings.",
  title: "Ask HN: I have been unemployed for 2y. 15 years of experience, US. What to do?",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("情报：Hacker News 的搜索", () => {
  it("指向文章的：存文章的链接，讨论页另外带着；正文去掉标签", () => {
    expect(mapHnHit(showHn)).toEqual({
      source: "hackernews",
      externalId: "50562508",
      url: "https://getagentmall.com/",
      discussionUrl: "https://news.ycombinator.com/item?id=50562508",
      title: "Show HN: AgentMall – Let your AI agent buy groceries",
      excerpt: "Hey HN, we’re Nel and Kosi. We noticed personal agents were terrible at buying stuff. It currently works on these sites: - Walmart - Albertsons",
      author: "desilva78_",
      channel: "Hacker News",
      score: 21,
      comments: 11,
      publishedAt: "2026-11-19T16:46:14.000Z",
    });
  });

  it("没有链接的（Ask HN）：存讨论页；正文里的实体还原", () => {
    const c = mapHnHit(askHn);
    expect(c?.url).toBe("https://news.ycombinator.com/item?id=50583761");
    expect(c?.discussionUrl).toBe(c?.url);
    expect(c?.excerpt).toBe("I'm Senior software engineer in the US (DMV area), with 15y of experience. Can't find a job & spent my savings.");
  });

  it("没有正文的说一声链接指向哪；不是 http 的链接不认；形状不对的不要", () => {
    expect(mapHnHit({ ...showHn, story_text: null })?.excerpt).toBe("链接：getagentmall.com");
    expect(mapHnHit({ ...showHn, url: "javascript:alert(1)", story_text: "" })).toMatchObject({ url: "https://news.ycombinator.com/item?id=50562508", excerpt: "" });
    expect(mapHnHit({ ...showHn, objectID: "abc" })).toBeNull();
    expect(mapHnHit({ ...showHn, title: " " })).toBeNull();
    expect(mapHnHit(null)).toBeNull();
  });

  it("HTML 只当文字：标签去掉，脚本里的字留成字，不认识的实体原样", () => {
    expect(plainText('a<p>b<br/>c <a href="https://x.example" rel="nofollow">链接</a> <script>alert(1)</script> &lt;i&gt; &#x4e2d; &unknown;')).toBe("a b c 链接 alert(1) <i> 中 &unknown;");
  });

  it("搜索的地址：分数线和时间窗进筛选，关掉容错，只在标题和正文里找", () => {
    const url = new URL(hnSearchUrl('"AI agent" MCP', 30.4, new Date("2026-11-17T12:00:00Z")));
    expect(url.origin + url.pathname).toBe("https://hn.algolia.com/api/v1/search_by_date");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '"AI agent" MCP',
      tags: "story",
      numericFilters: "points>=30,created_at_i>1794916800",
      hitsPerPage: "50",
      typoTolerance: "false",
      restrictSearchableAttributes: "title,story_text",
    });
  });

  it("搜一次：取到的变成候选；符合的比取到的多要说", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ hits: [showHn, askHn, { junk: true }], nbHits: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const got = await searchHn("agent", 20, new Date("2026-11-17T12:00:00Z"));
    expect(String(fetchMock.mock.calls[0][0])).toContain("query=agent");
    expect(got.candidates.map((c) => c.externalId)).toEqual(["50562508", "50583761"]);
    expect(got.notes).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hits: [showHn], nbHits: 240 }), { status: 200 })));
    expect((await searchHn("AI", 0, new Date())).notes).toEqual(["符合的有 240 条，只取了最新的 1 条：把分数线调高，或者把词写窄一点"]);
  });

  it("接口出错、返回的不是结果：往上抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    await expect(searchHn("agent", 20, new Date())).rejects.toThrow(/Hacker News 搜索/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad" }), { status: 200 })));
    await expect(searchHn("agent", 20, new Date())).rejects.toThrow("不是搜索结果");
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
