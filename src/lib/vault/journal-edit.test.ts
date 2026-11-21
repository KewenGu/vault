import { describe, expect, it } from "vitest";
import type { Block } from "./journal-doc";
import { canMove, insertAfter, moveBlock, patchBlock, removeBlock, tidy } from "./journal-edit";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const text = (id: string, t = ""): Block => ({ id, type: "text", text: t });
const photo = (id: string, media = A): Block => ({ id, type: "photo", media, caption: "" });
const audio = (id: string, media = B): Block => ({ id, type: "audio", media });
const tail = () => "tail";
/** 一页的样子，写成一行好比对：文字是「t:内容」，照片 / 录音是它的 id */
const shape = (blocks: Block[]) => blocks.map((b) => (b.type === "text" ? `t:${b.text}` : b.id)).join(" | ");

describe("tidy", () => {
  it("an empty page gets a block to write in", () => {
    expect(tidy([], tail)).toEqual([text("tail")]);
  });

  it("the page always ends with text, and neighbouring text merges", () => {
    expect(shape(tidy([text("a", "一"), text("b", "二"), photo("p")], tail))).toBe("t:一\n二 | p | t:");
    expect(shape(tidy([text("a", "一"), text("b", "  "), text("c", "三")], tail))).toBe("t:一\n三");
  });

  it("leaves a tidy page alone", () => {
    const page = [text("a", "一"), photo("p"), text("b")];
    expect(tidy(page, tail)).toEqual(page);
  });
});

describe("insertAfter", () => {
  it("on a fresh page the new block goes above the blank text", () => {
    expect(shape(insertAfter([text("a")], "a", photo("p"), tail))).toBe("p | t:");
    expect(shape(insertAfter([], null, photo("p"), tail))).toBe("p | t:");
  });

  it("goes right after the block the cursor is in", () => {
    const page = [text("a", "一"), photo("p"), text("b", "二")];
    expect(shape(insertAfter(page, "a", audio("r"), tail))).toBe("t:一 | r | p | t:二");
    expect(shape(insertAfter(page, "p", audio("r"), tail))).toBe("t:一 | p | r | t:二");
  });

  it("with no cursor goes to the end, above the blank tail", () => {
    expect(shape(insertAfter([text("a", "一"), photo("p"), text("b")], null, audio("r"), tail))).toBe("t:一 | p | r | t:");
    expect(shape(insertAfter([text("a", "一")], null, audio("r"), tail))).toBe("t:一 | r | t:");
    expect(shape(insertAfter([text("a", "一")], "gone", audio("r"), tail))).toBe("t:一 | r | t:");
  });

  it("text placed after a recording joins the text below it", () => {
    expect(shape(insertAfter([audio("r"), text("b", "原来的")], "r", text("n", "录音里说的"), tail))).toBe("r | t:录音里说的\n原来的");
  });
});

describe("removeBlock / moveBlock", () => {
  const page = [text("a", "一"), photo("p"), text("b", "二"), audio("r"), text("c")];

  it("removing a file joins the text around it", () => {
    expect(shape(removeBlock(page, "p", tail))).toBe("t:一\n二 | r | t:");
    expect(shape(removeBlock([photo("p"), text("c")], "p", tail))).toBe("t:");
  });

  it("moves a file past its neighbour", () => {
    expect(shape(moveBlock(page, "r", -1, tail))).toBe("t:一 | p | r | t:二");
    expect(shape(moveBlock(page, "p", 1, tail))).toBe("t:一\n二 | p | r | t:");
  });

  it("does not move past either end, nor below the blank tail", () => {
    expect(moveBlock(page, "a", -1, tail)).toBe(page);
    expect(moveBlock(page, "r", 1, tail)).toBe(page);
    expect(canMove(page, "r", 1)).toBe(false);
    expect(canMove(page, "r", -1)).toBe(true);
    expect(canMove([photo("p"), text("c")], "p", -1)).toBe(false);
  });

  it("skips a blank text block between two files", () => {
    expect(shape(moveBlock([photo("p"), text("gap"), audio("r"), text("c")], "r", -1, tail))).toBe("r | p | t:");
  });
});

describe("patchBlock", () => {
  it("changes the text of a text block and the caption of a photo, nothing else", () => {
    const page = [text("a", "一"), photo("p")];
    expect(patchBlock(page, "a", { text: "改了" })[0]).toEqual(text("a", "改了"));
    expect(patchBlock(page, "p", { caption: "旧码头" })[1]).toMatchObject({ caption: "旧码头" });
    expect(patchBlock(page, "p", { text: "x" })).toEqual(page);
  });
});
