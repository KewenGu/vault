import { describe, expect, it, vi } from "vitest";
import { accountLabel, accountLabelInText, listedFallbackTitle } from "./account";
import { PROFILE_ACTORS, readBilibiliProfile, readDouyinProfile, readInstagramProfile, readTikTokProfile, readWeiboProfile, readXhsProfile, readYouTubeChannel } from "./account-apify";
import { parseLink } from "./link";
import type { AccountRef } from "./link";

/** 两个 actor 2026-11-26 实际返回的形状（各留用得到的字段）。 */
const tiktok = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `第 ${id} 条 #tag`,
  createTime: 1795632831,
  authorMeta: { id: "6690665153388332037", name: "tedtoks", nickName: "TED Talks", signature: "Ideas change everything.\n", video: 1206 },
  webVideoUrl: `https://www.tiktok.com/@tedtoks/video/${id}`,
  isSlideshow: false,
  isPinned: false,
  ...over,
});
const douyin = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "video",
  text: `标题 ${id} #英语学习视频`,
  title: `标题 ${id}`,
  createTime: 1754266200,
  isPinned: false,
  authorMeta: { id: "1929015166249580", secUid: "MS4wLjABAAAAk1tZ", name: "木木英语", username: "63970939507", customUsername: null, signature: "📚英语爱好者", awemeCount: 212, videoCount: 212 },
  ...over,
});

