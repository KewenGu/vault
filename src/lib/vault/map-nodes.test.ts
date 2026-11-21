import { describe, expect, it } from "vitest";
import { MAP_MAX, cleanMapNodes, cleanMapTitle, cleanSources, fixDepths, mapOutlineText, parseMapOutline } from "./map-nodes";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("cleanMapNodes", () => {
  it("keeps well-formed rows, drops empty ones and anything that is not a node", () => {
    expect(cleanMapNodes([{ depth: 1, text: "  应急金 \n 先存 ", item: A }, { depth: 2, text: "   " }, "x", null, { depth: 2, text: "3–6 个月", item: "not-an-id" }])).toEqual([
      { depth: 1, text: "应急金 先存", item: A },
      { depth: 2, text: "3–6 个月", item: null },
    ]);
    expect(cleanMapNodes("nope")).toEqual([]);
  });

  it("straightens depths: starts at 1, one level deeper at a time, never past the last level", () => {
    expect(cleanMapNodes([{ depth: 3, text: "甲" }, { depth: 5, text: "乙" }, { depth: 0, text: "丙" }, { depth: 1.4, text: "丁" }]).map((n) => n.depth)).toEqual([1, 2, 1, 1]);
    const deep = fixDepths(Array.from({ length: 9 }, (_, i) => ({ depth: i + 1 })));
    expect(deep.map((n) => n.depth)).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 6]);
  });

  it("caps text length and the number of rows", () => {
    expect(cleanMapNodes([{ depth: 1, text: "长".repeat(500) }])[0].text).toHaveLength(MAP_MAX.text);
    expect(cleanMapNodes(Array.from({ length: 400 }, (_, i) => ({ depth: 1, text: `n${i}` })))).toHaveLength(MAP_MAX.nodes);
  });
});

describe("cleanMapTitle / cleanSources", () => {
  it("flattens and caps the title; keeps unique ids only", () => {
    expect(cleanMapTitle("  理财\n入门  ")).toBe("理财 入门");
    expect(cleanMapTitle(42)).toBe("");
    expect(cleanSources([A, "x", A, B, null])).toEqual([A, B]);
    expect(cleanSources("nope")).toEqual([]);
  });
});

describe("the outline as the model sees and writes it", () => {
  const nodes = [
    { depth: 1, text: "先存应急金", item: A },
    { depth: 2, text: "3–6 个月开支", item: null },
    { depth: 1, text: "再配保险", item: B },
  ];
  const labels = new Map([[A, "S1"]]);
  const ids = new Map([["S1", A], ["S2", B]]);

  it("writes indented lines with the source label of materials that are in this conversation", () => {
    expect(mapOutlineText(nodes, (id) => labels.get(id) ?? null)).toBe("- 先存应急金 [S1]\n  - 3–6 个月开支\n- 再配保险");
  });

  it("reads source labels back into item ids and ignores labels it does not know", () => {
    const parsed = parseMapOutline("- 先存应急金 [S1]\n  - 3–6 个月开支\n  - 放货币基金 【S2】\n- 定投 [S9]\n- 追热点 [S1][S2]", "理财", (l) => ids.get(l) ?? null);
    expect(parsed).toEqual([
      { depth: 1, text: "先存应急金", item: A },
      { depth: 2, text: "3–6 个月开支", item: null },
      { depth: 2, text: "放货币基金", item: B },
      { depth: 1, text: "定投", item: null },
      { depth: 1, text: "追热点", item: A },
    ]);
  });

  it("round-trips a map through the model's notation", () => {
    const text = mapOutlineText(nodes, (id) => ({ [A]: "S1", [B]: "S2" })[id] ?? null);
    expect(parseMapOutline(text, "理财", (l) => ids.get(l) ?? null)).toEqual(nodes);
  });

  it("drops a root line only when it repeats the title; a real single branch stays", () => {
    expect(parseMapOutline("- 理财\n  - 存钱\n  - 投资", "理财", () => null).map((n) => `${n.depth} ${n.text}`)).toEqual(["1 存钱", "1 投资"]);
    expect(parseMapOutline("- 存钱\n  - 应急金\n  - 定投", "理财", () => null).map((n) => `${n.depth} ${n.text}`)).toEqual(["1 存钱", "2 应急金", "2 定投"]);
  });

  it("keeps the label when the line is long enough to hit the text cap", () => {
    const [n] = parseMapOutline(`- ${"长".repeat(MAP_MAX.text + 10)} [S1]`, "t", (l) => ids.get(l) ?? null);
    expect(n.item).toBe(A);
    expect(n.text).toHaveLength(MAP_MAX.text);
  });
});
