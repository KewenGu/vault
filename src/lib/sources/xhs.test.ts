import { describe, it, expect, vi, afterEach } from "vitest";
import { SourceFetchError } from "./types";
import { cleanDesc, extractInitialState, fetchXhsNote, parseCount, parseXhsState } from "./xhs";

const ID = "6aac3d9a000000000e03f000";

/** 按真实页面的形状缩出来的一份（2026-10 抓的分享页）。 */
function state(note: Record<string, unknown>, comments: unknown[] = []) {
  return { noteData: { data: { noteData: { noteId: ID, ...note }, commentData: { comments } } } };
}
const imageNote = {
  type: "normal",
  title: " 哈佛医学院毕业，他为何不当医生？ ",
  desc: "正文第一段 \n\n#医学教育[话题]# #职业选择[话题]#",
  time: 1789672858000,
  user: { userId: "65aea5c7000000000d01cd33", nickName: "Vool" },
  interactInfo: { likedCount: "1.2万", collectedCount: "8", commentCount: "3", shareCount: "" },
  tagList: [{ name: "医学教育" }, { name: " 职业选择 " }, { name: "" }],
  imageList: [
    { url: "http://sns-webpic-qc.xhscdn.com/a.jpg", width: 1080, height: 1800 },
    { url: "", infoList: [{ url: "http://sns-webpic-qc.xhscdn.com/b.jpg" }], width: "1080", height: "1800" },
  ],
  noteAttributes: ["long_text_to_image"],
};

afterEach(() => vi.unstubAllGlobals());

