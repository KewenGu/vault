import { describe, expect, it } from "vitest";
import { OUTLINE_MAX, buildOutlineTree, outlineNodeSchema, outlineToText, parseOutline } from "./outline";

const TEXT = `
- [0:20] 为什么会内耗
  - 把别人的评价当成事实
  - 想太多、做太少
    - 反复预演最坏的结果
- [1:05] 九个方法
  - [1:02:03] 别人的评价只是信息
- 怎么坚持
`;

describe("parseOutline", () => {
  it("reads depth from indentation and the time in front of a node", () => {
    expect(parseOutline(TEXT)).toEqual([
      { depth: 1, at: 20, text: "为什么会内耗" },
      { depth: 2, at: null, text: "把别人的评价当成事实" },
      { depth: 2, at: null, text: "想太多、做太少" },
      { depth: 3, at: null, text: "反复预演最坏的结果" },
      { depth: 1, at: 65, text: "九个方法" },
      { depth: 2, at: 3723, text: "别人的评价只是信息" },
      { depth: 1, at: null, text: "怎么坚持" },
    ]);
  });

  it("does not need exactly two spaces per level: tabs, four spaces and other bullets work", () => {
    const nodes = parseOutline("* 甲\n\t• 甲一\n\t\t- 甲一 a\n* 乙\n    - 乙一\n        - 乙一 a\n    - 乙二");
    expect(nodes.map((n) => `${n.depth} ${n.text}`)).toEqual(["1 甲", "2 甲一", "3 甲一 a", "1 乙", "2 乙一", "3 乙一 a", "2 乙二"]);
  });

  it("goes one level deeper at a time and folds anything past the last level into it", () => {
    const nodes = parseOutline("- 甲\n      - 跳着缩进的\n- 乙\n  - 2\n    - 3\n      - 4\n        - 5\n          - 6");
    expect(nodes.map((n) => n.depth)).toEqual([1, 2, 1, 2, 3, 4, 4, 4]);
    expect(nodes.every((n) => outlineNodeSchema.safeParse(n).success)).toBe(true);
  });

  it("keeps a time that is part of the text, and only reads the bracketed one in front", () => {
    expect(parseOutline("- 甲\n  - 营业到 22:30\n- 【0:45】乙")).toEqual([
      { depth: 1, at: null, text: "甲" },
      { depth: 2, at: null, text: "营业到 22:30" },
      { depth: 1, at: 45, text: "乙" },
    ]);
  });

  it("drops a root line the model wrote anyway and lifts the rest", () => {
    const nodes = parseOutline("- 停止精神内耗\n  - 原因\n    - 想太多\n  - 方法");
    expect(nodes.map((n) => `${n.depth} ${n.text}`)).toEqual(["1 原因", "2 想太多", "1 方法"]);
  });

  it("returns nothing for what is not a tree: empty, a flat list, a single branch", () => {
    expect(parseOutline("")).toEqual([]);
    expect(parseOutline("- 一\n- 二\n- 三")).toEqual([]);
    expect(parseOutline("- 只有一个分支\n  - 下面一点")).toEqual([]);
  });

  it("caps the number of nodes and the length of each", () => {
    const many = parseOutline(Array.from({ length: 80 }, (_, i) => (i % 2 ? `  - 子 ${i}` : `- 分支 ${i}`)).join("\n"));
    expect(many).toHaveLength(OUTLINE_MAX.nodes);
    expect(parseOutline(`- 甲\n  - ${"长".repeat(300)}\n- 乙`)[1].text).toHaveLength(OUTLINE_MAX.text);
  });
});

describe("buildOutlineTree", () => {
  it("nests each node under the nearest shallower one before it", () => {
    const tree = buildOutlineTree(parseOutline(TEXT));
    expect(tree.map((n) => n.text)).toEqual(["为什么会内耗", "九个方法", "怎么坚持"]);
    expect(tree[0].children.map((n) => n.text)).toEqual(["把别人的评价当成事实", "想太多、做太少"]);
    expect(tree[0].children[1].children[0]).toMatchObject({ id: 3, depth: 3, text: "反复预演最坏的结果", children: [] });
    expect(tree[1].children[0]).toMatchObject({ id: 5, at: 3723 });
  });

  it("copes with stored depths that skip levels", () => {
    const tree = buildOutlineTree([
      { depth: 3, at: null, text: "甲" },
      { depth: 4, at: null, text: "甲一" },
      { depth: 1, at: null, text: "乙" },
    ]);
    expect(tree.map((n) => `${n.depth} ${n.text}`)).toEqual(["1 甲", "1 乙"]);
    expect(tree[0].children.map((n) => `${n.depth} ${n.text}`)).toEqual(["2 甲一"]);
  });
});

describe("outlineToText", () => {
  it("writes an indented list with the title as the root, which parses back to the same outline", () => {
    const nodes = parseOutline(TEXT);
    const text = outlineToText("停止精神内耗", nodes);
    expect(text.split("\n").slice(0, 3)).toEqual(["- 停止精神内耗", "  - 为什么会内耗", "    - 把别人的评价当成事实"]);
    // 中心主题那一行会被当成多写的根去掉，剩下的层级不变（时间不写出去）
    expect(parseOutline(text)).toEqual(nodes.map((n) => ({ ...n, at: null })));
  });
});
