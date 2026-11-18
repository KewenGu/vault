import { describe, expect, it } from "vitest";
import { describeFfmpegProblem, setupChecks, type SetupFacts } from "./setup";

const all: SetupFacts = {
  anthropic: true,
  voyage: true,
  apify: true,
  jina: true,
  ffmpeg: { path: "/opt/homebrew/bin/ffmpeg", error: null },
  asr: { volc: false, openai: true, whisper: null, whisperHint: null },
  ytdlp: "/opt/homebrew/bin/yt-dlp",
  storage: { bucketLimit: 200 * 1024 * 1024, wanted: 200 * 1024 * 1024 },
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

describe("describeFfmpegProblem", () => {
  it("names the binary and the version it found", () => {
    const out = "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang";
    expect(describeFfmpegProblem("/opt/homebrew/bin/ffmpeg", "FFmpeg 版本过旧或无法核对", out)).toBe("用的是 /opt/homebrew/bin/ffmpeg，版本 7.1.1，不够新：要 8.1.3 或更新（9.x 要 9.0.2 或更新）");
  });

  it("falls back to the raw problem when there is no version output", () => {
    expect(describeFfmpegProblem("/usr/bin/ffmpeg", "ffmpeg 启动失败：EACCES", "")).toBe("用的是 /usr/bin/ffmpeg：ffmpeg 启动失败：EACCES");
  });
});

describe("the archive limit check", () => {
  const MB = 1024 * 1024;
  it("names the bucket when its limit is the smaller one, with the statement to run", () => {
    const f = { ...all, storage: { bucketLimit: 50 * MB, wanted: 200 * MB } };
    expect(state(f).storage).toBe("missing");
    expect(detail(f, "storage")).toBe("存储桶的单文件上限是 50 MB，比这里的 200 MB 小");
    expect(setupChecks(f).find((c) => c.key === "storage")!.fix).toContain("update storage.buckets set file_size_limit = 209715200 where id = 'vault';");
  });

  it("points at the project-wide limit once the bucket is fine, and flags an unreadable bucket", () => {
    expect(state(all).storage).toBe("ok");
    expect(detail(all, "storage")).toContain("存储桶的上限够了（200 MB）");
    expect(detail(all, "storage")).toContain("Upload file size limit");
    expect(detail({ ...all, storage: { bucketLimit: null, wanted: 200 * MB } }, "storage")).toContain("没设上限");
    expect(state({ ...all, storage: { bucketLimit: undefined, wanted: 200 * MB } }).storage).toBe("missing");
  });
});
