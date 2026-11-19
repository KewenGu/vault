import "server-only";
import { asrConfig } from "@/lib/asr/volc";
import { openaiAsrConfig } from "@/lib/asr/openai";
import { localWhisper, whisperSetupHint } from "@/lib/asr/whisper-local";
import { assertFfmpegBinary, FfmpegError, ffmpegPath } from "@/lib/media/ffmpeg";
import { VIDEO_MAX_BYTES } from "@/lib/media/files";
import { localMediaUsage } from "@/lib/media/local-store";
import { getServiceClient } from "@/lib/supabase/service";
import { bucketFileLimit } from "./store";
import { ytdlpPath } from "@/lib/sources/ytdlp";
import { describeFfmpegProblem, type SetupFacts } from "./setup";

/** 实际去看这台机器：环境变量配了没有、命令在不在、ffmpeg 版本够不够。只回答有没有，不带任何密钥的值。 */
export async function gatherSetupFacts(): Promise<SetupFacts> {
  const has = (name: string) => !!process.env[name]?.trim();
  const bin = ffmpegPath();
  let ffmpegError: string | null = null;
  if (bin) {
    try {
      await assertFfmpegBinary(bin);
    } catch (e) {
      // 版本不够时，报错里带着 `ffmpeg -version` 的输出：把找到的是哪一个、是什么版本说出来，不然不知道该升级哪个
      ffmpegError = describeFfmpegProblem(bin, e instanceof Error ? e.message : String(e), e instanceof FfmpegError ? e.stderrTail : "");
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
    storage: { bucketLimit: await bucketFileLimit(getServiceClient()).catch(() => undefined), wanted: VIDEO_MAX_BYTES },
    localMedia: await localMediaUsage(),
  };
}
