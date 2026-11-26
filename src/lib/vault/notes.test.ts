import { describe, expect, it } from "vitest";
import { NOTE_MAX, cleanAt, cleanBody, cleanQuote, noteLine, notesIndexText } from "./notes";

describe("cleaning what comes from the browser", () => {
  it("flattens a selection into one line and caps it", () => {
    expect(cleanQuote("  应急金\n   存 3–6\t个月  ")).toBe("应急金 存 3–6 个月");
    expect(Array.from(cleanQuote("长".repeat(5000)))).toHaveLength(NOTE_MAX.quote);
    expect(cleanQuote(undefined)).toBe("");
    expect(cleanQuote(42)).toBe("");
  });

  it("keeps the line breaks of what the user wrote, without runs of blank lines", () => {
    expect(cleanBody("  第一行\r\n第二行\n\n\n\n第三行  ")).toBe("第一行\n第二行\n\n第三行");
    expect(Array.from(cleanBody("长".repeat(9000)))).toHaveLength(NOTE_MAX.body);
    expect(cleanBody(null)).toBe("");
  });

  it("only accepts a sane number of seconds", () => {
    expect(cleanAt(72.456)).toBe(72.46);
    expect(cleanAt(0)).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "72", null, undefined, 999_999]) expect(cleanAt(bad)).toBeNull();
  });
});

describe("noteLine / notesIndexText", () => {
  it("says which part is quoted and which part the user wrote", () => {
    expect(noteLine({ quote: "应急金放货币基金", body: "我放余额宝\n够用", at: 72 })).toBe("划线（1:12）：「应急金放货币基金」——他写的：我放余额宝 够用");
    expect(noteLine({ quote: "别拿应急的钱去投资", body: "", at: null })).toBe("划线：「别拿应急的钱去投资」");
    expect(noteLine({ quote: "", body: "下个月开始定投", at: null })).toBe("他写的：下个月开始定投");
  });

  it("joins everything searchable", () => {
    expect(notesIndexText([{ quote: "甲", body: "乙" }, { quote: "", body: "丙" }, { quote: "丁", body: "" }])).toBe("甲\n乙\n丙\n丁");
    expect(notesIndexText([])).toBe("");
  });
});
