import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeMedia, runFfmpeg, withTempDir, type MediaProbe } from "./ffmpeg";

/**
 * 把一个音频文件（m4a / mp3 / wav / 微信语音转出来的各种格式）转成语音识别要的样子：单声道 16 kHz mp3，
 * 最多前 `maxSeconds` 秒。和 frames.ts 里从视频导音轨用的参数一样。要 ffmpeg。读不出来 / 没有音轨抛错。
 */
export async function extractSpeechAudio(file: Uint8Array, ext: string, maxSeconds: number): Promise<{ probe: MediaProbe; data: Uint8Array; seconds: number }> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, `in.${ext.replace(/[^\w]/g, "") || "bin"}`);
    await writeFile(input, file);
    const probe = await probeMedia(input);
    if (!probe.hasAudio) throw new Error("这个文件里没有声音");
    const out = path.join(dir, "a.mp3");
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", input, "-t", String(maxSeconds), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", out], { timeoutMs: 180_000 });
    return { probe, data: new Uint8Array(await readFile(out)), seconds: Math.min(probe.duration, maxSeconds) };
  });
}
