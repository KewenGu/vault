import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchXPost, linkedPostIds, mapFxTweet, mapSyndicationTweet, readFxTweet, readSyndicationTweet, syndicationToken, withMentions } from "./x";
import { SourceFetchError } from "./types";

/** 按 api.fxtwitter.com 真实返回的形状缩出来的（2026-10）。 */
const fx = (over: Record<string, unknown> = {}) => ({
  id: "2106418403661779046",
  text: "三个让新人少走弯路的习惯 #职场 #AI工具\n第二行 https://t.co/abc",
  author: { id: "79526964", name: "某某", screen_name: "someone" },
  replies: 12,
  retweets: 30,
  quotes: 5,
  likes: 400,
  bookmarks: 220,
  views: 51000,
  created_timestamp: 1791044257,
  ...over,
});
const video = {
  url: "https://video.twimg.com/v/720.mp4",
  thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
  duration: 12.9,
  width: 640,
  height: 640,
  variants: [
    { url: "https://video.twimg.com/v/pl.m3u8", content_type: "application/x-mpegURL" },
    { url: "https://video.twimg.com/v/320.mp4", content_type: "video/mp4", bitrate: 320_000 },
    { url: "https://video.twimg.com/v/720.mp4", content_type: "video/mp4", bitrate: 832_000 },
  ],
};
const ref = { platform: "x" as const, externalId: "2106418403661779046", url: "https://x.com/someone/status/2106418403661779046" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("收藏夹：读 X 帖子", () => {
  it("配图帖：标题取第一行（去话题和链接），作者是「名字 @账号」，互动数按 X 的叫法对上（书签 = 收藏、回复 = 评论、转发含引用）", () => {
    const post = mapFxTweet(fx({ media: { photos: [{ url: "https://pbs.twimg.com/a.jpg?name=orig", width: 1200, height: 900 }, { url: "https://pbs.twimg.com/b.jpg", width: 1, height: 1 }] } }));
    expect(post).toMatchObject({
      platform: "x",
      externalId: "2106418403661779046",
      kind: "image",
      title: "三个让新人少走弯路的习惯",
      author: { id: "79526964", name: "某某 @someone" },
      publishedAt: "2026-10-03T16:17:37.000Z",
      stats: { views: 51000, likes: 400, collects: 220, comments: 12, shares: 35 },
      hashtags: ["职场", "AI工具"],
      video: null,
      notes: ["读不到回复的内容，只有回复数"],
    });
    expect(post.images).toEqual([
      { url: "https://pbs.twimg.com/a.jpg?name=orig", width: 1200, height: 900 },
      { url: "https://pbs.twimg.com/b.jpg", width: 1, height: 1 },
    ]);
  });

  it("视频帖：挑估算大小不超上限的最高码率 mp4，更低的档当备用；封面当图", () => {
    const post = mapFxTweet(fx({ media: { videos: [video] } }));
    expect(post.kind).toBe("video");
    expect(post.video).toEqual({ url: "https://video.twimg.com/v/720.mp4", backupUrls: ["https://video.twimg.com/v/320.mp4"], bytes: 1341600, width: 640, height: 640, durationS: 12.9 });
    expect(post.images).toEqual([{ url: "https://pbs.twimg.com/thumb.jpg", width: 640, height: 640 }]);
    // 上限很小：换成能放下的那档
    expect(mapFxTweet(fx({ media: { videos: [video] } }), 600_000).video).toMatchObject({ url: "https://video.twimg.com/v/320.mp4", backupUrls: [] });
    // 好几个视频只存第一个
    expect(mapFxTweet(fx({ media: { videos: [video, video] } })).notes).toContain("这条帖子有 2 个视频，只存了第一个");
  });

  it("纯文字帖：链接卡片拼进正文（卡片图当配图），引用的帖子不在这一步；回复、社区备注记一句", () => {
    const post = mapFxTweet(
      fx({
        text: "这个观点我不同意",
        replying_to: "other",
        community_note: { text: "原文数据\n有误" },
        quote: { text: "被引用的原话", author: { screen_name: "quoted" } },
        card: { title: "文章标题", description: "文章摘要", domain: "example.com", image: { url: "https://pbs.twimg.com/card.jpg", width: 800, height: 419 } },
      })
    );
    expect(post.kind).toBe("text");
    expect(post.text).toBe("这个观点我不同意\n\n【链接卡片】文章标题\n文章摘要（example.com）");
    expect(post.images).toEqual([{ url: "https://pbs.twimg.com/card.jpg", width: 800, height: 419 }]);
    expect(post.notes).toEqual(["读不到回复的内容，只有回复数", "这是回 @other 的一条回复，上文没读到", "帖子下有社区备注：原文数据 有误"]);
  });

  it("X 长文（Articles）：标题用长文的；正文照 Markdown 写（标题、列表、引用、代码块、分割线），配图按顺序存到上限，没存的、嵌进来的帖子记一句", () => {
    const img = (id: string) => ({ media_id: id, media_info: { __typename: "ApiImage", original_img_url: `https://pbs.twimg.com/media/${id}.jpg`, original_img_width: 1280, original_img_height: 720 } });
    const block = (type: string, text: string, entityRanges: unknown[] = []) => ({ type, text, entityRanges, inlineStyleRanges: [], data: {} });
    const atomic = (key: number) => block("atomic", " ", [{ key, offset: 0, length: 1 }]);
    const entity = (key: number, type: string, data: Record<string, unknown>) => ({ key: String(key), value: { type, mutability: "Immutable", data } });
    const post = mapFxTweet(
      fx({
        text: "怎么搭一支 AI 开发团队，7 步：https://x.com/i/article/2109705772569423873",
        card: { title: "长文的卡片", domain: "x.com" },
        article: {
          id: "2109705772569423873",
          title: "用 Opus 搭开发团队（完整教程）",
          cover_media: img("cover"),
          media_entities: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map(img),
          content: {
            blocks: [
              block("unstyled", "从一个 issue 出发。"),
              block("blockquote", "并行越多，越要协调。"),
              atomic(0),
              block("header-one", "1. 准备"),
              block("ordered-list-item", "装 git"),
              block("ordered-list-item", "装 gh", [{ key: 4, offset: 2, length: 2 }]),
              block("unordered-list-item", "架构师"),
              block("unordered-list-item", "测试"),
              atomic(1),
              block("unstyled", ""),
              atomic(2),
              atomic(3),
              atomic(5),
              block("header-two", "收尾"),
            ],
            entityMap: [
              entity(0, "TWEET", { tweetId: "2102435511222890900" }),
              entity(1, "MARKDOWN", { markdown: "```bash\ngh auth login\n```\n" }),
              entity(2, "DIVIDER", {}),
              entity(3, "MEDIA", { mediaItems: ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "gone"].map((mediaId) => ({ mediaId })) }),
              entity(4, "LINK", { url: "https://cli.github.com" }),
              entity(5, "POLL", {}),
            ],
          },
        },
      })
    );
    expect(post.kind).toBe("article");
    expect(post.title).toBe("用 Opus 搭开发团队（完整教程）");
    expect(post.text).toBe(
      [
        "怎么搭一支 AI 开发团队，7 步：https://x.com/i/article/2109705772569423873",
        "【X 长文】用 Opus 搭开发团队（完整教程）",
        "从一个 issue 出发。",
        "> 并行越多，越要协调。",
        "【嵌入的帖子】https://x.com/i/status/2102435511222890900",
        "# 1. 准备",
        "1. 装 git\n2. 装 gh（链接：https://cli.github.com）\n- 架构师\n- 测试",
        "```bash\ngh auth login\n```",
        "---",
        "[配图 1]\n[配图 2]\n[配图 3]\n[配图 4]\n[配图 5]\n[配图 6，没存]\n[配图 7，没存]\n[媒体，没读到]",
        "## 收尾",
      ].join("\n\n")
    );
    // 题图 + 前 5 张配图（一共 6 张，和网页文章一样）
    expect(post.images.map((i) => i.url)).toEqual(["cover", "m1", "m2", "m3", "m4", "m5"].map((id) => `https://pbs.twimg.com/media/${id}.jpg`));
    expect(post.images[0]).toEqual({ url: "https://pbs.twimg.com/media/cover.jpg", width: 1280, height: 720 });
    expect(post.notes).toEqual([
      "读不到回复的内容，只有回复数",
      "长文里有 7 张配图，只存了前 5 张（正文里标了「没存」的没看到）",
      "长文里有 1 个图片 / 视频没读到",
      "长文里有读不出的内容块（POLL），跳过了",
    ]);
    // 互动数照旧是帖子的
    expect(post.stats).toEqual({ views: 51000, likes: 400, collects: 220, comments: 12, shares: 35 });

    // entityMap 是原样 Draft.js 的 { key: value } 也认；太长截到 3 万字
    const long = mapFxTweet(fx({ article: { title: "长", content: { blocks: [block("unstyled", "字".repeat(40_000))], entityMap: {} } } }));
    expect(Array.from(long.text)).toHaveLength(30_000);
    expect(long.notes).toContain("长文太长，只读了前 3 万字");
    const keyed = mapFxTweet(fx({ article: { title: "T", content: { blocks: [atomic(7)], entityMap: { 7: { type: "DIVIDER", data: {} } } } } }));
    expect(keyed.text.endsWith("【X 长文】T\n\n---")).toBe(true);
    // 只有标题
    expect(mapFxTweet(fx({ article: { title: "只有标题" } })).notes).toContain("长文只读到了标题，没读到正文");
  });

  it("提到的帖子：引用的（FxTwitter 带着完整的，直接用）、正文里贴的帖子链接（去重、不算自己）、长文里嵌的；别人的长文链接读不到记一句", () => {
    const read = readFxTweet(
      fx({
        text: "看这两条 https://x.com/a/status/111111 和 https://twitter.com/b/status/222222?s=20，还有 https://x.com/a/status/111111/photo/1。自己 https://x.com/me/status/2106418403661779046 别人的长文 https://x.com/i/article/999999",
        quote: fx({ id: "333333", text: "被引用的原话 https://x.com/c/status/444444", author: { name: "被引", screen_name: "quoted" }, media: { photos: [{ url: "https://pbs.twimg.com/q.jpg" }] } }),
        article: { id: "888888", title: "T", content: { blocks: [{ type: "atomic", text: " ", entityRanges: [{ key: 0 }] }], entityMap: [{ key: "0", value: { type: "TWEET", data: { tweetId: "555555" } } }] } },
      })
    );
    expect(read.mentions.map(({ id, how }) => [id, how])).toEqual([
      ["333333", "quote"],
      ["111111", "link"],
      ["222222", "link"],
      ["555555", "embed"],
    ]);
    // 引用的帖子已经读到（它自己又提到的帖子也记着）；别的要另外读
    expect(read.mentions[0].read?.post).toMatchObject({ externalId: "333333", text: "被引用的原话 https://x.com/c/status/444444", author: { name: "被引 @quoted" } });
    expect(read.mentions[0].read?.mentions.map((m) => m.id)).toEqual(["444444"]);
    expect(read.mentions.slice(1).every((m) => !m.read)).toBe(true);
    expect(read.post.notes).toContain("正文里链接了 1 篇 X 长文（x.com/i/article/…），这种链接读不到内容");
    expect(read.post.text).not.toContain("被引用的原话");

    // 引用的是长文、FxTwitter 只带了开头：另外读一次
    const partial = readFxTweet(fx({ quote: fx({ id: "333333", article: { title: "引用的长文", preview_text: "开头" } }) }));
    expect(partial.mentions).toEqual([{ id: "333333", how: "quote", read: undefined }]);
    // 引用的帖子看不到（FxTwitter 给墓碑）：不再去读，原因记下来
    expect(readFxTweet(fx({ quote: { type: "tombstone", reason: "deleted", id: "333333" } })).mentions).toEqual([{ id: "333333", how: "quote", unavailable: "被删了" }]);
    expect(withMentions(mapFxTweet(fx()), [{ id: "333333", how: "quote", unavailable: "被删了" }]).notes).toContain("引用的帖子没读到（https://x.com/i/status/333333）：被删了");
    expect(readFxTweet(fx({ quote: { type: "tombstone", reason: "private" } })).post.notes).toContain("引用的帖子没读到：是私密账号，或者要登录才能看");
    // 自己长文的链接不算
    const notes: string[] = [];
    expect(linkedPostIds("7 步：https://x.com/i/article/888888", "1", "888888", notes)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("把提到的帖子并进来：正文接在后面（嵌的放回原位），图存到 6 张，自己没视频用它们的；读不到、没往下读、超出条数的记一句", () => {
    const sub = (id: string, over: Record<string, unknown> = {}) => ({ post: mapFxTweet(fx({ id, text: `帖子 ${id}`, author: { name: `作者${id}`, screen_name: `u${id}` }, ...over })), mentions: [] });
    const photos = (n: number, p: string) => ({ photos: Array.from({ length: n }, (_, i) => ({ url: `https://pbs.twimg.com/${p}${i}.jpg` })) });
    const main = mapFxTweet(fx({ text: "主帖", article: { title: "长文", content: { blocks: [{ type: "atomic", text: " ", entityRanges: [{ key: 0 }] }, { type: "unstyled", text: "结尾" }], entityMap: [{ key: "0", value: { type: "TWEET", data: { tweetId: "5" } } }] } } }));
    expect(main.text).toBe("主帖\n\n【X 长文】长文\n\n【嵌入的帖子】https://x.com/i/status/5\n\n结尾");
    const quote = sub("1", { media: photos(4, "q") });
    quote.post.notes.push("这是回 @x 的一条回复，上文没读到");
    const merged = withMentions(
      main,
      [
        { id: "1", how: "quote", read: { ...quote, mentions: [{ id: "9", how: "link" }, { id: "9", how: "embed" }] } },
        { id: "2", how: "link", read: sub("2", { media: { videos: [video] } }) },
        { id: "3", how: "link", read: sub("3", { media: { videos: [video], ...photos(3, "v") } }) },
        { id: "4", how: "link", error: new SourceFetchError("x") },
        { id: "6", how: "link", error: new TypeError("fetch failed") },
        { id: "5", how: "embed", read: sub("5") },
      ],
      2
    );
    expect(merged.text).toBe(
      "主帖\n\n【X 长文】长文\n\n【长文里嵌的帖子：作者5 @u5】\n帖子 5\n\n结尾" +
        "\n\n【引用的帖子：作者1 @u1】\n帖子 1\n\n【正文里链接的帖子：作者2 @u2】\n帖子 2\n\n【正文里链接的帖子：作者3 @u3】\n帖子 3"
    );
    expect(merged.kind).toBe("article");
    // 4 张引用的图 + 2 的视频封面 = 5，3 的只放得下 1 张
    expect(merged.images.map((i) => i.url)).toEqual(["q0", "q1", "q2", "q3"].map((n) => `https://pbs.twimg.com/${n}.jpg`).concat(["https://pbs.twimg.com/thumb.jpg", "https://pbs.twimg.com/v0.jpg"]));
    expect(merged.video?.url).toBe("https://video.twimg.com/v/720.mp4");
    expect(merged.notes).toEqual([
      "读不到回复的内容，只有回复数",
      "引用的帖子（作者1 @u1）：这是回 @x 的一条回复，上文没读到",
      "引用的帖子（作者1 @u1）又提到了 1 条帖子，没再往下读",
      "视频是正文里链接的帖子（作者2 @u2）里的",
      "正文里链接的帖子（作者3 @u3）有 2 张图没存",
      "正文里链接的帖子（作者3 @u3）里也有视频，没存",
      "正文里链接的帖子没读到（https://x.com/i/status/4）：可能被删了，或者是私密账号",
      "正文里链接的帖子没读到（https://x.com/i/status/6）：网络出错",
      "还提到了 2 条别的帖子没读（一条最多跟着读 5 条）",
    ]);
    // 互动数、作者、标签还是自己的
    expect(merged).toMatchObject({ externalId: "2106418403661779046", author: { name: "某某 @someone" }, stats: main.stats, title: "长文" });

    // 纯文字帖引用了视频帖：变成视频帖；只贴了一条链接、自己没字：标题用被引的
    const plain = mapFxTweet(fx({ text: "https://x.com/a/status/2" }));
    expect(plain.title).toBe("");
    const asVideo = withMentions(plain, [{ id: "2", how: "link", read: sub("2", { media: { videos: [video] } }) }]);
    expect(asVideo).toMatchObject({ kind: "video", title: "帖子 2" });
    expect(withMentions(mapFxTweet(fx({ text: "看图" })), [{ id: "1", how: "quote", read: sub("1", { media: photos(1, "q") }) }]).kind).toBe("image");
  });

  it("读一条帖子时跟着读它提到的帖子：引用的不再请求，链接的走同样两条路，读不到的不影响这条", async () => {
    const tweets: Record<string, unknown> = {
      "111111": fx({ id: "111111", text: "链接里的帖子", author: { screen_name: "linked" } }),
    };
    const fetchMock = vi.fn(async (url: string) => {
      const id = /status\/(\d+)/.exec(url)?.[1] ?? /id=(\d+)/.exec(url)?.[1] ?? "";
      if (id === ref.externalId) return json({ code: 200, tweet: fx({ text: "主帖 https://x.com/a/status/111111 https://x.com/a/status/404404", quote: fx({ id: "333333", text: "引用的", author: { screen_name: "q" } }) }) });
      if (tweets[id]) return json({ code: 200, tweet: tweets[id] });
      return url.includes("fxtwitter") ? json({ code: 404, message: "NOT_FOUND", tweet: null }, 404) : json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const post = await fetchXPost(ref);
    expect(post.text).toBe("主帖 https://x.com/a/status/111111 https://x.com/a/status/404404\n\n【引用的帖子：@q】\n引用的\n\n【正文里链接的帖子：@linked】\n链接里的帖子");
    expect(post.notes).toContain("正文里链接的帖子没读到（https://x.com/i/status/404404）：可能被删了，或者是私密账号");
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(["https://api.fxtwitter.com/i/status/111111", "https://api.fxtwitter.com/i/status/2106418403661779046", "https://api.fxtwitter.com/i/status/404404"]);

    // 超过 5 条的不读
    const many = Array.from({ length: 7 }, (_, i) => `https://x.com/a/status/${700000 + i}`).join(" ");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith(ref.externalId) ? json({ code: 200, tweet: fx({ text: many }) }) : json({ code: 200, tweet: fx({ id: /\d+$/.exec(url)![0] }) }))));
    const capped = await fetchXPost(ref);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(6);
    expect(capped.notes).toContain("还提到了 2 条别的帖子没读（一条最多跟着读 5 条）");
  });

  it("备用接口：引用的帖子它也带着（只有正文和图），正文里的帖子链接照样跟着读", () => {
    const read = readSyndicationTweet({
      __typename: "Tweet",
      id_str: "100000",
      text: "转一下 https://t.co/a",
      entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://twitter.com/x/status/200000" }] },
      user: { screen_name: "me" },
      quoted_tweet: { id_str: "300000", text: "被引用的", user: { name: "Q", screen_name: "q" }, mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/q.jpg" }] },
    });
    expect(read.mentions.map((m) => [m.id, m.how])).toEqual([
      ["300000", "quote"],
      ["200000", "link"],
    ]);
    expect(read.mentions[0].read?.post).toMatchObject({ text: "被引用的", kind: "image", author: { name: "Q @q" } });
    // 备用接口那句不重复记
    expect(withMentions(read.post, [{ id: "300000", how: "quote", read: read.mentions[0].read }]).notes).toEqual(["这次走的是备用接口：没有转发数、书签数、浏览量", "读不到回复的内容，只有回复数"]);
  });

  it("备用接口读到长文：只有标题、开头一段和题图，记一句后面没读到", () => {
    const post = mapSyndicationTweet({
      __typename: "Tweet",
      id_str: "2109980695787454803",
      text: "7 步搭团队：https://t.co/7jiKhDNMB9",
      entities: { urls: [{ url: "https://t.co/7jiKhDNMB9", expanded_url: "http://x.com/i/article/2109705772569423873" }] },
      user: { screen_name: "a" },
      article: {
        title: "用 Opus 搭开发团队",
        preview_text: "从一个 issue 出发。\n并行越多",
        cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/media/cover.jpg", original_img_width: 1278, original_img_height: 511 } },
      },
    });
    expect(post).toMatchObject({ kind: "article", title: "用 Opus 搭开发团队", images: [{ url: "https://pbs.twimg.com/media/cover.jpg", width: 1278, height: 511 }] });
    expect(post.text).toBe("7 步搭团队：http://x.com/i/article/2109705772569423873\n\n【X 长文】用 Opus 搭开发团队\n\n从一个 issue 出发。\n并行越多……");
    expect(post.notes).toContain("这是一条 X 长文，备用接口只读到了标题和开头一段，后面的正文和配图没读到");
  });

  it("备用接口（官方嵌入）：t.co 短链换回原链接、图片占位短链去掉；没有转发 / 书签 / 浏览量并记一句", () => {
    const post = mapSyndicationTweet({
      __typename: "Tweet",
      id_str: "643211948184596480",
      text: "看这篇 https://t.co/aaa https://t.co/img",
      entities: { urls: [{ url: "https://t.co/aaa", expanded_url: "https://example.com/post" }], media: [{ url: "https://t.co/img" }] },
      favorite_count: 138,
      conversation_count: 4,
      created_at: "2015-09-13T23:57:33.000Z",
      user: { id_str: "549749560", name: "某号", screen_name: "handle" },
      mediaDetails: [{ type: "video", media_url_https: "https://pbs.twimg.com/t.jpg", original_info: { width: 640, height: 640 }, video_info: { duration_millis: 12922, variants: [{ content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/a.mp4" }] } }],
      note_tweet: { id: "n" },
    });
    expect(post).toMatchObject({
      kind: "video",
      title: "看这篇",
      text: "看这篇 https://example.com/post",
      author: { id: "549749560", name: "某号 @handle" },
      publishedAt: "2015-09-13T23:57:33.000Z",
      stats: { views: null, likes: 138, collects: null, comments: 4, shares: null },
      video: { url: "https://video.twimg.com/a.mp4", width: 640, height: 640, durationS: 12.9 },
      notes: ["这次走的是备用接口：没有转发数、书签数、浏览量", "读不到回复的内容，只有回复数", "这是一条长帖，只读到了开头一段"],
    });
    // 敏感 / 太老的帖子返回 {}；墓碑（TweetTombstone）也是读不到
    expect(() => mapSyndicationTweet({})).toThrow(SourceFetchError);
    expect(() => mapSyndicationTweet({ __typename: "TweetTombstone", id_str: "1" })).toThrow(/读不到/);
  });

  it("嵌入接口的校验参数按帖子 id 算（和官方脚本一致）", () => {
    expect(syndicationToken("643211948184596480")).toBe(((643211948184596480 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ""));
    expect(syndicationToken("2106418403661779046")).toMatch(/^[0-9a-z]+$/);
  });

  it("先问 FxTwitter；它不行（限流、返回网页）就换官方嵌入接口", async () => {
    const ok = vi.fn(async (url: string) => (url.includes("fxtwitter") ? json({ code: 200, tweet: fx() }) : json({})));
    vi.stubGlobal("fetch", ok);
    expect((await fetchXPost(ref)).stats.views).toBe(51000);
    expect(ok.mock.calls.map((c) => c[0])).toEqual(["https://api.fxtwitter.com/i/status/2106418403661779046"]);

    const html = vi.fn(async (url: string) =>
      url.includes("fxtwitter") ? new Response("<html>rate limited</html>", { status: 429 }) : json({ __typename: "Tweet", id_str: ref.externalId, text: "备用读到的", favorite_count: 3, user: { screen_name: "a" } })
    );
    vi.stubGlobal("fetch", html);
    const post = await fetchXPost(ref);
    expect(post.text).toBe("备用读到的");
    expect(html.mock.calls[1][0]).toBe(`https://cdn.syndication.twimg.com/tweet-result?id=${ref.externalId}&token=${syndicationToken(ref.externalId)}&lang=en`);
  });

  it("帖子不在了 / 私密账号：直接报读不到，不再换接口；两边都没有也是读不到", async () => {
    const gone = vi.fn(async () => json({ code: 404, message: "NOT_FOUND", tweet: null }, 404));
    vi.stubGlobal("fetch", gone);
    await expect(fetchXPost(ref)).rejects.toThrow(SourceFetchError);
    expect(gone).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 401, message: "PRIVATE_TWEET" }, 401)));
    await expect(fetchXPost(ref)).rejects.toThrow("这条 X 帖子是私密账号发的，读不了。可以把帖子文字贴进来直接分析");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("fxtwitter") ? Promise.reject(new TypeError("fetch failed")) : json({}))));
    await expect(fetchXPost(ref)).rejects.toThrow(SourceFetchError);
    vi.restoreAllMocks();
  });
});

vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
