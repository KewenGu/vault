import { isRunning } from "@/test/process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TooLargeError } from "@/lib/media/files";
import { ytdlpDownloadToFile, ytdlpInfo, ytdlpProbe } from "./ytdlp";

const temporary: string[] = [];
async function executable(source: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smi-ytdlp-native-"));
  temporary.push(dir);
  const bin = path.join(dir, "yt-dlp-fixture");
  await writeFile(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  vi.stubEnv("YTDLP_PATH", bin);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("yt-dlp real process boundary without network requests", () => {
  it("keeps the explicit safe transport while disabling inherited plugins and credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-private-value");
    const dir = await executable(`
      const fs = require("node:fs"), path = require("node:path");
      fs.writeFileSync(path.join(__dirname, "observed.json"), JSON.stringify({ args: process.argv.slice(2), secret: !!process.env.ANTHROPIC_API_KEY }));
      process.stdout.write(JSON.stringify({id:"synthetic",title:"local fixture"}));
    `);
    await expect(ytdlpInfo("https://example.com/fixture", 3000)).resolves.toMatchObject({ id: "synthetic" });
    const observed = JSON.parse(await readFile(path.join(dir, "observed.json"), "utf8"));
    expect(observed.secret).toBe(false);
    expect(observed.args).toContain("--no-plugin-dirs");
    expect(observed.args[observed.args.indexOf("--proxy") + 1]).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(observed.args[observed.args.indexOf("--downloader") + 1]).toBe("native");
  });

  it("tells apart a recognized site that failed, an unsupported URL, a slow read and a successful read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await executable(`process.stderr.write("ERROR: [BiliBili] 1ar421p7kw: Unable to download JSON metadata: HTTP Error 412: Precondition Failed\\n"); process.exit(1);`);
    await expect(ytdlpProbe("https://example.com/video", 3000)).resolves.toEqual({ info: null, failed: { extractor: "BiliBili", why: "对方回了 HTTP 412（多半是这台服务器的 IP 被那个站拦了）" } });
    await executable(`process.stderr.write("ERROR: Unsupported URL: https://example.com/page\\n"); process.exit(1);`);
    await expect(ytdlpProbe("https://example.com/page", 3000)).resolves.toEqual({ info: null, failed: null });
    await executable(`setInterval(() => {}, 1000);`);
    await expect(ytdlpProbe("https://example.com/slow", 700)).resolves.toEqual({ info: null, failed: { extractor: "", why: "1 秒没读完" } });
    await executable(`process.stdout.write(JSON.stringify({id:"synthetic",title:"local fixture"}));`);
    await expect(ytdlpProbe("https://example.com/ok", 3000)).resolves.toMatchObject({ info: { id: "synthetic" }, failed: null });
    vi.restoreAllMocks();
  });

  // 假的 yt-dlp：记下每次被叫时要的是哪一档、上限多少；按 SIZES 里给的大小（按次序）在 -o 的位置写一个 dl.mp4，0 = 这次什么都不写（被 --max-filesize 拦下）
  const downloader = (sizes: number[]) => `
    const fs = require("node:fs"), path = require("node:path");
    const args = process.argv.slice(2), log = path.join(__dirname, "calls.json");
    const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : [];
    calls.push({ format: args[args.indexOf("-f") + 1], max: args[args.indexOf("--max-filesize") + 1] });
    fs.writeFileSync(log, JSON.stringify(calls));
    const size = ${JSON.stringify(sizes)}[calls.length - 1] || 0;
    if (size > 0) fs.writeFileSync(args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4"), Buffer.alloc(size, 1));
  `;
  const KB = 1024;
  const limits = { storeMaxBytes: 50 * KB, readMaxBytes: 600 * KB };

  it("downloads to the given file; when nothing fits the archive limit it fetches a small rendition up to the read limit", async () => {
    // 没有 ffmpeg 的机器（不看本机装没装）：只下本来就是一个文件的 mp4
    vi.stubEnv("FFMPEG_PATH", "/nonexistent/ffmpeg");
    const out = await mkdtemp(path.join(os.tmpdir(), "smi-ytdlp-out-"));
    temporary.push(out);
    const dest = path.join(out, "source.mp4");

    // 短视频：第一步就下到了，存得进存储桶
    let dir = await executable(downloader([30 * KB]));
    await expect(ytdlpDownloadToFile("https://example.com/short", dest, limits)).resolves.toBe(30 * KB);
    expect((await readFile(dest)).byteLength).toBe(30 * KB);
    let calls = JSON.parse(await readFile(path.join(dir, "calls.json"), "utf8"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ max: String(50 * KB) });
    expect(calls[0].format).toContain("filesize<");

    // 长视频：存档上限以内的没有 → 第二步按读取上限下一档小的
    dir = await executable(downloader([0, 400 * KB]));
    await expect(ytdlpDownloadToFile("https://example.com/long", dest, limits)).resolves.toBe(400 * KB);
    expect((await readFile(dest)).byteLength).toBe(400 * KB);
    calls = JSON.parse(await readFile(path.join(dir, "calls.json"), "utf8"));
    expect(calls.map((c: { max: string }) => c.max)).toEqual([String(50 * KB), String(600 * KB)]);
    expect(calls[1].format).toContain("height<=360");
    expect(calls[1].format).not.toContain("filesize");

    // 第一步下下来合好才发现超了存档上限（站点没报大小）：没超读取上限就用这一份，不重新下
    dir = await executable(downloader([80 * KB, 300 * KB]));
    await expect(ytdlpDownloadToFile("https://example.com/unknown-size", dest, limits)).resolves.toBe(80 * KB);
    expect(JSON.parse(await readFile(path.join(dir, "calls.json"), "utf8"))).toHaveLength(1);
    // 第一步下到的连读取上限都超了：再按小的那一档试一次
    await executable(downloader([700 * KB, 300 * KB]));
    await expect(ytdlpDownloadToFile("https://example.com/huge-first", dest, limits)).resolves.toBe(300 * KB);
  });

  it("gives up as too large when even the small rendition exceeds the read limit, and does not retry when the limits are equal", async () => {
    vi.stubEnv("FFMPEG_PATH", "/nonexistent/ffmpeg");
    const out = await mkdtemp(path.join(os.tmpdir(), "smi-ytdlp-out-"));
    temporary.push(out);
    const dest = path.join(out, "source.mp4");
    let dir = await executable(downloader([0, 700 * KB]));
    const err = await ytdlpDownloadToFile("https://example.com/huge", dest, limits).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooLargeError);
    expect((err as TooLargeError).bytes).toBe(700 * KB);
    await expect(readFile(dest)).rejects.toThrow();
    dir = await executable(downloader([0, 0]));
    await expect(ytdlpDownloadToFile("https://example.com/huge", dest, { storeMaxBytes: 50 * KB, readMaxBytes: 50 * KB })).rejects.toBeInstanceOf(TooLargeError);
    expect(JSON.parse(await readFile(path.join(dir, "calls.json"), "utf8"))).toHaveLength(1);
  });

  it("also takes the second step when yt-dlp says no format matched the first selector", async () => {
    vi.stubEnv("FFMPEG_PATH", "/nonexistent/ffmpeg");
    const out = await mkdtemp(path.join(os.tmpdir(), "smi-ytdlp-out-"));
    temporary.push(out);
    const dest = path.join(out, "source.mp4");
    await executable(`
      const fs = require("node:fs"), args = process.argv.slice(2);
      if (args[args.indexOf("-f") + 1].includes("filesize<")) { process.stderr.write("ERROR: [Site] 1: Requested format is not available. Use --list-formats for a list of available formats\\n"); process.exit(1); }
      fs.writeFileSync(args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4"), Buffer.alloc(${200 * 1024}, 1));
    `);
    await expect(ytdlpDownloadToFile("https://example.com/no-height", dest, limits)).resolves.toBe(200 * KB);
  });

  it("reports a failed download as a plain error with yt-dlp's last line, without trying the second step", async () => {
    vi.stubEnv("FFMPEG_PATH", "/nonexistent/ffmpeg");
    const out = await mkdtemp(path.join(os.tmpdir(), "smi-ytdlp-out-"));
    temporary.push(out);
    const dir = await executable(`
      const fs = require("node:fs"), path = require("node:path"), log = path.join(__dirname, "calls");
      fs.appendFileSync(log, "x");
      process.stderr.write("ERROR: [BiliBili] 1: Unable to download video: HTTP Error 567: Unknown Status\\n");
      process.exit(1);
    `);
    await expect(ytdlpDownloadToFile("https://example.com/v", path.join(out, "source.mp4"), limits)).rejects.toThrow("yt-dlp 没下到视频：ERROR: [BiliBili] 1: Unable to download video: HTTP Error 567: Unknown Status");
    expect(await readFile(path.join(dir, "calls"), "utf8")).toBe("x");
  });

  it("terminates an owned postprocessor when its parent exceeds the deadline", async () => {
    const dir = await executable(`
      const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 7000)"], { stdio: "inherit" });
      fs.writeFileSync(path.join(__dirname,"child.pid"),String(child.pid));
      setInterval(() => {},1000);
    `);
    const run = ytdlpInfo("https://example.com/fixture", 800);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([run, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("postprocessor retained the output pipe")), 3000);
      })])).rejects.toThrow("跑太久");
      const pid = Number(await readFile(path.join(dir, "child.pid"), "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 1000, interval: 25 });
    } finally {
      clearTimeout(watchdog);
      const pid = Number(await readFile(path.join(dir, "child.pid"), "utf8").catch(() => "0"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await run.catch(() => {});
    }
  });
});
