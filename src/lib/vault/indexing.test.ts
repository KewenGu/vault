import { describe, expect, it } from "vitest";
import { buildEmbeddingText, buildSearchText, type IndexInput } from "./indexing";
import { parseUnderstanding } from "./understand";

const understanding = {
  ...parseUnderstanding(
    "<title>低温慢煮牛排</title><type>recipe</type><category>food</category><summary>55 度两小时</summary><point><text>先腌再煮</text></point><outline>\n- 准备\n  - 提前一晚干腌\n- 收尾\n  - 铸铁锅两面各煎 40 秒\n</outline><field><label>食材</label><value>牛排\n海盐</value></field><quote>Low and slow</quote><entity><type>concept</type><name>低温慢煮</name><about>方法</about></entity><ocr>55°C / 2h</ocr>"
  ),
  gaps: [],
  model: "m",
};
const input: IndexInput = {
  title: "Sous Vide Steak",
  author: "Chef J",
  url: "https://www.youtube.com/watch?v=abc",
  note: "周末试试",
  post: { text: "full recipe below", hashtags: ["steak"] },
  userText: null,
  transcript: "[0:10] set the bath to 55 degrees",
  tags: ["牛排", "慢煮"],
  understanding,
};

describe("buildSearchText", () => {
  it("contains everything a person might search for", () => {
    const text = buildSearchText(input);
    for (const part of ["Sous Vide Steak", "低温慢煮牛排", "Chef J", "youtube.com", "周末试试", "食谱", "美食", "牛排 慢煮", "steak", "55 度两小时", "先腌再煮", "提前一晚干腌", "食材：牛排", "Low and slow", "低温慢煮", "full recipe below", "55°C / 2h", "set the bath to 55 degrees"]) {
      expect(text).toContain(part);
    }
    expect(buildSearchText({ ...input, post: { text: "a\u0000b", hashtags: [] } })).not.toContain("\u0000");
  });
});

describe("buildEmbeddingText", () => {
  it("is the distilled meaning, without the raw transcript", () => {
    const text = buildEmbeddingText(input);
    expect(text).toContain("低温慢煮牛排");
    expect(text).toContain("55 度两小时");
    expect(text).toContain("周末试试");
    expect(text).not.toContain("set the bath");
    // 大纲是要点的另一种排法，不再往向量的文字里放一遍
    expect(text).not.toContain("提前一晚干腌");
  });

  it("falls back to the raw text when there is no understanding", () => {
    expect(buildEmbeddingText({ ...input, understanding: null })).toContain("full recipe below");
  });

  it("the user's own highlights and annotations are searchable both ways", () => {
    const withNotes = { ...input, annotations: "别煎太久\n下次试 57 度" };
    expect(buildSearchText(withNotes)).toContain("别煎太久\n下次试 57 度");
    expect(buildEmbeddingText(withNotes)).toContain("下次试 57 度");
    expect(buildEmbeddingText({ ...withNotes, understanding: null })).toContain("下次试 57 度");
    // 没有笔记时和以前一样
    expect(buildSearchText({ ...input, annotations: "" })).toBe(buildSearchText(input));
    expect(buildEmbeddingText({ ...input, annotations: "" })).toBe(buildEmbeddingText(input));
  });
});