describe("收藏夹：读小红书笔记", () => {
  it("互动数的写法：K / 万 / 千分位 / 「10万+」", () => {
    expect(parseCount("14.5K")).toBe(14500);
    expect(parseCount("2,822")).toBe(2822);
    expect(parseCount("1.2万")).toBe(12000);
    expect(parseCount("10万+")).toBe(100000);
    expect(parseCount(37)).toBe(37);
    expect(parseCount("")).toBeNull();
    expect(parseCount("赞")).toBeNull();
    expect(parseCount(undefined)).toBeNull();
  });

  it("从页面里取出状态对象（值里有裸的 undefined）", () => {
    const html = `<html><script>window.__INITIAL_STATE__={"a":undefined,"b":[undefined,1],"c":{"d":"x"}}</script></html>`;
    expect(extractInitialState(html)).toEqual({ a: null, b: [null, 1], c: { d: "x" } });
    expect(extractInitialState("<html>没有</html>")).toBeNull();
    expect(extractInitialState("<script>window.__INITIAL_STATE__={坏的}</script>")).toBeNull();
  });

  it("正文里的话题标记去掉 [话题]#", () => {
    expect(cleanDesc("好店 #冷门好店大安利[话题]# #小红书市集[话题]#  ")).toBe("好店 #冷门好店大安利 #小红书市集");
  });

  it("图文笔记：标题、正文、作者、互动数、话题、每张图（http 换成 https）、高赞评论按赞数排", () => {
    const post = parseXhsState(
      state(imageNote, [
        { content: "第二条", likeCount: "5" },
        { content: "最高赞", likeViewCount: "1.1K", likeCount: "1100" },
        { content: "  " },
      ])
    );
    expect(post).toMatchObject({
      platform: "xiaohongshu",
      externalId: ID,
      kind: "image",
      title: "哈佛医学院毕业，他为何不当医生？",
      text: "正文第一段\n\n#医学教育 #职业选择",
      author: { id: "65aea5c7000000000d01cd33", name: "Vool" },
      publishedAt: "2026-09-17T19:20:58.000Z",
      stats: { likes: 12000, collects: 8, comments: 3, shares: null },
      hashtags: ["医学教育", "职业选择"],
      topComments: [
        { text: "最高赞", likes: 1100 },
        { text: "第二条", likes: 5 },
      ],
      video: null,
      notes: ["这是一篇「长文转图片」的笔记：正文主要写在图片里"],
    });
    expect(post.images).toEqual([
      { url: "https://sns-webpic-qc.xhscdn.com/a.jpg", width: 1080, height: 1800 },
      { url: "https://sns-webpic-qc.xhscdn.com/b.jpg", width: 1080, height: 1800 },
    ]);
  });

  it("视频笔记：优先 h264、挑不超过上限的最大一路；都超限时给最小的（下载时再拦）", () => {
    const stream = {
      h264: [
        { masterUrl: "http://v/h264-big.mp4", size: 80_000_000, width: 1080, height: 1920, duration: 145330 },
        { masterUrl: "http://v/h264-mid.mp4", backupUrls: ["http://b/1.mp4"], size: 14_000_000, width: 720, height: 1280, duration: 145330 },
      ],
      h265: [{ masterUrl: "http://v/h265.mp4", size: 30_000_000, width: 1080, height: 1920, duration: 145330 }],
    };
    const post = parseXhsState(state({ ...imageNote, type: "video", noteAttributes: [], video: { media: { stream } } }));
    expect(post.kind).toBe("video");
    expect(post.video).toEqual({ url: "https://v/h264-mid.mp4", backupUrls: ["https://b/1.mp4"], width: 720, height: 1280, bytes: 14_000_000, durationS: 145.3 });
    // 上限压到 10 MB：都超了，给最小的那路
    expect(parseXhsState(state({ ...imageNote, type: "video", video: { media: { stream } } }), 10_000_000).video?.url).toBe("https://v/h264-mid.mp4");
    // 页面没给视频地址：只有封面，记一句
    expect(parseXhsState(state({ ...imageNote, type: "video", noteAttributes: [], video: {} })).notes).toEqual(["页面里没有给出视频地址，只读到了封面"]);
  });

  it("页面里没有笔记（口令失效 / 被删）：报读不到", () => {
    expect(() => parseXhsState({ noteData: { data: { noteData: null } } })).toThrow(SourceFetchError);
    expect(() => parseXhsState({})).toThrow(/读不到/);
  });

  it("读笔记：只带口令和来源去请求；被转到 404 / 登录页、笔记对不上都报读不到", async () => {
    const ref = { platform: "xiaohongshu" as const, externalId: ID, url: `https://www.xiaohongshu.com/explore/${ID}?xsec_token=TOKEN%3D&xsec_source=app_share&shareRedId=secret&apptime=1` };
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state(imageNote))}</script>`;
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchXhsNote(ref)).title).toBe("哈佛医学院毕业，他为何不当医生？");
    const called = new URL(String(fetchMock.mock.calls[0][0]));
    expect(called.pathname).toBe(`/discovery/item/${ID}`);
    expect(Object.fromEntries(called.searchParams)).toEqual({ xsec_token: "TOKEN=", xsec_source: "app_share" });

    // 口令失效：跟着跳转落到 /404/sec_…
    const gone = new Response("<html></html>", { status: 200 });
    Object.defineProperty(gone, "url", { value: "https://www.xiaohongshu.com/404/sec_abc?source=xhs_sec_server" });
    vi.stubGlobal("fetch", vi.fn(async () => gone));
    await expect(fetchXhsNote(ref)).rejects.toThrow(SourceFetchError);

    // 页面给的是另一篇
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify(state({ ...imageNote, noteId: "000000000000000000000000" }))}</script>`)));
    await expect(fetchXhsNote(ref)).rejects.toThrow(/读不到/);

    // 页面里没有状态（触发了验证）
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>请完成验证</html>")));
    await expect(fetchXhsNote(ref)).rejects.toThrow(/没有笔记内容/);
  });

  it("链接里没有口令：不去请求，直接告诉用户怎么拿", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchXhsNote({ platform: "xiaohongshu", externalId: ID, url: `https://www.xiaohongshu.com/explore/${ID}` })).rejects.toThrow(/xsec_token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
