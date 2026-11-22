import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, withTempDir } from "@/lib/media/ffmpeg";

/**
 * 日记里的录音要在各种浏览器里都能播、能拖进度：浏览器录出来的格式不一定行——Chrome 录的是 webm（文件里不带时长，
 * 拖不了进度条；iPhone 上不一定能播），Safari 录的是 m4a。m4a 和 mp3 原样留着，别的转成 m4a（AAC）。要 ffmpeg。
 */
const PLAYABLE = new Set(["m4a", "mp3"]);
export const needsPlayableCopy = (ext: string) => !PLAYABLE.has(ext.toLowerCase());

export const PLAYABLE_MIME = "audio/mp4";
export const PLAYABLE_EXT = "m4a";

export async function toPlayableAudio(file: Uint8Array, ext: string): Promise<Uint8Array> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, `in.${ext.replace(/[^\w]/g, "") || "bin"}`);
    await writeFile(input, file);
    const out = path.join(dir, `a.${PLAYABLE_EXT}`);
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", out], { timeoutMs: 300_000 });
    return new Uint8Array(await readFile(out));
  });
}
