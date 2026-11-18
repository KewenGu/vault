import "server-only";
import { asrConfig } from "@/lib/asr/volc";
import { openaiAsrConfig } from "@/lib/asr/openai";
import { localWhisper, whisperSetupHint } from "@/lib/asr/whisper-local";
import { assertFfmpegBinary, ffmpegPath } from "@/lib/media/ffmpeg";
import { ytdlpPath } from "@/lib/sources/ytdlp";
import type { SetupFacts } from "./setup";

/** 实际去看这台机器：环境变量配了没有、命令在不在、ffmpeg 版本够不够。只回答有没有，不带任何密钥的值。 */
export async function gatherSetupFacts(): Promise<SetupFacts> {
  const has = (name: string) => !!process.env[name]?.trim();
  const bin = ffmpegPath();
  let ffmpegError: string | null = null;
  if (bin) {
    try {
      await assertFfmpegBinary(bin);
    } catch (e) {
      ffmpegError = e instanceof Error ? e.message : String(e);
    }
  }
  const whisper = localWhisper();
  return {
    anthropic: has("ANTHROPIC_API_KEY"),
    voyage: has("VOYAGE_API_KEY"),
    apify: has("APIFY_TOKEN"),
    jina: has("JINA_API_KEY"),
    ffmpeg: { path: bin, error: ffmpegError },
    asr: { volc: asrConfig() !== null, openai: openaiAsrConfig() !== null, whisper: whisper?.model ?? null, whisperHint: whisperSetupHint() },
    ytdlp: ytdlpPath(),
  };
}
