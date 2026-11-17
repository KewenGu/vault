import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import type { Cue } from "@/lib/media/transcript";
import { ASR2_COUNT_KEY, ASR_COUNT_KEY } from "@/lib/usage/prices";

/**
 * 豆包语音的录音文件识别（收藏夹：把视频里说的话转成文字，拆解时才知道它讲了什么）。
 *
 * `POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`：一次请求、同步返回全文和逐句的时间；
 * 音频放在请求体里（base64，mp3 / wav / ogg，≤ 100 MB、≤ 2 小时）。
 * - 鉴权和配音一样用 VOLC_SPEECH_API_KEY（`X-Api-Key`）；`X-Api-Resource-Id` 选服务项、也决定计费项。
 * - 服务项要在豆包语音控制台开通，账号开了哪项不一定：ASR_RESOURCES 里的按顺序试，没开通的回 403 +
 *   `X-Api-Status-Code: 45000030`（requested resource not granted，写错的服务项也是这个码）就换下一个；
 *   一项都没开通抛 AsrNotEnabledError，调用方换别的转写通道、把原因告诉用户。
 * - 2026-10-05 用真实账号跑通：账号开通的是「豆包录音文件识别模型 2.0」（`volc.seedasr.auc`）。官方文档写这个接口只收
 *   极速版的 `volc.bigasr.auc_turbo`，实测 2.0 的服务项它也收——7 分钟的口播 6.6 秒返回，70 句、每句带起止时间（毫秒）、
 *   简体带标点。哪天接口不再收 2.0 的服务项，会变回「没开通」，要改用标准版的 submit / query 接口（那边要音频的 URL）。
 */

export const ASR_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
/** 能走这个接口的服务项和各自的账本计数键（单价在 prices.ts），按顺序试。 */
export const ASR_RESOURCES: { id: string; countKey: string }[] = [
  { id: "volc.seedasr.auc", countKey: ASR2_COUNT_KEY },
  { id: "volc.bigasr.auc_turbo", countKey: ASR_COUNT_KEY },
];
const SERVICE = "豆包语音识别";
const OK = "20000000";
const NOT_GRANTED = "45000030";
/** 静音 / 没有人声：不算错，返回空文字 */
const SILENT = new Set(["20000003"]);

export class AsrNotEnabledError extends Error {
  constructor() {
    super("豆包语音控制台里还没开通录音文件识别（「豆包录音文件识别模型 2.0」或「大模型录音文件识别·极速版」开一项就行）");
    this.name = "AsrNotEnabledError";
  }
}

export type AsrConfig = { apiKey: string };

export function asrConfig(env: Record<string, string | undefined> = process.env): AsrConfig | null {
  const apiKey = env.VOLC_SPEECH_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}

/** 一段音频的转写结果（各家转写通道都给这个形状）。 */
export type AsrTranscript = {
  text: string;
  /** 接口报的音频时长（秒）；没报时为 null，调用方按自己知道的时长记账 */
  seconds: number | null;
  /** 逐句的文字和开始时间（秒），给了逐字时间的带 words（帧格标词用）；接口没给逐句结果 / 没给时间时为空，调用方用 text */
  cues: Cue[];
};

/** countKey：这次是哪个服务项转的，按它的单价记账 */
export type AsrResult = AsrTranscript & { countKey: string };

type Utterance = { text?: string; start_time?: number; end_time?: number; words?: { text?: string; start_time?: number; end_time?: number }[] };
type AsrBody = {
  audio_info?: { duration?: number };
  result?: { text?: string; utterances?: Utterance[] } | { text?: string; utterances?: Utterance[] }[];
  header?: { code?: number; message?: string };
};

