import "server-only";
import { rename, stat } from "node:fs/promises";
import path from "node:path";
import type { RemoteFile } from "@/lib/sources/types";
import { downloadRemoteToFile } from "./files";
import { runFfmpeg } from "./ffmpeg";

/** 单独的声音文件最多下这么大（128 kbps 的声音一小时约 58 MB） */
const AUDIO_MAX_BYTES = 200 * 1024 * 1024;

/**
 * 把另一个文件里的声音合进视频（Reddit 把一个视频的画面和声音分开放成两个文件）。
 * 只换容器，不重新编码：几秒钟的事。合好的文件换掉 `video`，返回新的大小。要 ffmpeg。
 * 失败时抛错，`video` 原样留着（没有声音的画面还能用）。
 */
export async function muxAudioInto(video: string, audio: RemoteFile, tmp: string): Promise<number> {
  const sound = path.join(tmp, "sound.mp4");
  const out = path.join(tmp, "muxed.mp4");
  await downloadRemoteToFile(audio, sound, AUDIO_MAX_BYTES, 120_000);
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", video, "-i", sound, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "-y", out], { timeoutMs: 180_000 });
  const { size } = await stat(out);
  if (size === 0) throw new Error("合出来的文件是空的");
  await rename(out, video);
  return size;
}
