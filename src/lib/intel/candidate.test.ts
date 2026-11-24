import { describe, expect, it } from "vitest";
import { agoLabel, excerptOf, httpUrl, matchesKeywords, parseKeywords } from "./candidate";

describe("情报：候选的小工具", () => {
  it("开头：空白压成一个空格，超了截断加省略号，表情不切成两半", () => {
    expect(excerptOf("  第一段\n\n第二段\t完 ")).toBe("第一段 第二段 完");
    expect(excerptOf("😀".repeat(5), 3)).toBe("😀😀😀…");
    expect(excerptOf("短的", 3)).toBe("短的");
    expect(excerptOf("")).toBe("");
  });

  it("只认 http(s) 的地址", () => {
    expect(httpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(httpUrl("javascript:alert(1)")).toBeNull();
    expect(httpUrl("不是地址")).toBeNull();
    expect(httpUrl(null)).toBeNull();
  });

  it("关键词：空白隔开，引号里的算一个，去重，不分大小写", () => {
    expect(parseKeywords('agent  MCP "tool use" Agent “computer use”')).toEqual(["agent", "mcp", "tool use", "computer use"]);
    expect(parseKeywords("   ")).toEqual([]);
    expect(parseKeywords(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "))).toHaveLength(12);
  });

  it("带任意一个关键词就算；英文按整词（复数也算），中文按字面；没给关键词全要", () => {
    const c = (title: string, excerpt = "") => ({ title, excerpt });
    expect(matchesKeywords(c("随便什么"), [])).toBe(true);
    expect(matchesKeywords(c("Building AI Agents with MCP"), ["agent"])).toBe(true);
    expect(matchesKeywords(c("A new reagent for chemistry"), ["agent"])).toBe(false);
    expect(matchesKeywords(c("标题没有", "but the body mentions tool use here"), ["tool use"])).toBe(true);
    expect(matchesKeywords(c("本地跑大模型的经验"), ["大模型"])).toBe(true);
    expect(matchesKeywords(c("C++ tips"), ["c++"])).toBe(true);
    expect(matchesKeywords(c("Nothing relevant"), ["agent", "mcp"])).toBe(false);
  });

  it("多久以前", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    expect(agoLabel("2026-11-24T11:59:50Z", now)).toBe("刚刚");
    expect(agoLabel("2026-11-24T11:15:00Z", now)).toBe("45 分钟前");
    expect(agoLabel("2026-11-24T05:00:00Z", now)).toBe("7 小时前");
    expect(agoLabel("2026-11-21T12:00:00Z", now)).toBe("3 天前");
    // 服务器和来源的钟差一点、时间在「未来」：不出负数
    expect(agoLabel("2026-11-24T12:00:30Z", now)).toBe("刚刚");
    expect(agoLabel(null, now)).toBe("");
    expect(agoLabel("不是时间", now)).toBe("");
  });
});
