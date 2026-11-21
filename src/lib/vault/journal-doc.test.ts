import { describe, expect, it } from "vitest";
import { buildJournalSearchText, cleanDay, cleanDoc, cuesText, dayLabel, docMediaIds, emptyDoc, excerpt, isBlankDoc, planJournalUpload, searchTerms, snippet, transcriptCues, weekdayLabel } from "./journal-doc";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MB = 1024 * 1024;

describe("cleanDoc", () => {
  it("keeps valid blocks in order and drops what it cannot read", () => {
    const doc = cleanDoc({
      blocks: [
        { id: "t1", type: "text", text: "下午去了江边\r\n风很大" },
        { id: "p1", type: "photo", media: A, caption: "  旧码头\n15:42 " },
        { id: "a1", type: "audio", media: B },
        { id: "x1", type: "video", media: A },
        { id: "p2", type: "photo", media: "not-a-uuid" },
        { id: "bad id!", type: "text", text: "x" },
        "junk",
      ],
    });
    expect(doc.blocks).toEqual([
      { id: "t1", type: "text", text: "下午去了江边\n风很大" },
      { id: "p1", type: "photo", media: A, caption: "旧码头 15:42" },
      { id: "a1", type: "audio", media: B },
    ]);
  });

  it("keeps one block per id and one block per file", () => {
    const doc = cleanDoc({
      blocks: [
        { id: "t1", type: "text", text: "一" },
        { id: "t1", type: "text", text: "二" },
        { id: "p1", type: "photo", media: A },
        { id: "p2", type: "photo", media: A },
      ],
    });
    expect(doc.blocks.map((b) => b.id)).toEqual(["t1", "p1"]);
    expect(docMediaIds(doc)).toEqual([A]);
  });

  it("turns anything that is not a page into an empty page", () => {
    for (const raw of [null, undefined, "x", 3, [], { blocks: "no" }]) expect(cleanDoc(raw)).toEqual(emptyDoc());
  });

  it("caps a block of text", () => {
    const doc = cleanDoc({ blocks: [{ id: "t", type: "text", text: "字".repeat(30_000) }] });
    expect(doc.blocks[0]).toMatchObject({ text: "字".repeat(20_000) });
  });

  it("keeps the decoration layer through a save, and drops malformed pieces of it", () => {
    const doc = cleanDoc({
      blocks: [{ id: "t1", type: "text", text: "" }],
      decos: [
        { id: "d1", kind: "sticker", anchor: "t1", x: 12, y: -4, r: 15, data: { pack: "fresh", name: "leaf" } },
        { id: "d2", kind: "Sticker!", anchor: "t1", x: 0, y: 0 },
        { id: "d3", kind: "tape", anchor: "t1", x: "0", y: 0 },
      ],
      strokes: [
        { id: "s1", anchor: "t1", color: "#5f8f6e", width: 2.6, points: [1, 2, 3, 4] },
        { id: "s2", anchor: "t1", color: "red", width: 2, points: [1, 2] },
      ],
    });
    expect(doc.decos).toEqual([{ id: "d1", kind: "sticker", anchor: "t1", x: 12, y: -4, r: 15, s: 1, data: { pack: "fresh", name: "leaf" } }]);
    expect(doc.strokes).toEqual([{ id: "s1", anchor: "t1", color: "#5f8f6e", width: 2.6, opacity: 1, points: [1, 2, 3, 4] }]);
  });
});

describe("what a page says", () => {
  const doc = cleanDoc({
    blocks: [
      { id: "t1", type: "text", text: "下午三点出门，风比想象的大。" },
      { id: "p1", type: "photo", media: A, caption: "旧码头" },
      { id: "t2", type: "text", text: "   " },
    ],
  });

  it("a page with only whitespace is blank; one with a photo is not", () => {
    expect(isBlankDoc(cleanDoc({ blocks: [{ id: "t", type: "text", text: " \n " }] }))).toBe(true);
    expect(isBlankDoc(cleanDoc({ blocks: [{ id: "p", type: "photo", media: A }] }))).toBe(false);
    expect(isBlankDoc(doc)).toBe(false);
  });

  it("the excerpt is the start of the writing", () => {
    expect(excerpt(doc, 8)).toBe("下午三点出门，风…");
    expect(excerpt(doc)).toBe("下午三点出门，风比想象的大。 旧码头");
  });

  it("search text has the title, the writing, captions and what the recordings said — without the timestamps", () => {
    const text = buildJournalSearchText({ title: "去了趟江边", mood: "开心", weather: "晴", doc }, ["[0:02] 今天风特别大\n[0:11] 下次要少糖", null]);
    expect(text).toBe("去了趟江边\n开心\n晴\n下午三点出门，风比想象的大。\n旧码头\n今天风特别大下次要少糖");
  });

  it("recorded speech joins into one paragraph: no space between Chinese, one between English words", () => {
    expect(cuesText(transcriptCues("[0:02] 今天风特别大，\n[0:11] 下次要少糖。"))).toBe("今天风特别大，下次要少糖。");
    expect(cuesText(transcriptCues("[0:01] hello there\n[0:03] general"))).toBe("hello there general");
    expect(transcriptCues(null)).toEqual([]);
  });
});

