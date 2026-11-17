import "server-only";
import { spawnNative, stopNativeProcess } from "@/lib/node/native-process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 本机的 ffmpeg（分段视频的拼接导出、抽尾帧）：env FFMPEG_PATH → 系统 PATH。
 * 不再退回 ffmpeg-static 的旧二进制。发现路径不等于通过验收，执行前还要验证维护版本。
 */

export class FfmpegMissingError extends Error {
  constructor() {
    super("这台机器上没有 ffmpeg：请安装已核对的 FFmpeg 8.1.3、9.0.2 或更新维护版，并设置 FFMPEG_PATH；云端需配置媒体 worker");
    this.name = "FfmpegMissingError";
  }
}

/** FFmpeg 未正常完成：保留 stderr 和已知退出信息，避免把信号终止误报成普通编码错误。 */
export class FfmpegError extends Error {
  readonly code: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
  readonly timedOut: boolean | undefined;

  constructor(
    message: string,
    readonly stderrTail: string,
    exit?: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }
  ) {
    super(message);
    this.name = "FfmpegError";
    this.code = exit?.code;
    this.signal = exit?.signal;
    this.timedOut = exit?.timedOut;
  }
}

const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

export function ffmpegPath(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env.FFMPEG_PATH?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

export type RunOptions = {
  /** 每次 ffmpeg 报进度（-progress pipe:1）时回调：已输出的秒数 */
  onProgress?: (seconds: number) => void;
  timeoutMs?: number;
  /** 允许普通非零退出；超时或信号终止仍失败（无输出目标的探测正常以 1 退出）。 */
  allowFailure?: boolean;
};

/** 跑一次 ffmpeg，返回 stderr（末尾 64 KB）。退出码非 0 抛 FfmpegError。 */
export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  const bin = ffmpegPath();
  if (!bin) throw new FfmpegMissingError();
  await assertFfmpegBinary(bin);
  return executeFfmpeg(bin, args, opts);
}

const verifiedBinaries = new Map<string, { signature: string; promise: Promise<void> }>();
/** A maintained baseline, not a claim that any version has no vulnerabilities. */
export async function assertFfmpegBinary(bin: string): Promise<void> {
  let signature: string;
  try {
    const stat = statSync(bin);
    if (!stat.isFile()) throw new Error("not a file");
    signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch {
    throw new FfmpegMissingError();
  }
  const previous = verifiedBinaries.get(bin);
  if (previous?.signature === signature) return previous.promise;
  let output = "";
  const promise = executeFfmpeg(bin, ["-hide_banner", "-version"], {
    timeoutMs: 5000,
    onStdout: (chunk) => { output = (output + chunk).slice(0, 8192); },
  }).then(() => {
    const match = /^ffmpeg version (?:n)?(\d+)\.(\d+)(?:\.(\d+))?(?:[\s-]|$)/m.exec(output);
    const [major, minor, patch] = match ? match.slice(1).map((n) => Number(n ?? 0)) : [0, 0, 0];
    const maintained = major > 9 || (major === 9 && (minor > 0 || patch >= 2)) || (major === 8 && (minor > 1 || (minor === 1 && patch >= 3)));
    if (!maintained) {
      throw new FfmpegError("FFmpeg 版本过旧或无法核对：请将 FFMPEG_PATH 指向已验收的 8.1.3、9.0.2 或更新维护版", output.slice(0, 1000));
    }
  }).catch((error) => {
    if (verifiedBinaries.get(bin)?.signature === signature) verifiedBinaries.delete(bin);
    throw error;
  });
  verifiedBinaries.set(bin, { signature, promise });
  return promise;
}

function executeFfmpeg(bin: string, args: string[], opts: RunOptions & { onStdout?: (chunk: string) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnNative(bin, args);
    let stderr = "";
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopNativeProcess(child); }, opts.timeoutMs ?? 20 * 60_000);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-65536);
    });
    child.stdout.on("data", (d: Buffer) => {
      opts.onStdout?.(d.toString("utf8"));
      out = (out + d.toString("utf8")).slice(-65536);
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && opts.onProgress) opts.onProgress(Number(m[1]) / 1e6);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      stopNativeProcess(child);
      reject(new FfmpegError(`ffmpeg 启动失败：${e.message}`, stderr));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      stopNativeProcess(child);
      if (!timedOut && !signal && (code === 0 || opts.allowFailure)) return resolve(stderr);
      // 只报错误级别时，最先出现的那一两行才是根因（后面是各个编码器跟着退出的连锁报错）
      const first = stderr.trim().split("\n").filter(Boolean).slice(0, 2).join(" / ");
      const message = timedOut ? "ffmpeg 跑太久被停掉了"
        : signal ? `ffmpeg 被信号终止（${signal}）：${first.slice(0, 300)}`
          : `ffmpeg 出错（退出码 ${code}）：${first.slice(0, 300)}`;
      reject(new FfmpegError(message, stderr.slice(-4000), { code, signal, timedOut }));
    });
  });
}

export type MediaProbe = { duration: number; hasAudio: boolean; width: number | null; height: number | null; fps: number | null };

/** 从 `ffmpeg -i` 的输出里读时长、有没有音轨、画面尺寸（纯函数，便于单测）。 */
export function parseProbe(stderr: string): MediaProbe {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!d) throw new FfmpegError("读不出视频时长（文件可能坏了）", stderr.slice(-2000));
  const duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const v = /Stream #\S+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const fps = /Stream #\S+.*Video:.*?(\d+(?:\.\d+)?) fps/.exec(stderr);
  return {
    duration,
    hasAudio: /Stream #\S+.*Audio:/.test(stderr),
    width: v ? Number(v[1]) : null,
    height: v ? Number(v[2]) : null,
    fps: fps ? Number(fps[1]) : null,
  };
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  return parseProbe(await runFfmpeg(["-hide_banner", "-i", file], { allowFailure: true, timeoutMs: 60_000 }));
}

/** 用完即删的临时目录。 */
export async function withTempDir<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sm-video-"));
  try {
    return await f(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 抽一段视频的最后一帧（PNG）：火山方舟没给尾帧时的后备。 */
export async function extractLastFrame(video: Uint8Array): Promise<Uint8Array> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "in.mp4");
    const output = path.join(dir, "last.png");
    await writeFile(input, video);
    // 从结尾前 0.3 秒开始逐帧覆盖写同一个文件，最后留下的就是最后一帧
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-sseof", "-0.3", "-i", input, "-update", "1", "-y", output], { timeoutMs: 60_000 });
    return new Uint8Array(await readFile(output));
  });
}

/** 取视频第 seconds 秒那一帧（PNG，原尺寸）：剪辑页「截取这一帧」。ext 是原文件扩展名（mp4 / mov / webm）。 */
export async function extractFrameAt(video: Uint8Array, ext: string, seconds: number): Promise<Uint8Array> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, `in.${ext.replace(/[^\w]/g, "") || "mp4"}`);
    const output = path.join(dir, "frame.png");
    await writeFile(input, video);
    // -ss 放在 -i 前面：先跳到附近的关键帧再精确解码到那一刻，又快又准
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", Math.max(0, seconds).toFixed(3), "-i", input, "-frames:v", "1", "-y", output], { timeoutMs: 60_000 });
    try {
      return new Uint8Array(await readFile(output));
    } catch {
      throw new FfmpegError("这个时间点取不到画面（可能超过了视频结尾）", "");
    }
  });
}

