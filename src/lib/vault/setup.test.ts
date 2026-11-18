import { describe, expect, it } from "vitest";
import { setupChecks, type SetupFacts } from "./setup";

const all: SetupFacts = {
  anthropic: true,
  voyage: true,
  apify: true,
  jina: true,
  ffmpeg: { path: "/opt/homebrew/bin/ffmpeg", error: null },
  asr: { volc: false, openai: true, whisper: null, whisperHint: null },
  ytdlp: "/opt/homebrew/bin/yt-dlp",
};
const state = (f: SetupFacts) => Object.fromEntries(setupChecks(f).map((c) => [c.key, c.state]));
const detail = (f: SetupFacts, key: string) => setupChecks(f).find((c) => c.key === key)!.detail;

describe("setupChecks", () => {
  it("is all ok when everything is configured", () => {
    expect(new Set(Object.values(state(all)))).toEqual(new Set(["ok"]));
    expect(detail(all, "asr")).toBe("可用：OpenAI whisper-1");
  });

  it("flags an ffmpeg that is present but too old, and speech recognition that depends on it", () => {
    const old = { ...all, ffmpeg: { path: "/usr/bin/ffmpeg", error: "FFmpeg 版本过旧或无法核对" } };
    expect(state(old)).toMatchObject({ ffmpeg: "missing", asr: "missing" });
    expect(detail(old, "ffmpeg")).toBe("FFmpeg 版本过旧或无法核对");
    expect(detail(old, "asr")).toContain("没有可用的 ffmpeg");
  });

  it("flags missing speech recognition even with a working ffmpeg", () => {
    const none = { ...all, asr: { volc: false, openai: false, whisper: null, whisperHint: null } };
    expect(state(none)).toMatchObject({ ffmpeg: "ok", asr: "missing" });
    expect(detail(none, "asr")).toBe("三条转写通道一条都没配");
    const half = { ...all, asr: { volc: false, openai: false, whisper: null, whisperHint: "本机装了 whisper 但没有模型文件" } };
    expect(detail(half, "asr")).toBe("本机装了 whisper 但没有模型文件");
  });

  it("treats yt-dlp and a Jina key as optional", () => {
    expect(state({ ...all, ytdlp: null, jina: false })).toMatchObject({ ytdlp: "optional", jina: "optional" });
    expect(state({ ...all, apify: false, voyage: false, anthropic: false })).toMatchObject({ apify: "missing", voyage: "missing", claude: "missing" });
  });
});
