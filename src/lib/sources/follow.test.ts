import { describe, it, expect, vi } from "vitest";
import { embedPlaceholder, followMentions, type Followed, type FollowDeps, type Mention } from "./follow";
import type { LinkRef } from "./link";
import { SourceFetchError, emptyStats, type FetchedPost, type SourcePlatform } from "./types";

const post = (platform: SourcePlatform, id: string, over: Partial<FetchedPost> = {}): FetchedPost => ({
  platform,
  externalId: id,
  kind: "text",
  title: `标题${id}`,
  text: `正文${id}`,
  author: { id: null, name: `作者${id}` },
  publishedAt: null,
  stats: emptyStats(),
  hashtags: [],
  topComments: [],
  images: [],
  video: null,
  music: null,
  notes: [],
  ...over,
});
const ref = (platform: SourcePlatform, id: string): LinkRef => ({ platform, externalId: id, url: `https://${platform}.example/${id}` });
const to = (platform: SourcePlatform, id: string, how: Mention["how"] = "link"): Mention => ({ how, url: `https://${platform}.example/${id}`, ref: ref(platform, id) });
const video = (id: string) => ({ url: `https://v.example/${id}.mp4`, durationS: 10 });
const img = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ url: `https://img.example/${p}${i}.jpg` }));

/** X 帖子按 id 查表；别的平台按 id 造一条。 */
function deps(xs: Record<string, Followed>, other: Record<string, Partial<FetchedPost> | Error> = {}): FollowDeps & { readX: ReturnType<typeof vi.fn>; readOther: ReturnType<typeof vi.fn> } {
  return {
    readX: vi.fn(async (r: LinkRef) => {
      const got = xs[r.externalId];
      if (!got) throw new SourceFetchError("这条 X 帖子读不到：可能被删了、账号设成了私密，或者链接不对。在 X 里重新点「分享 → 复制链接」再贴一次");
      return got;
    }),
    readOther: vi.fn(async (r: LinkRef) => {
      const o = other[r.externalId];
      if (o instanceof Error) throw o;
      return post(r.platform, r.externalId, o);
    }),
    resolve: vi.fn(async (url: string) => {
      if (url.includes("short")) return ref("xiaohongshu", "n1");
      if (url.includes("again")) return ref("x", "2");
      throw new SourceFetchError("没认出这是哪条帖子。在 X 里点分享");
    }),
  };
}

