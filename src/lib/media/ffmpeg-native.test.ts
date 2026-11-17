import { isRunning } from "@/test/process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FfmpegError, runFfmpeg } from "./ffmpeg";

const temporary: string[] = [];
async function executable(source: string, version = "9.0.2") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smi-native-test-"));
  temporary.push(dir);
  const bin = path.join(dir, "native-fixture");
  await writeFile(bin, `#!${process.execPath}\nif (process.argv.includes("-version")) { console.log(${JSON.stringify(`ffmpeg version ${version}`)}); process.exit(0); }\n${source}`, { mode: 0o700 });
  vi.stubEnv("FFMPEG_PATH", bin);
  return dir;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("real native subprocess lifecycle", () => {
  it.each(["6.0", "8.1.2", "9.0.1", "N-12345-git"])("refuses unverified FFmpeg %s before passing it media input", async (version) => {
    const dir = await executable('require("node:fs").writeFileSync(process.argv[2], "decoded");', version);
    const marker = path.join(dir, "decoded");
    await expect(runFfmpeg([marker], { timeoutMs: 2000 })).rejects.toThrow("版本过旧或无法核对");
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("probe allowFailure accepts an ordinary nonzero exit", async () => {
    await executable('process.stderr.write("Duration: 00:00:01.00\\n"); process.exitCode = 1;');
    await expect(runFfmpeg([], { allowFailure: true, timeoutMs: 2000 })).resolves.toContain("Duration:");
  });

  it("ordinary nonzero failures preserve their exit code and stderr", async () => {
    await executable('process.stderr.write("synthetic encoder failure\\n"); process.exitCode = 7;');
    const run = runFfmpeg([], { timeoutMs: 2000 });
    await expect(run).rejects.toBeInstanceOf(FfmpegError);
    await expect(run).rejects.toMatchObject({
      message: "ffmpeg 出错（退出码 7）：synthetic encoder failure",
      stderrTail: "synthetic encoder failure\n",
      code: 7, signal: null, timedOut: false,
    });
  });

  it("probe allowFailure cannot turn a deadline-killed process into success", async () => {
    await executable('process.stderr.write("Duration: 00:00:01.00\\n"); setInterval(() => {}, 1000);');
    const run = runFfmpeg([], { allowFailure: true, timeoutMs: 200 });
    await expect(run).rejects.toBeInstanceOf(FfmpegError);
    await expect(run).rejects.toMatchObject({
      message: "ffmpeg 跑太久被停掉了", code: null, signal: "SIGKILL", timedOut: true,
    });
  });

  it.each(["SIGTERM", "SIGKILL"] as const)("unexpected %s stays a failure with signal evidence even when nonzero exits are allowed", async (signal) => {
    await executable(`process.kill(process.pid, ${JSON.stringify(signal)});`);
    const run = runFfmpeg([], { allowFailure: true, timeoutMs: 2000 });
    await expect(run).rejects.toBeInstanceOf(FfmpegError);
    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining(signal), code: null, signal, timedOut: false,
    });
  });

  it("deadline terminates descendants holding inherited pipes, without waiting for them", async () => {
    const dir = await executable(`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "inherit" });
      writeFileSync(process.argv[2], String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const pidFile = path.join(dir, "owned-child.pid");
    const started = Date.now();
    const run = runFfmpeg([pidFile], { timeoutMs: 800 });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([run, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("descendant retained the pipe beyond deadline")), 3000);
      })])).rejects.toThrow("跑太久");
      expect(Date.now() - started).toBeLessThan(2800);
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 1000, interval: 25 });
    } finally {
      clearTimeout(watchdog);
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      // The only PID used is created by this temporary executable; cleanup also runs on regression.
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await run.catch(() => {});
    }
  });

  it("does not inherit provider secrets or runtime injection variables", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-native-test-value");
    vi.stubEnv("SMI_NATIVE_PRIVATE_SENTINEL", "synthetic-native-test-value");
    await executable('process.stderr.write(JSON.stringify({ provider: !!process.env.ANTHROPIC_API_KEY, private: !!process.env.SMI_NATIVE_PRIVATE_SENTINEL, path: !!process.env.PATH }));');
    expect(JSON.parse(await runFfmpeg([], { timeoutMs: 2000 }))).toEqual({ provider: false, private: false, path: true });
  });

  it("a normally exiting parent cannot leave a postprocessor retaining its pipes", async () => {
    const dir = await executable(`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 7000)"], { stdio: "inherit" });
      writeFileSync(process.argv[2], String(child.pid));
      process.exit(0);
    `);
    const pidFile = path.join(dir, "child.pid");
    try {
      await expect(runFfmpeg([pidFile], { timeoutMs: 2500 })).resolves.toBe("");
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 1000, interval: 25 });
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
});
