import { describe, expect, it } from "vitest";
import type { Deco, Stroke } from "./journal-doc";
import { HEAD, addDeco, addPoint, addStroke, anchorAt, cleanWord, hitsStroke, normalizeAngle, patchDeco, raiseDeco, rehomeDecos, rehomeStrokes, removeDeco, strokePath, toAnchored, type Tops } from "./journal-deco";

const deco = (id: string, over: Partial<Deco> = {}): Deco => ({ id, kind: "sticker", anchor: "t1", x: 100, y: 20, r: 0, s: 1, data: { name: "leaf" }, ...over });
const stroke = (id: string, anchor: string, points: number[], width = 2.5): Stroke => ({ id, anchor, color: "#5f8f6e", width, opacity: 1, points });

describe("stickers", () => {
  it("a new one goes on top, with tidy numbers", () => {
    const out = addDeco([deco("a")], deco("b", { x: 10.26, y: 3.04, r: 370, s: 99 }));
    expect(out.map((d) => d.id)).toEqual(["a", "b"]);
    expect(out[1]).toMatchObject({ x: 10.3, y: 3, r: 10, s: 5 });
  });

  it("refuses the 301st", () => {
    const full = Array.from({ length: 300 }, (_, i) => deco(`d${i}`));
    expect(addDeco(full, deco("x"))).toBe(full);
  });

  it("moves, turns and resizes within limits; data is merged, not replaced", () => {
    const [d] = patchDeco([deco("a", { kind: "word", data: { text: "今日份的风", look: "fresh" } })], "a", { x: 5.55, r: -190, s: 0.01, data: { look: "y2k" } });
    expect(d).toMatchObject({ x: 5.6, y: 20, r: 170, s: 0.3, data: { text: "今日份的风", look: "y2k" } });
    expect(patchDeco([deco("a")], "nope", { x: 1 })).toEqual([deco("a")]);
  });

  it("angles wrap into (-180, 180]", () => {
    expect([0, 180, 181, -180, 540, -15, 359.96].map(normalizeAngle)).toEqual([0, 180, -179, 180, 180, -15, 0]);
  });

  it("raise brings one to the top; remove takes it away", () => {
    const three = [deco("a"), deco("b"), deco("c")];
    expect(raiseDeco(three, "a").map((d) => d.id)).toEqual(["b", "c", "a"]);
    expect(raiseDeco(three, "c")).toBe(three);
    expect(removeDeco(three, "b").map((d) => d.id)).toEqual(["a", "c"]);
  });

  it("art words are one line of at most 40 characters", () => {
    expect(cleanWord("今日份\n的风")).toBe("今日份 的风");
    expect(Array.from(cleanWord("字".repeat(50)))).toHaveLength(40);
  });
});

