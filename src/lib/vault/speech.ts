import "server-only";
import { openaiAsrConfig, transcribeWithOpenAI } from "@/lib/asr/openai";
import { AsrNotEnabledError, asrConfig, transcribe } from "@/lib/asr/volc";
import { localWhisper, transcribeLocally, whisperSetupHint } from "@/lib/asr/whisper-local";
import { cuesToText, type Cue } from "@/lib/media/transcript";
import { meterInto, recordCall } from "@/lib/usage/meter";
import { OPENAI_ASR_COUNT_KEY } from "@/lib/usage/prices";

/** 把说的话转成文字（收藏库里的视频 / 音频和日记里的录音共用）。 */

type Counts = Record<string, number>;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 最多转写前这么多秒（60 分钟；48 kbps 单声道约 22 MB，在各家语音识别的单文件上限以内——最紧的是 OpenAI 的 25 MB） */
export const SPEECH_MAX_SECONDS = 3600;

/**
 * 把音轨转成带时间的文字。三条路按顺序试，前一条走不通才试下一条：豆包语音识别（配了密钥、控制台也开通了）
 * → OpenAI whisper-1（配了 OPENAI_API_KEY）→ 本机的 whisper（命令和模型文件都在，不花钱）。
 * 都走不通就不转，notes 里说清楚各差什么。转出来是空的（没人说话）不算走不通，不再往下试。
 */
export async function transcribeSpeech(counts: Counts, audio: { data: Uint8Array; seconds: number }, language: "zh" | null): Promise<{ transcript: string | null; cues: Cue[]; notes: string[] }> {
  const done = (text: string, cues: Cue[] = []) => (text ? { transcript: text, cues, notes: [] } : { transcript: null, cues: [], notes: ["没有识别出说话（可能只有音乐）"] });
  const why: string[] = [];
  const volc = asrConfig();
  if (!volc) {
    why.push("没配 VOLC_SPEECH_API_KEY");
  } else {
    try {
      const r = await meterInto(counts, async () => {
        const r = await transcribe(volc, audio.data);
        recordCall(r.countKey, Math.ceil(r.seconds ?? audio.seconds));
        return r;
      });
      return done(r.cues.length > 0 ? cuesToText(r.cues) : r.text, r.cues);
    } catch (e) {
      why.push(e instanceof AsrNotEnabledError ? e.message : `豆包语音识别出错（${messageOf(e).slice(0, 100)}）`);
      console.error(`口播：豆包语音识别没转成，换备用通道：${messageOf(e)}`);
    }
  }
  const openai = openaiAsrConfig();
  if (!openai) {
    why.push("没配 OPENAI_API_KEY");
  } else {
    try {
      const r = await meterInto(counts, async () => {
        const r = await transcribeWithOpenAI(openai, audio.data, language);
        recordCall(OPENAI_ASR_COUNT_KEY, Math.ceil(r.seconds ?? audio.seconds));
        return r;
      });
      return done(cuesToText(r.cues), r.cues);
    } catch (e) {
      why.push(`OpenAI 的转写没成（${messageOf(e).slice(0, 100)}）`);
    }
  }
  const whisper = localWhisper();
  if (whisper) {
    try {
      const r = await transcribeLocally(whisper, audio.data, audio.seconds, language);
      return done(cuesToText(r.cues), r.cues);
    } catch (e) {
      why.push(`本机的 whisper 没转出来（${messageOf(e).slice(0, 100)}）`);
    }
  } else {
    const hint = whisperSetupHint();
    if (hint) why.push(hint);
  }
  return { transcript: null, cues: [], notes: [`没有转写说的话：${why.join("；")}`] };
}
