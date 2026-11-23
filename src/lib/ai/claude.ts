import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { recordCall, recordClaudeUsage } from "@/lib/usage/meter";
import { CLAUDE_WEB_SEARCH_KEY } from "@/lib/usage/prices";

/**
 * Claude 调用的唯一出口：一次请求（可以带图）→ 一段文字。记账、拒答、截断都在这里处理，调用方只管提示词和解析。
 *
 * - 模型默认 claude-opus-5-5，`VAULT_MODEL` 可以换（比如想省钱换成 claude-sonnet-5-5）。思考是自适应的，
 *   深度用 effort 控制（`VAULT_EFFORT`，默认 medium）。
 * - 输出一律是「带标签的文字」，不用 JSON 结构化输出：模型引用原话时爱写英文双引号，JSON 字符串会在引号处断掉，
 *   后半句悄悄丢了（SM-Intelligence 2026-10-05 实测）。标签里的文字不用转义。
 * - 流式请求 + finalMessage()：带十几张图、输出几千字的请求不流式容易撞 HTTP 超时。
 * - 安全分类器拒答时，服务端自动换模型重跑同一个请求（fallbacks: "default"）；整条链都拒了才报错。
 * - 联网（`web`，只有「溯源」用）：给模型 Anthropic 的联网搜索和读网页两个工具，搜和读都在 Anthropic 那边跑，
 *   这里只管次数上限、把一轮没跑完的（pause_turn）接着跑完、记下它这次真的搜到过 / 打开过哪些地址（seen）。
 *   搜索按次另外收费（见 lib/usage/prices.ts），读网页只算 token。
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

/** 这次请求最多搜几次、读几个网页；每个网页最多放多少 token 进上下文（默认 12,000）。 */
export type WebBudget = { searches: number; fetches: number; fetchTokens?: number };
/** 模型这次见过的一个地址：read = 打开读过，search = 只在搜索结果里出现过。 */
export type WebSeen = { url: string; title: string; how: "read" | "search" };
/**
 * 这次联网实际做了什么。searches / fetches 是 Anthropic 记的次数；seen 是回包里出现过的地址；
 * errors 是没成的搜索 / 读取（「fetch:url_not_accessible」这样的写法，同一种只记一次）。
 */
export type WebUse = { searches: number; fetches: number; seen: WebSeen[]; errors: string[] };

export type AskInput = {
  system: string;
  prompt: string;
  /** 每张图前面放一行【说明】，图是 JPEG */
  images?: VisionImage[];
  maxTokens?: number;
  effort?: Effort;
  /** 给了就让模型联网搜索、读网页（见顶注） */
  web?: WebBudget;
};

export type AskResult = { text: string; model: string; truncated: boolean; web?: WebUse };

/** 一轮联网的请求被服务端暂停（pause_turn）后最多接着跑几次：防止没完没了，正常一两次就结束 */
const MAX_CONTINUATIONS = 3;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]}，。；、]+/g;

/**
 * 从回包的内容块里收出模型这次见过的地址和没成的调用。按形状找而不是按块的位置找：搜索和读网页可能是模型直接调的，
 * 也可能是它在代码执行里调的（新版工具的「动态过滤」），结果块嵌在哪一层不一定；代码执行的输出里打印出来的地址也算见过（按搜索算）。
 */
export function collectWebUse(content: unknown, into: Pick<WebUse, "seen" | "errors">): void {
  const add = (url: string, title: string, how: WebSeen["how"]) => {
    const had = into.seen.find((s) => s.url === url);
    if (!had) into.seen.push({ url, title, how });
    else if (how === "read") had.how = "read";
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : "";
    if (o.type === "web_search_result" && typeof o.url === "string") add(o.url, title, "search");
    else if (o.type === "web_fetch_result" && typeof o.url === "string") add(o.url, title, "read");
    else if ((o.type === "web_search_tool_result_error" || o.type === "web_fetch_tool_result_error") && typeof o.error_code === "string") {
      const error = `${o.type === "web_search_tool_result_error" ? "search" : "fetch"}:${o.error_code}`;
      if (!into.errors.includes(error)) into.errors.push(error);
    }
    if (typeof o.stdout === "string") for (const m of o.stdout.matchAll(URL_IN_TEXT)) add(m[0], "", "search");
    for (const v of Object.values(o)) visit(v);
  };
  visit(content);
}

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
  // 工具在一轮里不能变（接着跑 pause_turn 时要和第一次一模一样），次数上限是跨这一轮所有请求累计的
  const tools: Anthropic.Beta.BetaToolUnion[] | undefined = input.web
    ? [
        { type: "web_search_20260209", name: "web_search", max_uses: input.web.searches },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: input.web.fetches, max_content_tokens: input.web.fetchTokens ?? 12_000 },
      ]
    : undefined;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
  const web: WebUse = { searches: 0, fetches: 0, seen: [], errors: [] };
  let text = "";
  let message: Anthropic.Beta.BetaMessage;
  for (let round = 0; ; round++) {
    const stream = client().beta.messages.stream({
      model,
      max_tokens: input.maxTokens ?? 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: input.effort ?? vaultEffort() },
      system: input.system,
      messages,
      ...(tools ? { tools } : {}),
    });
    try {
      message = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error("ANTHROPIC_API_KEY 不对或已失效");
      if (e instanceof Anthropic.RateLimitError) throw new Error("Claude 接口限流了，过一会儿再试");
      // 组织在 Console 里关掉了联网搜索时，带着这个工具的请求直接 400
      if (tools && e instanceof Anthropic.BadRequestError && /web (search|fetch)/i.test(e.message) && /not enabled|disabled/i.test(e.message)) {
        throw new Error("Claude 接口这边没开联网搜索：在 Anthropic Console 的 Settings → Capabilities 里打开 Web search / Web fetch");
      }
      if (e instanceof Anthropic.APIError) throw new Error(`Claude 接口出错（${e.status ?? "网络"}）：${e.message.slice(0, 200)}`);
      throw e;
    }
    // 换过模型的话 message.model 是实际跑的那个：按它记账
    recordClaudeUsage(message.model, message.usage);
    const used = message.usage.server_tool_use;
    if (used) {
      recordCall(CLAUDE_WEB_SEARCH_KEY, used.web_search_requests);
      web.searches += used.web_search_requests;
      web.fetches += used.web_fetch_requests;
    }
    if (tools) collectWebUse(message.content, web);
    text += message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    // 服务端跑工具跑到一半先停下了：把它已经给的内容原样接在后面再发一次，它从停下的地方接着跑
    if (message.stop_reason !== "pause_turn" || round >= MAX_CONTINUATIONS) break;
    messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
  }
  if (message.stop_reason === "refusal") {
    throw new Error(`模型拒绝处理这条内容${message.stop_details?.category ? `（${message.stop_details.category}）` : ""}`);
  }
  if (message.stop_reason === "pause_turn") throw new Error("Claude 联网查了很久还没查完，这次先停了。过一会儿再试");
  return { text, model: message.model, truncated: message.stop_reason === "max_tokens", ...(tools ? { web } : {}) };
}
