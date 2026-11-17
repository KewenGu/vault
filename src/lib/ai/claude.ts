import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { recordClaudeUsage } from "@/lib/usage/meter";

/**
 * Claude 调用的唯一出口：一次请求（可以带图）→ 一段文字。记账、拒答、截断都在这里处理，调用方只管提示词和解析。
 *
 * - 模型默认 claude-opus-5-5，`VAULT_MODEL` 可以换（比如想省钱换成 claude-sonnet-5-5）。思考是自适应的，
 *   深度用 effort 控制（`VAULT_EFFORT`，默认 medium）。
 * - 输出一律是「带标签的文字」，不用 JSON 结构化输出：模型引用原话时爱写英文双引号，JSON 字符串会在引号处断掉，
 *   后半句悄悄丢了（SM-Intelligence 2026-10-05 实测）。标签里的文字不用转义。
 * - 流式请求 + finalMessage()：带十几张图、输出几千字的请求不流式容易撞 HTTP 超时。
 * - 安全分类器拒答时，服务端自动换模型重跑同一个请求（fallbacks: "default"）；整条链都拒了才报错。
 */

export const DEFAULT_MODEL = "claude-opus-5-5";
export const vaultModel = () => process.env.VAULT_MODEL?.trim() || DEFAULT_MODEL;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
const vaultEffort = (): Effort => EFFORTS.find((e) => e === process.env.VAULT_EFFORT?.trim()) ?? "medium";

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super("没配 ANTHROPIC_API_KEY，没法理解内容");
    this.name = "ClaudeNotConfiguredError";
  }
}

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new ClaudeNotConfiguredError();
  // 长请求（十几张图）单次最多等 10 分钟；重试交给 SDK（429 / 5xx / 断线，默认 2 次）
  return (cached ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

export type VisionImage = { caption: string; data: Uint8Array };

export type AskInput = {
  system: string;
  prompt: string;
  /** 每张图前面放一行【说明】，图是 JPEG */
  images?: VisionImage[];
  maxTokens?: number;
  effort?: Effort;
};

export type AskResult = { text: string; model: string; truncated: boolean };

/** 问一次，拿回全部文字。拒答抛错；输出撞到 maxTokens 时 truncated = true（调用方决定要不要重做）。 */
export async function askClaude(input: AskInput): Promise<AskResult> {
  const model = vaultModel();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: input.prompt },
    ...(input.images ?? []).flatMap((img): Anthropic.Beta.BetaContentBlockParam[] => [
      { type: "text", text: `【${img.caption}】` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(img.data).toString("base64") } },
    ]),
  ];
  const stream = client().beta.messages.stream({
    model,
    max_tokens: input.maxTokens ?? 16_000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: input.effort ?? vaultEffort() },
    system: input.system,
    messages: [{ role: "user", content }],
  });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("ANTHROPIC_API_KEY 不对或已失效");
    if (e instanceof Anthropic.RateLimitError) throw new Error("Claude 接口限流了，过一会儿再试");
    if (e instanceof Anthropic.APIError) throw new Error(`Claude 接口出错（${e.status ?? "网络"}）：${e.message.slice(0, 200)}`);
    throw e;
  }
  // 换过模型的话 message.model 是实际跑的那个：按它记账
  recordClaudeUsage(message.model, message.usage);
  if (message.stop_reason === "refusal") {
    throw new Error(`模型拒绝处理这条内容${message.stop_details?.category ? `（${message.stop_details.category}）` : ""}`);
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { text, model: message.model, truncated: message.stop_reason === "max_tokens" };
}