describe("which block something hangs on", () => {
  // 页眉 0–90，文字 t1 106–190，照片 p1 206–420，文字 t2 436–500（块之间隔 16）
  const tops: Tops = [
    { id: HEAD, top: 0, height: 90 },
    { id: "t1", top: 106, height: 84 },
    { id: "p1", top: 206, height: 214 },
    { id: "t2", top: 436, height: 64 },
  ];

  it("a point belongs to the last block that starts at or above it", () => {
    expect(anchorAt(tops, 50)).toBe(HEAD);
    expect(anchorAt(tops, 106)).toBe("t1");
    expect(anchorAt(tops, 300)).toBe("p1");
    expect(anchorAt(tops, 9999)).toBe("t2");
    expect(anchorAt(tops, -20)).toBe(HEAD);
    expect(toAnchored(tops, 180.04, 300)).toEqual({ anchor: "p1", x: 180, y: 94 });
  });

  it("when a photo is removed, what was stuck on it lands where the photo used to start", () => {
    const alive = new Set([HEAD, "t1", "t2"]);
    const decos = [deco("on-photo", { anchor: "p1", y: 10 }), deco("on-text", { anchor: "t1", y: 5 })];
    const out = rehomeDecos(decos, alive, tops);
    // 接在上面那段字（高 84）后面
    expect(out[0]).toMatchObject({ anchor: "t1", y: 94 });
    expect(out[1]).toBe(decos[1]);
  });

  it("two paragraphs merging: things beside the lower one follow its text to the end of the upper one", () => {
    // 删掉照片后 t2 并进 t1：p1 和 t2 都没了。t2 的字接在 t1 的字后面，贴在它旁边的也接过去
    const alive = new Set([HEAD, "t1"]);
    const out = rehomeDecos([deco("x", { anchor: "t2", y: 14 }), deco("y", { anchor: "p1", y: 30 })], alive, tops);
    expect(out[0]).toMatchObject({ anchor: "t1", y: 98 });
    expect(out[1]).toMatchObject({ anchor: "t1", y: 114 });
  });

  it("nothing to do returns the same array", () => {
    const decos = [deco("a")];
    expect(rehomeDecos(decos, new Set([HEAD, "t1"]), tops)).toBe(decos);
  });

  it("something pointing at a block nobody has heard of goes to the header, untouched", () => {
    expect(rehomeDecos([deco("x", { anchor: "ghost", y: 14 })], new Set([HEAD, "t1"]), tops)[0]).toMatchObject({ anchor: HEAD, y: 14 });
    expect(rehomeDecos([deco("x", { anchor: "ghost", y: 14 })], new Set([HEAD]), [])[0]).toMatchObject({ anchor: HEAD, y: 14 });
  });

  it("strokes move the same way: every y shifts, x stays", () => {
    const alive = new Set([HEAD, "t1", "t2"]);
    const [s] = rehomeStrokes([stroke("s", "p1", [10, 20, 30, 40])], alive, tops);
    expect(s).toMatchObject({ anchor: "t1", points: [10, 104, 30, 124] });
  });
});

describe("drawing", () => {
  it("skips points that barely moved", () => {
    const points: number[] = [];
    expect(addPoint(points, 10.04, 10)).toBe(true);
    expect(addPoint(points, 10.5, 10.5)).toBe(false);
    expect(addPoint(points, 14, 10)).toBe(true);
    expect(points).toEqual([10, 10, 14, 10]);
  });

  it("stops at the per-stroke limit", () => {
    const points = Array.from({ length: 8000 }, (_, i) => i * 3);
    expect(addPoint(points, 1e6, 1e6)).toBe(false);
    expect(points).toHaveLength(8000);
  });

  it("draws a dot for a tap and a smooth curve for a stroke", () => {
    expect(strokePath([5, 5])).toBe("M5 5l0.1 0");
    expect(strokePath([0, 0, 10, 0, 10, 10])).toBe("M0 0Q10 0 10 5L10 10");
    expect(strokePath([])).toBe("");
  });

  it("the eraser hits a stroke anywhere along it, not only at its points", () => {
    const s = stroke("s", "t1", [0, 0, 100, 0]);
    expect(hitsStroke(s, 50, 5, 6)).toBe(true);
    expect(hitsStroke(s, 50, 12, 6)).toBe(false);
    expect(hitsStroke(s, 108, 0, 6)).toBe(false);
    // 粗的荧光笔更容易碰到
    expect(hitsStroke(stroke("m", "t1", [0, 0, 100, 0], 12), 50, 11, 6)).toBe(true);
    expect(hitsStroke(stroke("dot", "t1", [5, 5]), 7, 7, 6)).toBe(true);
  });

  it("keeps at most 600 strokes and ignores an empty one", () => {
    const full = Array.from({ length: 600 }, (_, i) => stroke(`s${i}`, "t1", [0, 0]));
    expect(addStroke(full, stroke("x", "t1", [1, 1]))).toBe(full);
    expect(addStroke([], stroke("x", "t1", []))).toEqual([]);
    expect(addStroke([], stroke("x", "t1", [1, 1]))).toHaveLength(1);
  });
});
