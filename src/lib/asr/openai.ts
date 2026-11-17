import "server-only";
import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { joinText } from "@/lib/media/transcript";
import type { AsrTranscript } from "./volc";
import { ZH_PROMPT, parseWhisperJson } from "./whisper-local";

/**
 * OpenAI 的语音转写（收藏夹转写口播的备用通道）：豆包语音识别没配 / 没开通 / 出错时用，配了 OPENAI_API_KEY 才有。
 *
 * `POST https://api.openai.com/v1/audio/transcriptions`（multipart）：`model=whisper-1`、`response_format=verbose_json`、
 * `timestamp_granularities[]=segment` → 返回 `segments[].start / .text`（秒）和 `duration`，和本机 whisper 的输出一个形状。
 * - 用 whisper-1 是因为要逐句的时间：OpenAI 更新的转写模型（gpt-transcribe、gpt-4o-transcribe）不给时间戳，
 *   带时间的另一个是 gpt-4o-transcribe-diarize（按说话人分段，没试过它一段有多长）。
 * - 备用通道不是 Claude：Anthropic 的 API 不收音频（Models API 报的输入能力只有 image_input / pdf_input，2026-10-05 查的）。
 * - 文件上限 25 MB；我们送的是单声道 48 kbps 的 mp3、最多 10 分钟（约 3.6 MB）。
 * - $0.006 / 分钟，按音频时长；单价和计数键在 prices.ts。
 * - 2026-10-05：请求和返回体按官方文档写的；手上没有 OpenAI 的密钥，还没真实跑通过，第一次真转写时要核对。
 */

export const OPENAI_ASR_URL = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_ASR_MODEL = "whisper-1";
export const OPENAI_ASR_MAX_BYTES = 25 * 1024 * 1024;
const SERVICE = "OpenAI 语音转写";

export type OpenAiAsrConfig = { apiKey: string };

export function openaiAsrConfig(env: Record<string, string | undefined> = process.env): OpenAiAsrConfig | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}

/** 转写的请求体（纯函数，单测断言）。language：知道是中文就传 "zh"（出简体、带标点）；不知道传 null，让模型自己听。 */
export function openaiAsrForm(audio: Uint8Array, language: "zh" | null): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", OPENAI_ASR_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (language === "zh") {
    form.append("language", "zh");
    form.append("prompt", ZH_PROMPT);
  }
  return form;
}

/** 转写一段音频（mp3）。失败抛带状态码和要点的错误；没人说话返回空文字（编出来的片头片尾套话已经滤掉）。 */
export async function transcribeWithOpenAI(cfg: OpenAiAsrConfig, audio: Uint8Array, language: "zh" | null): Promise<AsrTranscript> {
  if (audio.byteLength > OPENAI_ASR_MAX_BYTES) throw new Error(`${SERVICE}一次最多收 25 MB，这段音频有 ${Math.ceil(audio.byteLength / 1024 / 1024)} MB`);
  const res = await labeledFetch(SERVICE, OPENAI_ASR_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: openaiAsrForm(audio, language),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw await httpError(SERVICE, res);
  const body = (await res.json().catch(() => null)) as { duration?: unknown; segments?: unknown } | null;
  if (!body || !Array.isArray(body.segments)) throw new Error(`${SERVICE}返回的内容认不出来（没有 segments）`);
  const { cues } = parseWhisperJson(body);
  return { text: cues.reduce((all, c) => joinText(all, c.text), ""), seconds: typeof body.duration === "number" && body.duration > 0 ? body.duration : null, cues };
}