describe("列一个账号的作品：认 actor 的输出", () => {
  const tedtoks: AccountRef = { platform: "tiktok", externalId: "tedtoks", handle: "@tedtoks", url: "https://www.tiktok.com/@tedtoks" };

  it("TikTok：账号信息 + 每一条作品；图集、置顶认得出；转发栏里别人的视频不要；重复的只留一条", () => {
    const { info, posts } = readTikTokProfile(
      [
        tiktok("7712184252778990879"),
        tiktok("7711842789918543135", { isSlideshow: true, isPinned: true, createTime: 1795559400 }),
        tiktok("7700000000000000001", { authorMeta: { name: "someone_else", nickName: "别人" } }),
        tiktok("7712184252778990879", { isPinned: true }),
        { id: "不是作品" },
      ],
      tedtoks
    );
    expect(info).toEqual({ name: "TED Talks", handle: "@tedtoks", bio: "Ideas change everything.", postCount: 1206 });
    expect(posts).toEqual([
      { externalId: "7712184252778990879", url: "https://www.tiktok.com/@tedtoks/video/7712184252778990879", kind: "video", title: "第 7712184252778990879 条", publishedAt: "2026-11-25T18:53:51.000Z", pinned: true },
      { externalId: "7711842789918543135", url: "https://www.tiktok.com/@tedtoks/video/7711842789918543135", kind: "image", title: "第 7711842789918543135 条", publishedAt: "2026-11-24T22:30:00.000Z", pinned: true },
    ]);
  });

  it("TikTok：链接和单独贴那条视频认出来的是同一个（去重靠它）；什么都没有时不编账号信息", () => {
    expect(readTikTokProfile([tiktok("7712184252778990879", { authorMeta: {} })], tedtoks).posts[0].url).toBe("https://www.tiktok.com/@tedtoks/video/7712184252778990879");
    expect(readTikTokProfile([], tedtoks)).toEqual({ info: null, posts: [] });
  });

  it("抖音：视频是 /video/<id>、图文是 /note/<id>；账号用抖音号当称呼", () => {
    const { info, posts } = readDouyinProfile([douyin("7534316807973260587", { isPinned: true }), douyin("7524662531407793447", { type: "imageText", title: "", createTime: 0 })]);
    expect(info).toEqual({ name: "木木英语", handle: "抖音号 63970939507", bio: "📚英语爱好者", postCount: 212 });
    expect(posts).toEqual([
      { externalId: "7534316807973260587", url: "https://www.douyin.com/video/7534316807973260587", kind: "video", title: "标题 7534316807973260587", publishedAt: "2025-08-04T00:10:00.000Z", pinned: true },
      { externalId: "7524662531407793447", url: "https://www.douyin.com/note/7524662531407793447", kind: "image", title: "标题 7524662531407793447", publishedAt: null, pinned: false },
    ]);
  });

  it("小红书：链接是不带口令的 /explore/<id>（读的时候按 id 走 Apify）；没有标题的用正文第一行；别人的笔记不要", () => {
    const me: AccountRef = { platform: "xiaohongshu", externalId: "5c0892a5000000000500f3b6", handle: "", url: "https://www.xiaohongshu.com/user/profile/5c0892a5000000000500f3b6" };
    const row = (id: string, over: Record<string, unknown> = {}) => ({ operation: "list_user_notes", note_id: id, note_type: "image", title: `标题 ${id.slice(-2)}`, summary: "正文第一行 #话题[话题]#\n第二行", publish_time: 1795509021, author_user_id: me.externalId, author_name: "艺文搭搭", is_pinned: false, ...over });
    const { info, posts } = readXhsProfile([row("6b055607000000002b010f45", { is_pinned: true }), row("6B05555E0000000024031B2D", { note_type: "video", title: "" }), row("6b00000000000000000000aa", { author_user_id: "000000000000000000000000" }), { note_id: "不是笔记" }], me);
    expect(info).toEqual({ name: "艺文搭搭", handle: "", bio: "", postCount: null });
    expect(posts).toEqual([
      { externalId: "6b055607000000002b010f45", url: "https://www.xiaohongshu.com/explore/6b055607000000002b010f45", kind: "image", title: "标题 45", publishedAt: "2026-11-24T08:30:21.000Z", pinned: true },
      { externalId: "6b05555e0000000024031b2d", url: "https://www.xiaohongshu.com/explore/6b05555e0000000024031b2d", kind: "video", title: "正文第一行", publishedAt: "2026-11-24T08:30:21.000Z", pinned: false },
    ]);
    expect(PROFILE_ACTORS.xiaohongshu.input(me, 50)).toEqual({ operation: "list_user_notes", profile_url: me.url, max_items: 50, auto_paginate: true });
    expect(PROFILE_ACTORS.xiaohongshu.actor()).toBe("socialdatax~socialdatax-xhs-data-api");
  });

  it("Instagram：帖子和 Reels 都是 /p/<短码>；和别人合发的也要；actor 说没读到的那一行不算", () => {
    const me: AccountRef = { platform: "instagram", externalId: "natgeo", handle: "@natgeo", url: "https://www.instagram.com/natgeo/" };
    const row = (code: string, over: Record<string, unknown> = {}) => ({ id: "1", type: "Image", shortCode: code, caption: "第一行 #tag\n第二行", url: `https://www.instagram.com/p/${code}/`, timestamp: "2026-11-25T20:59:16.000Z", ownerFullName: " National Geographic ", ownerUsername: "NatGeo", isPinned: false, ...over });
    const { info, posts } = readInstagramProfile([row("DgLcatkmlPq", { type: "Sidecar", isPinned: true }), row("DgKwETOIeau", { type: "Video", ownerUsername: "someone_else", ownerFullName: "别人", timestamp: "" }), { shortCode: "不是 短码" }], me);
    expect(info).toEqual({ name: "National Geographic", handle: "@NatGeo", bio: "", postCount: null });
    expect(posts).toEqual([
      { externalId: "DgLcatkmlPq", url: "https://www.instagram.com/p/DgLcatkmlPq/", kind: "image", title: "第一行", publishedAt: "2026-11-25T20:59:16.000Z", pinned: true },
      { externalId: "DgKwETOIeau", url: "https://www.instagram.com/p/DgKwETOIeau/", kind: "video", title: "第一行", publishedAt: null, pinned: false },
    ]);
    // 账号不存在 / 私密：actor 给一行 error，没有帖子 → 当成没读到账号
    expect(readInstagramProfile([{ error: "no_items", errorDescription: "Empty or private data for provided input" }], me)).toEqual({ info: null, posts: [] });
    // 全是合发的：名字用链接里的用户名
    expect(readInstagramProfile([row("DgKwETOIeau", { ownerUsername: "someone_else" })], me).info).toEqual({ name: "", handle: "@natgeo", bio: "", postCount: null });
    expect(PROFILE_ACTORS.instagram.input(me, 50)).toEqual({ directUrls: ["https://www.instagram.com/natgeo/"], resultsType: "posts", resultsLimit: 50, addParentData: false });
  });

  it("YouTube：视频是 watch?v=、Shorts 是 /shorts/（和单独贴链接认出来的一样）；频道信息每一行都带着", () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "video", title: ` 视频 ${id} `, url: `https://www.youtube.com/watch?v=${id}`, date: "2026-11-22T02:02:12.000Z", channelName: "3Blue1Brown", channelUsername: "3blue1brown", channelId: "UCYO_jab_esuFRV4b17AJtAw", channelDescription: " 讲数学的 ", channelTotalVideos: 250, duration: "00:13:38", ...over });
    const { info, posts } = readYouTubeChannel([row("zqzk43bSdDI"), row("0IZcjWtWmDA", { type: "shorts", date: null }), row("zqzk43bSdDI"), row("太短")]);
    expect(info).toEqual({ name: "3Blue1Brown", handle: "@3blue1brown", bio: "讲数学的", postCount: 250 });
    expect(posts).toEqual([
      { externalId: "zqzk43bSdDI", url: "https://www.youtube.com/watch?v=zqzk43bSdDI", kind: "video", title: "视频 zqzk43bSdDI", publishedAt: "2026-11-22T02:02:12.000Z", pinned: false },
      { externalId: "0IZcjWtWmDA", url: "https://www.youtube.com/shorts/0IZcjWtWmDA", kind: "video", title: "视频 0IZcjWtWmDA", publishedAt: null, pinned: false },
    ]);
    // 视频和 Shorts 各要 N 条（所以最多收两倍的条数），直播回放不要，按最新的排
    const ref: AccountRef = { platform: "youtube", externalId: "@3blue1brown", handle: "@3blue1brown", url: "https://www.youtube.com/@3blue1brown" };
    expect(PROFILE_ACTORS.youtube.input(ref, 20)).toEqual({ startUrls: [{ url: ref.url }], maxResults: 20, maxResultsShorts: 20, maxResultStreams: 0, sortVideosBy: "NEWEST" });
    expect(PROFILE_ACTORS.youtube.rowsPerPost).toBe(2);
  });

  it("B 站：只要投稿的视频，链接是 bilibili.com/video/<BV 号>（和单独贴链接整理出来的一样）；联合投稿里别人名下的不要", () => {
    const me: AccountRef = { platform: "bilibili", externalId: "88461692", handle: "", url: "https://space.bilibili.com/88461692" };
    const row = (bv: string, over: Record<string, unknown> = {}) => ({ operation: "list_user_videos", content_id: bv, title: ` 【官方双语】${bv} `, publish_time: 1790389800, duration_seconds: 2031, share_url: `https://www.bilibili.com/video/${bv}`, author_user_id: "88461692", author_name: "3Blue1Brown", ...over });
    const { info, posts } = readBilibiliProfile([row("BV1u7hQ6rEQB"), row("BV1HBnH6JEAZ", { publish_time: null }), row("BV1znaf61EnS", { author_user_id: "1" }), row("cv12345"), row("BV1u7hQ6rEQB")], me);
    expect(info).toEqual({ name: "3Blue1Brown", handle: "", bio: "", postCount: null });
    expect(posts).toEqual([
      { externalId: "BV1u7hQ6rEQB", url: "https://www.bilibili.com/video/BV1u7hQ6rEQB", kind: "video", title: "【官方双语】BV1u7hQ6rEQB", publishedAt: "2026-09-26T02:30:00.000Z", pinned: false },
      { externalId: "BV1HBnH6JEAZ", url: "https://www.bilibili.com/video/BV1HBnH6JEAZ", kind: "video", title: "【官方双语】BV1HBnH6JEAZ", publishedAt: null, pinned: false },
    ]);
    // 清单里的链接已经是整理过的写法：存进去和用户自己贴的是同一条
    expect(parseLink(posts[0].url)?.url).toBe(posts[0].url);
    expect(PROFILE_ACTORS.bilibili.input(me, 50)).toEqual({ operation: "list_user_videos", user_id: "88461692", max_items: 50, auto_paginate: true });
    expect(PROFILE_ACTORS.bilibili.actor()).toBe("socialdatax~socialdatax-bilibili-data-api");
  });

  it("微博：链接是 weibo.com/<用户 id>/<短码>（和单独贴链接认出来的一样）；他转发的别人的微博不要、记一句；文字 / 配图 / 视频认得出", () => {
    const me: AccountRef = { platform: "weibo", externalId: "1195230310", handle: "", url: "https://weibo.com/u/1195230310" };
    const row = (id: string, over: Record<string, unknown> = {}) => ({ operation: "list_user_posts", post_id: id, content: "第一期#声生不息天涯共此时# 上线。看了吗？ http://t.cn/AXTnnihj \u200b\u200b\u200b", publish_time: 1795705523, post_url: "https://weibo.com/1195230310/x", play_count: null, images: [], author_user_id: "1195230310", author_name: "何炅", is_pinned: false, ...over });
    const rows = [
      row("5367769270326327", { images: [{ url: "https://wx3.sinaimg.cn/orj960/a.jpg", width: 960, height: 1616 }], is_pinned: true }),
      row("5355165151400213", { content: "致敬！", play_count: 15980526 }),
      row("5308563330698653", { content: "【#你好，明天#｜#当校门口开卖纸质短剧#】“纸质短剧”悄然流行" }),
      // 他转发的：actor 给的是被转发的那条原文，作者是别人
      row("5311881821818034", { author_user_id: "1296241304", author_name: "苏醒AllenSu", post_url: "https://weibo.com/1296241304/R4Z6e7CX8" }),
      row("5367769270326327"),
      { post_id: "不是微博" },
    ];
    const { info, posts, notes } = readWeiboProfile(rows, me);
    expect(info).toEqual({ name: "何炅", handle: "", bio: "", postCount: null });
    expect(posts).toEqual([
      { externalId: "5367769270326327", url: "https://weibo.com/1195230310/RsqZh1mTl", kind: "image", title: "第一期声生不息天涯共此时 上线。看了吗？", publishedAt: "2026-11-26T15:05:23.000Z", pinned: true },
      { externalId: "5355165151400213", url: "https://weibo.com/1195230310/Rn9635Sg5", kind: "video", title: "致敬！", publishedAt: "2026-11-26T15:05:23.000Z", pinned: false },
      { externalId: "5308563330698653", url: "https://weibo.com/1195230310/R3ALP2VKB", kind: "text", title: "你好，明天｜当校门口开卖纸质短剧", publishedAt: "2026-11-26T15:05:23.000Z", pinned: false },
    ]);
    expect(notes).toEqual(["清单里有 1 条是他转发的别人的微博，没存"]);
    for (const p of posts) expect(parseLink(p.url)).toEqual({ platform: "weibo", externalId: p.externalId, url: p.url });
    // 个性域名的账号不知道数字 id：清单里谁发的最多就是谁
    const custom = readWeiboProfile(rows, { platform: "weibo", externalId: "hejiong", handle: "", url: "https://weibo.com/hejiong" });
    expect(custom.posts.map((p) => p.externalId)).toEqual(["5367769270326327", "5355165151400213", "5308563330698653"]);
    expect(readWeiboProfile([], me)).toEqual({ info: null, posts: [], notes: [] });
    expect(PROFILE_ACTORS.weibo.input(me, 50)).toEqual({ operation: "list_user_posts", profile_url: "https://weibo.com/u/1195230310", max_items: 50, auto_paginate: true });
  });

  it("平台叫什么：B 站不在认得的平台里，名字单独给；夹在中文里时英文的两边留空格", () => {
    expect([accountLabel("bilibili"), accountLabel("x"), accountLabel("douyin")]).toEqual(["B 站", "X", "抖音"]);
    expect(`这个${accountLabelInText("bilibili")}账号`).toBe("这个 B 站账号");
    expect(`这个${accountLabelInText("tiktok")}账号`).toBe("这个 TikTok 账号");
    expect(`这个${accountLabelInText("xiaohongshu")}账号`).toBe("这个小红书账号");
    expect([listedFallbackTitle("bilibili", "video"), listedFallbackTitle("x", "text"), listedFallbackTitle("douyin", "video")]).toEqual(["B 站视频", "X 帖子", "抖音视频"]);
  });

  it("读单条用的 actor 换了，列主页的跟着换；也可以单独换", () => {
    expect(PROFILE_ACTORS.instagram.actor()).toBe("apify~instagram-scraper");
    expect(PROFILE_ACTORS.youtube.actor()).toBe("streamers~youtube-scraper");
    vi.stubEnv("APIFY_INSTAGRAM_ACTOR", "a~ig");
    vi.stubEnv("APIFY_YOUTUBE_ACTOR", "a~yt");
    expect([PROFILE_ACTORS.instagram.actor(), PROFILE_ACTORS.youtube.actor()]).toEqual(["a~ig", "a~yt"]);
    vi.stubEnv("APIFY_INSTAGRAM_PROFILE_ACTOR", "b~ig");
    vi.stubEnv("APIFY_YOUTUBE_PROFILE_ACTOR", "b~yt");
    expect([PROFILE_ACTORS.instagram.actor(), PROFILE_ACTORS.youtube.actor()]).toEqual(["b~ig", "b~yt"]);
    expect(PROFILE_ACTORS.weibo.actor()).toBe("socialdatax~socialdatax-weibo-data-api");
    vi.stubEnv("APIFY_WEIBO_ACTOR", "a~wb");
    expect(PROFILE_ACTORS.weibo.actor()).toBe("a~wb");
    vi.stubEnv("APIFY_WEIBO_PROFILE_ACTOR", "b~wb");
    expect(PROFILE_ACTORS.weibo.actor()).toBe("b~wb");
    vi.unstubAllEnvs();
  });

  it("actor 的输入：TikTok 给用户名，抖音给主页链接，都按最近的 N 条要", () => {
    expect(PROFILE_ACTORS.tiktok.input(tedtoks, 50)).toEqual({ profiles: ["tedtoks"], resultsPerPage: 50, profileSorting: "latest", profileScrapeSections: ["videos"] });
    const ref: AccountRef = { platform: "douyin", externalId: "MS4wLjABAAAAk1tZ", handle: "", url: "https://www.douyin.com/user/MS4wLjABAAAAk1tZ" };
    expect(PROFILE_ACTORS.douyin.input(ref, 20)).toEqual({ profileUrls: ["https://www.douyin.com/user/MS4wLjABAAAAk1tZ"], maxPostsPerProfile: 20 });
  });
});
