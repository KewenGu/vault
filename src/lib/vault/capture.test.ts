import { describe, expect, it } from "vitest";
import { captureFields, classifyCapture, fileDedupeKey, planUpload, textDedupeKey, titleFromFilename, UPLOAD_MAX_BYTES } from "./capture";

describe("classifyCapture", () => {
  it("treats a bare link and an app share blurb as a link", () => {
    expect(classifyCapture(" https://www.youtube.com/watch?v=dQw4w9WgXcQ ")).toEqual({ kind: "link", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(classifyCapture("7.94 复制打开抖音，看看【小王的作品】三亚带娃住哪里 https://v.douyin.com/iAbCdEf/ k@P.xx 08/12")).toEqual({ kind: "link", url: "https://v.douyin.com/iAbCdEf/" });
    expect(classifyCapture("https://example.com/blog/post-1")).toEqual({ kind: "link", url: "https://example.com/blog/post-1" });
  });

  it("keeps prose that merely mentions links as text", () => {
    const note = `会议记录\n${"今天讨论了下季度的计划。".repeat(40)}\n参考 https://example.com/a`;
    expect(classifyCapture(note)).toEqual({ kind: "text", text: note });
    const two = "对比一下 https://a.example.com/x 和 https://b.example.com/y";
    expect(classifyCapture(two)).toEqual({ kind: "text", text: two });
    expect(classifyCapture("明天记得买牛奶")).toEqual({ kind: "text", text: "明天记得买牛奶" });
  });

  it("treats a platform share text as a link however long its caption is", () => {
    const caption = "停止精神内耗的9个方法｜别再让自己这么累了 你有没有过这样的经历？明明一天没做多少事情，却觉得特别疲惫。".repeat(12);
    const share = `2.56 01/03 Z@m.DH WmD:/ :2pm ${caption} #精神内耗 #自我成长 https://v.douyin.com/iAbCdEf/ 复制此链接，打开Dou音搜索，直接观看视频！`;
    expect(Array.from(share).length).toBeGreaterThan(600);
    expect(classifyCapture(share)).toEqual({ kind: "link", url: "https://v.douyin.com/iAbCdEf/" });
    // 不认得的网站还是按 300 字的线：长文里顺带的一条链接是文字的一部分
    const essay = `${caption} https://example.com/a`;
    expect(classifyCapture(essay)).toEqual({ kind: "text", text: essay });
  });

  it("returns null for empty input", () => {
    expect(classifyCapture("  \n ")).toBeNull();
  });
});

describe("dedupe keys", () => {
  it("ignores whitespace differences in text", () => {
    expect(textDedupeKey("买 牛奶\n")).toBe(textDedupeKey("买   牛奶"));
    expect(textDedupeKey("买牛奶")).not.toBe(textDedupeKey("买酸奶"));
    expect(fileDedupeKey("ABC123")).toBe("file:abc123");
  });
});

describe("planUpload", () => {
  it("classifies by extension first", () => {
    expect(planUpload({ name: "IMG_0012.PNG", mime: "", size: 10 })).toEqual({ kind: "image", ext: "png", mime: "image/png" });
    expect(planUpload({ name: "录屏.MOV", mime: "video/quicktime", size: 10 })).toEqual({ kind: "video", ext: "mov", mime: "video/quicktime" });
    expect(planUpload({ name: "语音备忘.m4a", mime: "audio/x-m4a", size: 10 })).toEqual({ kind: "audio", ext: "m4a", mime: "audio/mp4" });
    expect(planUpload({ name: "notes.md", mime: "", size: 10 })).toEqual({ kind: "text", ext: "md", mime: "text/markdown" });
  });

  it("falls back to the MIME major type, and rejects what it cannot read", () => {
    expect(planUpload({ name: "clip", mime: "video/3gpp", size: 10 })).toEqual({ kind: "video", ext: "3gpp", mime: "video/3gpp" });
    expect(planUpload({ name: "report.pdf", mime: "application/pdf", size: 10 })).toHaveProperty("error");
    expect(planUpload({ name: "a.png", mime: "image/png", size: 0 })).toEqual({ error: "这是个空文件" });
    expect(planUpload({ name: "a.mp4", mime: "video/mp4", size: UPLOAD_MAX_BYTES + 1 })).toHaveProperty("error");
  });

  it("derives a starting title from the filename", () => {
    expect(titleFromFilename("三亚攻略 最终版.png")).toBe("三亚攻略 最终版");
  });
});

describe("captureFields", () => {
  it("uses the note as the content when only the note was filled in", () => {
    expect(captureFields("  ", "https://v.douyin.com/iAbCdEf/")).toEqual({ input: "https://v.douyin.com/iAbCdEf/", note: "" });
    expect(captureFields("https://example.com", "周末看")).toEqual({ input: "https://example.com", note: "周末看" });
    expect(captureFields("", "")).toEqual({ input: "", note: "" });
  });
});
