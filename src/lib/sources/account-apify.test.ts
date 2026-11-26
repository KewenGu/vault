import { describe, expect, it } from "vitest";
import { PROFILE_ACTORS, readDouyinProfile, readTikTokProfile } from "./account-apify";
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

  it("actor 的输入：TikTok 给用户名，抖音给主页链接，都按最近的 N 条要", () => {
    expect(PROFILE_ACTORS.tiktok.input(tedtoks, 50)).toEqual({ profiles: ["tedtoks"], resultsPerPage: 50, profileSorting: "latest", profileScrapeSections: ["videos"] });
    const ref: AccountRef = { platform: "douyin", externalId: "MS4wLjABAAAAk1tZ", handle: "", url: "https://www.douyin.com/user/MS4wLjABAAAAk1tZ" };
    expect(PROFILE_ACTORS.douyin.input(ref, 20)).toEqual({ profileUrls: ["https://www.douyin.com/user/MS4wLjABAAAAk1tZ"], maxPostsPerProfile: 20 });
  });
});