describe("days", () => {
  it("accepts real calendar days only", () => {
    expect(cleanDay("2026-11-21")).toBe("2026-11-21");
    expect(cleanDay("2028-02-29")).toBe("2028-02-29");
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-5", "20261121", "", null, 20261121, "1969-12-31"]) expect(cleanDay(bad)).toBeNull();
  });

  it("each style writes the date its own way", () => {
    // 2026-11-21 是周六
    expect(weekdayLabel("2026-11-21")).toBe("周六");
    expect(dayLabel("2026-11-21", "fresh")).toBe("11月21日 · 周六");
    expect(dayLabel("2026-11-21", "y2k")).toBe("2026.11.21 ✦ SAT");
    expect(dayLabel("2026-11-21", "kawaii")).toBe("11月21日 星期六 ♡");
    expect(dayLabel("2026-11-21", "geek")).toBe("$ date +%F # 2026-11-21 Sat");
    expect(dayLabel("2026-01-04", "scenery")).toBe("JAN 4 · 2026");
  });
});

describe("search", () => {
  it("splits a query into terms", () => {
    expect(searchTerms("  江边   拿铁 江边 ")).toEqual(["江边", "拿铁"]);
    expect(searchTerms("   ")).toEqual([]);
    expect(searchTerms("a b c d e f g h")).toHaveLength(6);
  });

  it("shows where the first term was found", () => {
    const text = `${"前".repeat(100)}买了一杯热的桂花拿铁，坐在台阶上${"后".repeat(100)}`;
    const s = snippet(text, ["桂花拿铁"], 10)!;
    expect(s).toContain("桂花拿铁");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(snippet("Bought a LATTE today", ["latte"])).toBe("Bought a LATTE today");
    expect(snippet(text, ["没有这个词"])).toBeNull();
  });
});

describe("planJournalUpload", () => {
  it("takes what the browser recorded as audio, whatever the file is called", () => {
    expect(planJournalUpload({ name: "录音 1542.webm", mime: "audio/webm;codecs=opus", size: 1000 }, 50 * MB)).toEqual({ kind: "audio", ext: "webm", mime: "audio/webm" });
    expect(planJournalUpload({ name: "录音 1542.m4a", mime: "audio/mp4", size: 1000 }, 50 * MB)).toEqual({ kind: "audio", ext: "m4a", mime: "audio/mp4" });
  });

  it("falls back to the extension when the browser gives no type", () => {
    expect(planJournalUpload({ name: "语音备忘录.m4a", mime: "", size: 1000 }, 50 * MB)).toEqual({ kind: "audio", ext: "m4a", mime: "audio/mp4" });
    expect(planJournalUpload({ name: "IMG_0001.HEIC", mime: "", size: 1000 }, 50 * MB)).toEqual({ kind: "image", ext: "heic", mime: "image/heic" });
    expect(planJournalUpload({ name: "image.jpg", mime: "image/jpeg", size: 1000 }, 50 * MB)).toEqual({ kind: "image", ext: "jpg", mime: "image/jpeg" });
  });

  it("refuses everything that is not a photo or a recording, and says why", () => {
    expect(planJournalUpload({ name: "clip.webm", mime: "video/webm", size: 1000 }, 50 * MB)).toEqual({ error: "日记里只能放照片和录音" });
    expect(planJournalUpload({ name: "a.pdf", mime: "application/pdf", size: 1000 }, 50 * MB)).toEqual({ error: "日记里只能放照片和录音" });
    expect(planJournalUpload({ name: "a.jpg", mime: "image/jpeg", size: 0 }, 50 * MB)).toEqual({ error: "这是个空文件" });
    expect(planJournalUpload({ name: "a.jpg", mime: "image/jpeg", size: 51 * MB }, 50 * MB)).toEqual({ error: "文件太大（51 MB），单个文件最多 50 MB" });
  });
});