/** 一句里的逐字（`words[].start_time / end_time`，毫秒）：都带时间的才算；只有一两个字带时间（见过 words 只给第一个字的）不算。 */
function wordsOf(u: Utterance): Cue["words"] {
  const words = (Array.isArray(u.words) ? u.words : []).filter((w) => typeof w?.text === "string" && w.text.trim());
  if (words.length === 0) return undefined;
  const timed = words.every((w) => typeof w.start_time === "number" && typeof w.end_time === "number" && w.end_time >= w.start_time);
  if (!timed) return undefined;
  const text = words.map((w) => (w.text as string).trim()).join("");
  // 逐字拼起来要和整句对得上（去掉空白和标点比），对不上说明 words 不全
  const strip = (t: string) => t.replace(/[\s\p{P}]/gu, "");
  if (strip(text) !== strip(u.text ?? "")) return undefined;
  return words.map((w) => ({ at: (w.start_time as number) / 1000, end: (w.end_time as number) / 1000, text: (w.text as string).trim() }));
}

/** 解析返回体：全文在 `result.text`，没有就把逐句的拼起来；逐句的开始时间（`start_time`，毫秒）都给了才算有时间；逐字时间全的带上。 */
export function parseAsrBody(body: unknown): AsrTranscript {
  const b = (body && typeof body === "object" ? body : {}) as AsrBody;
  const result = Array.isArray(b.result) ? b.result[0] : b.result;
  const utterances = (Array.isArray(result?.utterances) ? result.utterances : []).filter((u) => typeof u?.text === "string" && u.text.trim());
  const text = (typeof result?.text === "string" && result.text.trim()) || utterances.map((u) => u.text).join("").trim();
  const timed = utterances.length > 0 && utterances.every((u) => typeof u.start_time === "number" && u.start_time >= 0);
  const ms = b.audio_info?.duration;
  return {
    text,
    seconds: typeof ms === "number" && ms > 0 ? ms / 1000 : null,
    cues: timed
      ? utterances.map((u) => {
          const cue: Cue = { at: (u.start_time as number) / 1000, text: (u.text as string).trim() };
          if (typeof u.end_time === "number" && u.end_time >= (u.start_time as number)) cue.end = u.end_time / 1000;
          const words = wordsOf(u);
          if (words) cue.words = words;
          return cue;
        })
      : [],
  };
}

/** 用一个服务项转一次；这项没开通返回 null（让调用方换下一项）。 */
async function recognize(cfg: AsrConfig, resourceId: string, body: string): Promise<AsrTranscript | null> {
  const res = await labeledFetch(SERVICE, ASR_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Api-Key": cfg.apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": crypto.randomUUID(),
      "X-Api-Sequence": "-1",
    },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  const code = res.headers.get("x-api-status-code");
  if (code === NOT_GRANTED) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (code && SILENT.has(code)) {
    await res.body?.cancel().catch(() => {});
    return { text: "", seconds: null, cues: [] };
  }
  if (!res.ok) throw await httpError(SERVICE, res);
  if (code && code !== OK) throw new Error(`${SERVICE} ${code}: ${res.headers.get("x-api-message") || "没有说明"}`);
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) throw new Error(`${SERVICE}返回的内容认不出来（没有 result）`);
  return parseAsrBody(parsed);
}

/**
 * 转写一段音频（mp3）：按 ASR_RESOURCES 的顺序找账号开通了的服务项。一项都没开通抛 AsrNotEnabledError；
 * 其他失败抛带接口 code / message 的错误（不再换服务项——那不是开没开通的问题）。没有人声返回空文字。
 */
export async function transcribe(cfg: AsrConfig, audio: Uint8Array): Promise<AsrResult> {
  const body = JSON.stringify({ user: { uid: "sm-intelligence" }, audio: { data: Buffer.from(audio).toString("base64") }, request: { model_name: "bigmodel" } });
  for (const resource of ASR_RESOURCES) {
    const r = await recognize(cfg, resource.id, body);
    if (r) return { ...r, countKey: resource.countKey };
  }
  throw new AsrNotEnabledError();
}