describe("收藏夹：跟着读帖子提到的东西", () => {
  it("一层一层往下读：帖子里的帖子、帖子里的链接都读，读过的不再读（互相引用不转圈），先父后子接在正文后面", async () => {
    const root: Followed = { post: post("x", "1", { text: "主帖" }), mentions: [to("x", "2", "quote"), to("web", "w1")] };
    const d = deps({
      "2": { post: post("x", "2"), mentions: [to("x", "3"), to("x", "1"), to("youtube", "yt1")] },
      "3": { post: post("x", "3"), mentions: [to("x", "2", "quote"), to("x", "4")] },
      "4": { post: post("x", "4"), mentions: [] },
    }, { w1: { title: "一篇博客", author: { id: null, name: "" } }, yt1: { title: "一个视频" } });
    const got = await followMentions(root, d);
    expect(got.text).toBe(
      [
        "主帖",
        "【引用的帖子：作者2】\n正文2",
        "【引用的帖子里链接的帖子：作者3】\n正文3",
        "【引用的帖子里链接的帖子里链接的帖子：作者4】\n正文4",
        "【引用的帖子里链接的 YouTube 内容：作者yt1】《一个视频》\n正文yt1",
        "【链接的网页：web.example】《一篇博客》\nw1".replace("w1", "正文w1"),
      ].join("\n\n")
    );
    // 每条只读一次，自己不读
    expect(d.readX.mock.calls.map((c) => c[0].externalId)).toEqual(["2", "3", "4"]);
    expect(d.readOther.mock.calls.map((c) => c[0].externalId).sort()).toEqual(["w1", "yt1"]);
    expect(got.notes).toEqual([]);
  });

  it("长文里嵌的帖子放回原位；短链先跟跳转（跳到读过的不再读）；读不到的写原因；超过条数的不读", async () => {
    const root: Followed = {
      post: post("x", "1", { kind: "article", text: `长文开头\n\n${embedPlaceholder("2")}\n\n长文结尾` }),
      mentions: [
        to("x", "2", "embed"),
        { how: "link", url: "http://short.example/a", ref: null },
        { how: "link", url: "http://again.example/b", ref: null },
        { how: "link", url: "http://unknown.example/c", ref: null },
        { how: "link", url: "https://x.com/i/article/9", ref: null, unavailable: "这是 X 长文本身的链接，查不到是哪条帖子发的" },
        to("x", "404"),
        to("web", "boom"),
        to("web", "w3"),
      ],
    };
    const d = deps({ "2": { post: post("x", "2", { notes: ["读不到回复的内容，只有回复数", "这是回 @x 的一条回复，上文没读到"] }), mentions: [to("x", "5")] } }, { boom: new Error("Jina 500") });
    const got = await followMentions(root, d, 6);
    expect(got.text).toBe("长文开头\n\n【长文里嵌的帖子：作者2】\n正文2\n\n长文结尾\n\n【链接的小红书内容：作者n1】《标题n1》\n正文n1");
    expect(got.notes).toEqual([
      "长文里嵌的帖子（作者2）：这是回 @x 的一条回复，上文没读到",
      "链接没读到（http://unknown.example/c）：没认出这是哪条帖子",
      "链接没读到（https://x.com/i/article/9）：这是 X 长文本身的链接，查不到是哪条帖子发的",
      "链接的帖子没读到（https://x.example/404）：这条 X 帖子读不到：可能被删了、账号设成了私密，或者链接不对",
      "链接的网页没读到（https://web.example/boom）：出错了（Jina 500）",
      "还有 2 条提到的帖子 / 链接没读（一条收藏最多跟着读 6 条）",
    ]);
    expect(d.resolve).toHaveBeenCalledTimes(3);
    // again 跳到的是 2（读过了），不再读；w3 和 2 里的 5 超出条数
    expect(d.readX.mock.calls.map((c) => c[0].externalId)).toEqual(["2", "404"]);
  });

  it("图片排在后面存到上限，自己没视频的用第一个读到的视频（连字幕），别的视频的字幕放进正文；长的截断", async () => {
    const root: Followed = { post: post("x", "1", { images: img(2, "m") }), mentions: [to("youtube", "a"), to("youtube", "b"), to("web", "long")] };
    const d = deps({}, {
      a: { kind: "video", images: img(1, "a"), video: video("a"), captions: "字幕A" },
      b: { kind: "video", images: img(10, "b"), video: video("b"), captions: "字幕B" },
      long: { text: "字".repeat(12_000) },
    });
    const got = await followMentions(root, d);
    expect(got.kind).toBe("video");
    expect(got.video?.url).toBe("https://v.example/a.mp4");
    expect(got.captions).toBe("字幕A");
    expect(got.images).toHaveLength(12);
    expect(got.text).toContain("【链接的 YouTube 内容：作者b】《标题b》\n正文b\n\n【字幕】\n字幕B");
    expect(got.text).not.toContain("字幕A");
    expect(Array.from(got.text.split("【链接的网页")[1]).length).toBeLessThan(10_100);
    expect(got.notes).toEqual([
      "视频是链接的 YouTube 内容（作者a）里的",
      "链接的 YouTube 内容（作者b）有 1 张图没存",
      "链接的 YouTube 内容（作者b）里也有视频，没存（字幕放进了正文）",
      "链接的网页（作者long）太长，只放了前 10,000 字",
    ]);
    // 互动数、作者、标题还是自己的
    expect(got).toMatchObject({ externalId: "1", author: { name: "作者1" }, title: "标题1" });
  });

  it("直接引用的帖子放到 3 万字（转发长文配一句话时，长文才是正文）；再往下引用的还是 1 万字", async () => {
    const d = deps({
      "2": { post: post("x", "2", { text: "长".repeat(12_000) }), mentions: [to("x", "3", "quote")] },
      "3": { post: post("x", "3", { text: "深".repeat(12_000) }), mentions: [] },
    });
    const got = await followMentions({ post: post("x", "1"), mentions: [to("x", "2", "quote")] }, d);
    expect(got.text).toContain("长".repeat(12_000));
    expect(got.text).not.toContain("深".repeat(10_001));
    expect(got.notes).toEqual(["引用的帖子里引用的帖子（作者3）太长，只放了前 10,000 字"]);
    const huge = deps({ "2": { post: post("x", "2", { text: "长".repeat(40_000) }), mentions: [] } });
    expect((await followMentions({ post: post("x", "1"), mentions: [to("x", "2", "quote")] }, huge)).notes).toEqual(["引用的帖子（作者2）太长，只放了前 30,000 字"]);
  });

  it("自己没字的（只贴了一条链接）：标题用读到的；文字帖引用了图片帖算图文", async () => {
    const d = deps({ "2": { post: post("x", "2", { images: img(1, "q") }), mentions: [] } });
    const got = await followMentions({ post: post("x", "1", { title: "" }), mentions: [to("x", "2", "quote")] }, d);
    expect(got).toMatchObject({ title: "标题2", kind: "image" });
  });
});
