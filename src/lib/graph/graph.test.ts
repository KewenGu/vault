import { describe, expect, it } from "vitest";
import { buildGraph } from "./data";
import { ENTITY_MATCH_SIM, entityText, parseSameVerdicts, sortCandidates, type Candidate } from "./merge";

const cand = (id: string, name: string, similarity: number, aliases: string[] = []): Candidate => ({ id, name, aliases, summary: "", similarity });

describe("sortCandidates", () => {
  it("ignores candidates under the similarity floor", () => {
    expect(sortCandidates("苹果", [cand("1", "香蕉", ENTITY_MATCH_SIM - 0.01)])).toEqual({ exact: null, ask: [] });
  });

  it("accepts a same-name or same-alias candidate without asking", () => {
    expect(sortCandidates("apple", [cand("1", "Apple", 0.9)]).exact?.id).toBe("1");
    const byAlias = sortCandidates("苹果公司", [cand("2", "Apple", 0.8, ["苹果公司"]), cand("3", "Apple Music", 0.85)]);
    expect(byAlias.exact?.id).toBe("2");
    expect(byAlias.ask).toEqual([]);
  });

  it("asks about the two closest candidates otherwise", () => {
    const { exact, ask } = sortCandidates("苹果", [cand("1", "Apple", 0.8), cand("2", "苹果手机", 0.9), cand("3", "苹果派", 0.78)]);
    expect(exact).toBeNull();
    expect(ask.map((c) => c.id)).toEqual(["2", "1"]);
  });
});

describe("parseSameVerdicts", () => {
  it("marks only the listed pair numbers", () => {
    expect(parseSameVerdicts("<same>0, 2</same>", 3)).toEqual([true, false, true]);
    expect(parseSameVerdicts("<same></same>", 2)).toEqual([false, false]);
    // 没按格式回答、编号越界：都当「不是」
    expect(parseSameVerdicts("第 0 对是同一个", 2)).toEqual([false, false]);
    expect(parseSameVerdicts("<same>7</same>", 2)).toEqual([false, false]);
  });
});

describe("entityText", () => {
  it("joins name and description", () => {
    expect(entityText({ name: "三亚", about: "海南的城市" })).toBe("三亚：海南的城市");
    expect(entityText({ name: "三亚", about: "" })).toBe("三亚");
  });
});

describe("buildGraph", () => {
  const entities = [
    { id: "a", type: "place", name: "三亚", summary: "", aliases: [] },
    { id: "b", type: "org", name: "亚特兰蒂斯", summary: "", aliases: [] },
    { id: "c", type: "concept", name: "亲子游", summary: "", aliases: [] },
    { id: "x", type: "unknown", name: "坏类型", summary: "", aliases: [] },
  ];
  const itemEntities = [
    { item_id: "i1", entity_id: "a" },
    { item_id: "i1", entity_id: "b" },
    { item_id: "i1", entity_id: "c" },
    { item_id: "i2", entity_id: "a" },
    { item_id: "i2", entity_id: "c" },
    { item_id: "i2", entity_id: "x" },
  ];
  const edges = [
    { src_id: "b", dst_id: "a", relation: "located_in" },
    { src_id: "b", dst_id: "a", relation: "located_in" },
    { src_id: "a", dst_id: "a", relation: "related" },
  ];
  const graph = buildGraph(entities, itemEntities, edges);

  it("counts how many items mention each entity, most mentioned first", () => {
    expect(graph.nodes.map((n) => `${n.name}:${n.count}`)).toEqual(["三亚:2", "亲子游:2", "亚特兰蒂斯:1"]);
  });

  it("merges repeated stated relations and adds co-occurrence only where nothing is stated", () => {
    expect(graph.links).toEqual([
      { source: "b", target: "a", relation: "located_in", weight: 2 },
      { source: "a", target: "c", relation: "cooccur", weight: 2 },
      { source: "b", target: "c", relation: "cooccur", weight: 1 },
    ]);
  });
});
