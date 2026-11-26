import { isRunning } from "@/test/process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ytdlpInfo, ytdlpProbe } from "./ytdlp";

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
