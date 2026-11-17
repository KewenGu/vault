import { isRunning } from "@/test/process";
import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { nativeEnvironment, nativePythonSetupError } from "./native-process";

describe("native child environment", () => {
  it.each(["whisper", "yt-dlp"] as const)("explains an unsupported Python user-site install for %s", tool => {
    expect(nativePythonSetupError(tool, "ModuleNotFoundError: No module named 'whisper'")?.message).toContain("venv / pipx");
    expect(nativePythonSetupError(tool, "ImportError: dependency missing")?.message).toContain(tool === "whisper" ? "WHISPER_PATH" : "YTDLP_PATH");
    expect(nativePythonSetupError(tool, "HTTP Error 403")).toBeNull();
  });
  it("retains runtime paths and resource settings but excludes credentials and injection hooks", () => {
    expect(nativeEnvironment({
      PATH: "/usr/bin", HOME: "/home/native", TMPDIR: "/tmp/native", LANG: "C.UTF-8",
      OMP_NUM_THREADS: "2", SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic", NODE_OPTIONS: "--require injected.js",
      PYTHONPATH: "/untrusted", LD_PRELOAD: "/untrusted.so", DYLD_INSERT_LIBRARIES: "/untrusted.dylib",
      HTTPS_PROXY: "http://credential-proxy.invalid", PYTHONNOUSERSITE: "0",
    })).toEqual({
      PATH: "/usr/bin", HOME: "/home/native", TMPDIR: "/tmp/native", LANG: "C.UTF-8",
      OMP_NUM_THREADS: "2", SSL_CERT_FILE: "/etc/ssl/cert.pem", PYTHONNOUSERSITE: "1", NODE_ENV: "production",
    });
  });
});

describe.skipIf(process.platform === "win32")("native child shutdown", () => {
  it("application process.exit kills the native group without replacing framework signal handlers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "smi-native-parent-exit-"));
    let pid = 0;
    try {
      // Run the actual module in a separate Node process. Only the server-only marker is stubbed.
      await mkdir(path.join(dir, "node_modules/server-only"), { recursive: true });
      await writeFile(path.join(dir, "node_modules/server-only/index.js"), "");
      for (const name of ["spawn", "native-process"]) {
        const source = await readFile(path.join(process.cwd(), "src/lib/node", `${name}.ts`), "utf8");
        await writeFile(path.join(dir, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
      }
      const pidFile = path.join(dir, "child.pid");
      await writeFile(path.join(dir, "parent.cjs"), `
        const { spawnNative } = require("./native-process.js");
        const child = spawnNative(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.stdout.write("ready"); setInterval(()=>{},1000);`)}]);
        child.stdout.once("data", () => process.exit(0));
        setTimeout(() => process.exit(2), 3000);
      `);
      await promisify(execFile)(process.execPath, [path.join(dir, "parent.cjs")], { timeout: 5000 });
      pid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 1000, interval: 25 });
    } finally {
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
