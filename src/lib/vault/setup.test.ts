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
  localMedia: { dir: "/data/media", files: 3, bytes: 800 * 1024 * 1024, freeBytes: 30 * 1024 * 1024 * 1024 },
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
  const storage = (f: SetupFacts) => setupChecks(f).find((c) => c.key === "storage")!;

  it("is fine at the default 50 MB, and says what it takes to store more", () => {
    const f = { ...all, storage: { bucketLimit: 200 * MB, wanted: 50 * MB } };
    expect(storage(f).state).toBe("ok");
    expect(storage(f).detail).toContain("单个最多 50 MB。想存更大的");
    expect(storage(f).detail).toContain("VAULT_STORE_MAX_MB");
    expect(storage(f).effect).toContain("最多往 Supabase 存 50 MB");
    expect(storage(f).effect).toContain("留在这台服务器的磁盘上");
  });

  it("shows how much disk the kept originals use, and warns when the disk is nearly full", () => {
    const local = (f: SetupFacts) => setupChecks(f).find((c) => c.key === "localMedia")!;
    expect(local(all)).toMatchObject({ state: "ok", detail: "/data/media：3 个文件，共 0.8 GB；这个盘还剩 30.0 GB", fix: "" });
    const tight = local({ ...all, localMedia: { ...all.localMedia, freeBytes: 1.5 * 1024 * MB } });
    expect(tight.state).toBe("missing");
    expect(tight.fix).toContain("删掉 /data/media 下不要的原片");
    // 剩余空间没读到：不乱报
    expect(local({ ...all, localMedia: { ...all.localMedia, freeBytes: null } })).toMatchObject({ state: "ok", detail: "/data/media：3 个文件，共 0.8 GB" });
  });

  it("warns that a raised limit needs a paid plan", () => {
    expect(storage({ ...all, storage: { bucketLimit: 200 * MB, wanted: 200 * MB } }).detail).toContain("超过 50 MB 的要付费套餐才存得进去");
  });

  it("names the bucket when its limit is below the setting, and flags an unreadable bucket", () => {
    const f = { ...all, storage: { bucketLimit: 50 * MB, wanted: 200 * MB } };
    expect(storage(f).state).toBe("missing");
    expect(storage(f).detail).toBe("存储桶的单文件上限是 50 MB，比这里设的 200 MB 小");
    expect(storage(f).fix).toContain("20261118000001_bucket_limit.sql");
    expect(storage({ ...all, storage: { bucketLimit: undefined, wanted: 50 * MB } }).state).toBe("missing");
    expect(storage({ ...all, storage: { bucketLimit: null, wanted: 50 * MB } }).state).toBe("ok");
  });
});
