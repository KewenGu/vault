import { describe, it, expect } from "vitest";
import { fallbackTitle, formatCount, hashtagsIn, readPost, statLabel, titleFromText, toCount } from "./types";

describe("收藏夹：共用的小工具", () => {
  it("互动数在各平台的叫法：X 是书签 / 回复 / 浏览，YouTube 是观看，其余是播放 / 收藏 / 评论", () => {
    expect((["views", "likes", "collects", "comments", "shares"] as const).map((k) => statLabel("x", k))).toEqual(["浏览", "点赞", "书签", "回复", "转发"]);
    expect((["views", "likes", "collects", "comments", "shares"] as const).map((k) => statLabel("tiktok", k))).toEqual(["播放", "点赞", "收藏", "评论", "转发"]);
    expect(statLabel("youtube", "views")).toBe("观看");
    expect(statLabel("web", "views")).toBe("浏览");
  });

  it("还没读到标题时的叫法：按平台和类型，英文平台名后面留空格", () => {
    expect(fallbackTitle("xiaohongshu", null)).toBe("小红书帖子");
    expect(fallbackTitle("douyin", "video")).toBe("抖音视频");
    expect(fallbackTitle("youtube", null)).toBe("YouTube 视频");
    expect(fallbackTitle("instagram", null)).toBe("Instagram 帖子");
    expect(fallbackTitle("x", "text")).toBe("X 帖子");
    expect(fallbackTitle("reddit", null)).toBe("Reddit 帖子");
    expect(fallbackTitle("web", null)).toBe("网页");
    expect(fallbackTitle("web", "article")).toBe("文章");
  });

  it("数字的显示：过万、过亿换单位，没有的是「—」", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(9999)).toBe("9,999");
    expect(formatCount(12345)).toBe("1.2万");
    expect(formatCount(3145993)).toBe("315万");
    expect(formatCount(440382990)).toBe("4.4亿");
    expect(formatCount(2_000_000_000)).toBe("20亿");
  });

  it("平台给的数字：字符串也认；没给、认不出、负数（Instagram 隐藏点赞是 -1）是 null", () => {
    expect(toCount("24654339")).toBe(24654339);
    expect(toCount(12.6)).toBe(13);
    expect(toCount(0)).toBe(0);
    expect(toCount(-1)).toBeNull();
    expect(toCount("")).toBeNull();
    expect(toCount("1.2万")).toBeNull();
    expect(toCount(undefined)).toBeNull();
  });

  it("没有标题的平台：文案第一行去掉话题和链接当标题，最多 60 个字", () => {
    expect(titleFromText("#职场 #AI工具\n开头这句太绝了 #反转 https://t.co/abc\n第二行")).toBe("开头这句太绝了");
    expect(Array.from(titleFromText("字".repeat(100)))).toHaveLength(60);
    expect(titleFromText("#只有话题")).toBe("");
  });

  it("正文里的 #话题：去重、按出现顺序；网址里的 # 和 &#39; 这类不算", () => {
    expect(hashtagsIn("#AI工具 讲 #deep_learning，再说一次 #AI工具 https://a.com/p#section it&#39;s")).toEqual(["AI工具", "deep_learning"]);
    expect(hashtagsIn("没有话题")).toEqual([]);
  });

  it("库里读出来的帖子：正文里的链接只留 http(s) 的；以前存的没有这一项，读出来是空", () => {
    expect(readPost({ text: "x" }).links).toEqual([]);
    expect(readPost({ links: [{ text: "论文", url: "https://arxiv.org/abs/1" }, { url: "https://b.example/" }, { text: "坏的", url: "javascript:alert(1)" }, null, "x"] }).links).toEqual([
      { text: "论文", url: "https://arxiv.org/abs/1" },
      { text: "", url: "https://b.example/" },
    ]);
  });
});
