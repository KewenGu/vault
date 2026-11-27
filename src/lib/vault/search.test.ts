import { describe, expect, it } from "vitest";
import { emptyStats, type PostSnapshot } from "@/lib/sources/types";
import { escapeLike, findSnippet, parseQuery } from "./search";

const post = { text: "", publishedAt: null, stats: emptyStats(), hashtags: [], topComments: [], music: null, notes: [], authorId: null, durationS: null, digestNotes: [], transcriptFrom: null, cuts: [], links: [] } satisfies PostSnapshot;

describe("parseQuery", () => {
  it("splits on whitespace, keeps quoted phrases whole and de-duplicates", () => {
    expect(parseQuery("三亚 酒店  三亚")).toEqual(["三亚", "酒店"]);
    expect(parseQuery('"sous vide" steak 「低温 慢煮」')).toEqual(["sous vide", "steak", "低温 慢煮"]);
    expect(parseQuery("Steak steak")).toEqual(["Steak"]);
  });

  it("drops single ASCII characters but keeps single CJK characters, and caps the count", () => {
    expect(parseQuery("a 茶 5")).toEqual(["茶"]);
    expect(parseQuery("一 二 三 四 五 六 七 八 九 十")).toHaveLength(8);
    expect(parseQuery("   ")).toEqual([]);
    // 英文里到处都有的词不当关键词（不然几乎每条都算命中）；放在引号里的、整句只有这种词的照旧
    expect(parseQuery("how to learn faster")).toEqual(["learn", "faster"]);
    expect(parseQuery('"how to" learn The Who')).toEqual(["how to", "learn"]);
    expect(parseQuery("How to")).toEqual(["How", "to"]);
  });

  it("escapes LIKE wildcards", () => {
    expect(escapeLike("100%_纯\\棉")).toBe("100\\%\\_纯\\\\棉");
  });
});

describe("findSnippet", () => {
  it("prefers the spoken line, with its time", () => {
    const item = { transcript: "[0:05] 先说结论\n[1:05] 第二家是三亚的艾迪逊酒店，泳池很大", understanding: null, userText: null, post };
    expect(findSnippet(item, ["艾迪逊"])).toEqual({ text: "第二家是三亚的艾迪逊酒店，泳池很大", at: 65, where: "口播" });
  });

  it("finds a node of the outline, after the points", () => {
    const understanding = { points: [{ at: null, text: "三家酒店各有侧重" }], outline: [{ depth: 2, at: 80, text: "艾迪逊：泳池最大" }], ocr: "" } as never;
    expect(findSnippet({ transcript: null, understanding, userText: null, post }, ["艾迪逊"])).toEqual({ text: "艾迪逊：泳池最大", at: 80, where: "大纲" });
  });

  it("falls back to text on images, then the body; null when nothing matches", () => {
    const understanding = { points: [], ocr: "订单号 A1234\n金额 ¥299" } as never;
    expect(findSnippet({ transcript: null, understanding, userText: null, post }, ["a1234"])).toEqual({ text: "订单号 A1234 金额 ¥299", at: null, where: "图中文字" });
    const long = `${"前".repeat(100)}关键词${"后".repeat(100)}`;
    const s = findSnippet({ transcript: null, understanding: null, userText: long, post }, ["关键词"]);
    expect(s?.where).toBe("正文");
    expect(s?.text.startsWith("…")).toBe(true);
    expect(s?.text.endsWith("…")).toBe(true);
    expect(s?.text).toContain("关键词");
    expect(findSnippet({ transcript: null, understanding: null, userText: "别的", post }, ["没有"])).toBeNull();
  });
});
