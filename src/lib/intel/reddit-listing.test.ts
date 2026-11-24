import { describe, expect, it, vi } from "vitest";
import { MAX_PAGES, listSubreddit, mapRedditRow, parseSubreddit } from "./reddit-listing";

/** 存档 `/api/posts/search` 带 `fields` 时真实返回的形状（2026-11-24 读的 r/LocalLLaMA，正文截短了）。 */
const withText = {
  author: "seraschka",
  created_utc: 1795458869,
  id: "1y3q68f",
  link_flair_text: "Showcase",
  num_comments: 37,
  retrieved_on: 1795458892,
  score: 556,
  selftext: "I seriously think US open-weight models wouldn't be this good\n\nwithout Chinese open-weight models and vice versa.",
  subreddit: "LocalLLaMA",
  title: "The US-China Open-Weight Feedback Loop",
  url: "https://i.redd.it/tkgl4i9zoe3i1.jpeg",
};
const linkOnly = { author: "autonoma_2042", created_utc: 1795462062, id: "1y3rm7a", num_comments: 0, score: 0, selftext: "", subreddit: "LocalLLaMA", title: "Qwen3.6-Grammar-Distill-GGUF", url: "https://huggingface.co/thangalin/Qwen3.6-Grammar-Distill-GGUF" };

describe("情报：Reddit 版块的帖子", () => {
  it("版块名：几种写法都认，认不出是 null", () => {
    expect(parseSubreddit("LocalLLaMA")).toBe("LocalLLaMA");
    expect(parseSubreddit(" r/LocalLLaMA ")).toBe("LocalLLaMA");
    expect(parseSubreddit("/r/AI_Agents/")).toBe("AI_Agents");
    expect(parseSubreddit("https://www.reddit.com/r/aivideo/top/?t=week")).toBe("aivideo");
    expect(parseSubreddit("两个 词")).toBeNull();
    expect(parseSubreddit("a")).toBeNull();
    expect(parseSubreddit("has-dash")).toBeNull();
    expect(parseSubreddit("")).toBeNull();
  });

  it("一条帖子 → 候选：链接是帖子本身，开头取正文，数字和时间照抄", () => {
    expect(mapRedditRow(withText, "localllama")).toEqual({
      source: "reddit",
      externalId: "1y3q68f",
      url: "https://www.reddit.com/comments/1y3q68f",
      discussionUrl: null,
      title: "The US-China Open-Weight Feedback Loop",
      excerpt: "I seriously think US open-weight models wouldn't be this good without Chinese open-weight models and vice versa.",
      author: "u/seraschka",
      channel: "r/LocalLLaMA",
      score: 556,
      comments: 37,
      publishedAt: "2026-11-23T18:34:29.000Z",
    });
  });

  it("没有正文的链接帖说一声指向哪；图片帖（地址在 redd.it 上）不说", () => {
    expect(mapRedditRow(linkOnly, "LocalLLaMA")?.excerpt).toBe("链接：huggingface.co");
    expect(mapRedditRow({ ...withText, selftext: "" }, "LocalLLaMA")?.excerpt).toBe("");
    expect(mapRedditRow({ ...linkOnly, url: "javascript:alert(1)" }, "LocalLLaMA")?.excerpt).toBe("");
  });

  it("被移除的、形状不对的不要；正文被删的留标题", () => {
    expect(mapRedditRow({ ...withText, title: "[ Removed by moderator ]" }, "x")).toBeNull();
    expect(mapRedditRow({ ...withText, id: "../x" }, "x")).toBeNull();
    expect(mapRedditRow({ title: "没有 id" }, "x")).toBeNull();
    expect(mapRedditRow(null, "x")).toBeNull();
    const gone = mapRedditRow({ ...withText, selftext: "[removed]", author: "[deleted]", url: "https://www.reddit.com/r/LocalLLaMA/comments/1y3q68f/x/" }, "x");
    expect(gone).toMatchObject({ excerpt: "", author: null });
  });

  const since = new Date("2026-11-21T12:00:00Z");
  const now = new Date("2026-11-24T12:00:00Z");
  const row = (n: number, created: number) => ({ id: `p${String(n).padStart(4, "0")}`, title: `帖子 ${n}`, selftext: "", subreddit: "Busy", created_utc: created, score: n });
  const pageOf = (start: number, newest: number) => Array.from({ length: 100 }, (_, i) => row(start + i, newest - i * 60));

  it("一页没满就是看完了：只问一次，带着时间窗和要的字段", async () => {
    const get = vi.fn<(path: string) => Promise<unknown>>(async () => [withText, linkOnly, { ...withText }]);
    const wait = vi.fn(async () => {});
    const got = await listSubreddit("LocalLLaMA", since, { now, get, wait });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/posts/search?subreddit=LocalLLaMA&after=1795262400&limit=100&sort=desc&fields=id,title,selftext,author,subreddit,created_utc,score,num_comments,url,link_flair_text");
    // 同一条出现两次只算一次
    expect(got.candidates.map((c) => c.externalId)).toEqual(["1y3q68f", "1y3rm7a"]);
    expect(got.notes).toEqual([]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("一页满了接着往前翻：下一页从上一页最老的那条的时间之前开始，两次之间等一下", async () => {
    const newest = Math.floor(now.getTime() / 1000);
    const pages = [pageOf(0, newest), pageOf(100, newest - 6000).slice(0, 40)];
    const get = vi.fn<(path: string) => Promise<unknown>>(async () => pages.shift() ?? []);
    const wait = vi.fn(async () => {});
    const got = await listSubreddit("Busy", since, { now, get, wait });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0]).toContain(`&before=${newest - 99 * 60}&`);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(got.candidates).toHaveLength(140);
    expect(got.notes).toEqual([]);
  });

  it("翻到上限还没到头：说清楚只看了最近多少小时的", async () => {
    const newest = Math.floor(now.getTime() / 1000);
    let n = 0;
    const get = vi.fn(async () => pageOf(n * 100, newest - n++ * 6000));
    const got = await listSubreddit("Busy", since, { now, get, wait: async () => {} });
    expect(get).toHaveBeenCalledTimes(MAX_PAGES);
    expect(got.candidates).toHaveLength(600);
    // 最老的一条是 5 × 6000 + 99 × 60 秒前，约 10 小时
    expect(got.notes).toEqual(["r/Busy 帖子太多：只看了最近 10 小时的（600 条），再往前的没看"]);
  });

  it("一条都没有：多半是版块名写错了，说出来（和「有帖子但都没过线」不是一回事）", async () => {
    const got = await listSubreddit("nosuchsub", since, { now, get: async () => [], wait: async () => {} });
    expect(got).toEqual({ candidates: [], notes: ["存档里 r/nosuchsub 最近 3 天一条帖子都没有：版块名可能写错了，或者是私密的"] });
  });

  it("存档返回的不是列表、存档出错：往上抛（调用方记在来源上）", async () => {
    await expect(listSubreddit("x1", since, { now, get: async () => null, wait: async () => {} })).rejects.toThrow("不是帖子列表");
    await expect(listSubreddit("x1", since, { now, get: async () => Promise.reject(new Error("Reddit 存档 请求超时")), wait: async () => {} })).rejects.toThrow("请求超时");
  });
});
