import { describe, expect, it } from "vitest";
import { indentRow, insertAfter, insertLines, moveSubtree, outdentRow, removeSubtree, subtreeEnd, type Row } from "./map-edit";
import { MAP_MAX } from "./map-nodes";

/** "1 甲 / 2 甲一 / …" → 行（key 就是字） */
const rows = (...lines: string[]): Row[] => lines.map((l) => ({ key: l.slice(2), depth: Number(l[0]), text: l.slice(2), item: null }));
const show = (list: Row[] | null | undefined) => list?.map((r) => `${r.depth} ${r.text}`);
const TREE = rows("1 甲", "2 甲一", "3 甲一a", "2 甲二", "1 乙", "2 乙一", "1 丙");

describe("subtreeEnd", () => {
  it("covers a row and everything deeper right after it", () => {
    expect(subtreeEnd(TREE, 0)).toBe(4);
    expect(subtreeEnd(TREE, 1)).toBe(3);
    expect(subtreeEnd(TREE, 6)).toBe(7);
  });
});

describe("indentRow / outdentRow", () => {
  it("indents a row together with what is under it", () => {
    expect(show(indentRow(TREE, 4))).toEqual(["1 甲", "2 甲一", "3 甲一a", "2 甲二", "2 乙", "3 乙一", "1 丙"]);
  });

  it("refuses to indent the first row, a row already under the previous one, or past the last level", () => {
    expect(indentRow(TREE, 0)).toBeNull();
    expect(indentRow(TREE, 1)).toBeNull();
    const deep = rows("1 a", "2 b", "3 c", "4 d", "5 e", "6 f", "6 g");
    expect(deep[5].depth).toBe(MAP_MAX.depth);
    expect(indentRow(deep, 6)).toBeNull();
  });

  it("outdents a row with its subtree, leaving its later siblings under the old parent", () => {
    // 甲一 提到第一层：甲二 还在 甲 下面，甲一 排到 甲 这一支的后面
    expect(show(outdentRow(TREE, 1))).toEqual(["1 甲", "2 甲二", "1 甲一", "2 甲一a", "1 乙", "2 乙一", "1 丙"]);
    expect(show(outdentRow(TREE, 3))).toEqual(["1 甲", "2 甲一", "3 甲一a", "1 甲二", "1 乙", "2 乙一", "1 丙"]);
    expect(outdentRow(TREE, 0)).toBeNull();
  });

  it("indenting right after an outdent puts the row back under the same parent", () => {
    const out = outdentRow(TREE, 1)!;
    const at = out.findIndex((r) => r.text === "甲一");
    expect(show(indentRow(out, at))).toEqual(["1 甲", "2 甲二", "2 甲一", "3 甲一a", "1 乙", "2 乙一", "1 丙"]);
  });
});

describe("insertAfter", () => {
  it("adds a sibling after a leaf, and a first child under a row that has children", () => {
    expect(show(insertAfter(TREE, 3, { key: "n", text: "新" })?.rows)).toEqual(["1 甲", "2 甲一", "3 甲一a", "2 甲二", "2 新", "1 乙", "2 乙一", "1 丙"]);
    const under = insertAfter(TREE, 0, { key: "n", text: "新" });
    expect(show(under?.rows)?.slice(0, 3)).toEqual(["1 甲", "2 新", "2 甲一"]);
    expect(under?.index).toBe(1);
  });

  it("starts an empty outline, and stops at the row limit", () => {
    expect(show(insertAfter([], -1, { key: "n", text: "" })?.rows)).toEqual(["1 "]);
    const full = Array.from({ length: MAP_MAX.nodes }, (_, i) => ({ key: `k${i}`, depth: 1, text: "x", item: null }));
    expect(insertAfter(full, 0, { key: "n", text: "" })).toBeNull();
  });
});

describe("removeSubtree", () => {
  it("removes a row with everything under it", () => {
    expect(show(removeSubtree(TREE, 0))).toEqual(["1 乙", "2 乙一", "1 丙"]);
    expect(show(removeSubtree(TREE, 2))).toEqual(["1 甲", "2 甲一", "2 甲二", "1 乙", "2 乙一", "1 丙"]);
    expect(removeSubtree(TREE, 9)).toBeNull();
  });
});

describe("moveSubtree", () => {
  it("swaps a row and its subtree with the next / previous sibling", () => {
    const down = moveSubtree(TREE, 0, 1);
    expect(show(down?.rows)).toEqual(["1 乙", "2 乙一", "1 甲", "2 甲一", "3 甲一a", "2 甲二", "1 丙"]);
    expect(down?.index).toBe(2);
    const up = moveSubtree(TREE, 3, -1);
    expect(show(up?.rows)).toEqual(["1 甲", "2 甲二", "2 甲一", "3 甲一a", "1 乙", "2 乙一", "1 丙"]);
    expect(up?.index).toBe(1);
  });

  it("does not move past the edge of its parent", () => {
    expect(moveSubtree(TREE, 0, -1)).toBeNull();
    expect(moveSubtree(TREE, 6, 1)).toBeNull();
    // 甲二 是 甲 下面的最后一个：下一行 乙 是上一层的，不是它的兄弟
    expect(moveSubtree(TREE, 3, 1)).toBeNull();
    expect(moveSubtree(TREE, 5, -1)).toBeNull();
  });
});

describe("insertLines", () => {
  it("puts pasted lines after the row's subtree, shifted to the row's level", () => {
    let n = 0;
    const res = insertLines(TREE, 1, [{ depth: 1, text: "贴一" }, { depth: 2, text: "贴一a" }, { depth: 1, text: "贴二" }], () => `p${++n}`);
    expect(show(res.rows)).toEqual(["1 甲", "2 甲一", "3 甲一a", "2 贴一", "3 贴一a", "2 贴二", "2 甲二", "1 乙", "2 乙一", "1 丙"]);
    expect(res.inserted).toBe(3);
    expect(res.rows[res.index].text).toBe("贴二");
  });

  it("only takes what still fits under the row limit", () => {
    const nearly = Array.from({ length: MAP_MAX.nodes - 1 }, (_, i) => ({ key: `k${i}`, depth: 1, text: "x", item: null }));
    const res = insertLines(nearly, 0, [{ depth: 1, text: "a" }, { depth: 1, text: "b" }], () => "p");
    expect(res.inserted).toBe(1);
    expect(res.rows).toHaveLength(MAP_MAX.nodes);
  });
});
