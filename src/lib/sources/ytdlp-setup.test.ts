import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ytdlpInfo } from "./ytdlp";

// Only proxy provisioning is replaced: the real native process and stderr handling run.
// The fixture executable never opens a socket or contacts a video provider.
vi.mock("@/lib/network/public-proxy", () => ({ withPublicProxy: (work: (url: string) => Promise<unknown>) => work("http://127.0.0.1:9") }));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("yt-dlp Python installation diagnostics through a real process", () => {
  async function executable(stderr: string, work: () => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "smi-ytdlp-setup-"));
    try {
      const bin = join(dir, "yt-dlp");
      await writeFile(bin, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;\n`, { mode: 0o700 });
      vi.stubEnv("YTDLP_PATH", bin);
      await work();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  it("surfaces a user-site import failure rather than silently falling back to a webpage", async () => {
    await executable("Traceback (most recent call last):\n  File '/private/example/user/bin/yt-dlp', line 5\nModuleNotFoundError: No module named 'yt_dlp'\n", async () => {
      await expect(ytdlpInfo("https://media.example/watch", 5_000)).rejects.toThrow(/venv.*pipx|pipx.*venv/);
      await expect(ytdlpInfo("https://media.example/watch", 5_000)).rejects.toThrow("YTDLP_PATH");
    });
  });
  it("preserves ordinary unsupported-URL fallback", async () => {
    await executable("ERROR: Unsupported URL: https://media.example/watch\n", async () => {
      await expect(ytdlpInfo("https://media.example/watch", 5_000)).resolves.toBeNull();
    });
  });
});
