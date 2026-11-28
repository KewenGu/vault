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
 * - 自己跑的工具（`tools`，也只有「溯源」用）：模型说要调，这里执行、把结果交回去，它接着往下做。每交一次结果是一次新的请求，
 *   前面的内容（搜到的、读到的）要再发一遍，所以带工具的请求打开提示词缓存：再发的那部分按缓存读取的价钱算（十分之一）。
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
 * 这次联网实际做了什么。searches / fetches 是 Anthropic 记的次数（自己跑的工具读了网页也往 fetches 里加）；seen 是回包里出现过的地址；
 * errors 是没成的搜索 / 读取（「fetch:url_not_accessible」这样的写法，同一种只记一次）。
 */
export type WebUse = { searches: number; fetches: number; seen: WebSeen[]; errors: string[] };

/**
 * 一个在这边执行的工具。run 返回给模型看的文字；抛错 = 这次调用没成（错误信息交给模型，它可以换个办法）。
 * state.web 是到这一刻为止这次联网的记录：可以读（模型见过哪些地址），也可以往里记（这个工具自己读了哪个网页）。
 */
export type AskTool = {
  name: string;
  description: string;
  /** 参数的 JSON Schema */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  run: (input: unknown, state: { web: WebUse }) => Promise<string>;
};

export type AskInput = {
  system: string;
  prompt: string;
  /** 每张图前面放一行【说明】，图是 JPEG */
  images?: VisionImage[];
  maxTokens?: number;
  effort?: Effort;
  /** 给了就让模型联网搜索、读网页（见顶注） */
  web?: WebBudget;
  /** 在这边执行的工具（见顶注） */
  tools?: AskTool[];
};

export type AskResult = { text: string; model: string; truncated: boolean; web?: WebUse };

/** 一轮联网的请求被服务端暂停（pause_turn）后最多接着跑几次：防止没完没了，正常一两次就结束 */
const MAX_CONTINUATIONS = 3;
/** 模型调这边的工具最多来回几趟（一趟可以调好几个）：同样是防止没完没了，工具自己另有次数上限 */
const MAX_TOOL_ROUNDS = 12;

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
  // 工具在一轮里不能变（接着跑 pause_turn、交回工具结果时要和第一次一模一样），次数上限是跨这一轮所有请求累计的
  const own = input.tools ?? [];
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    ...(input.web
      ? ([
          { type: "web_search_20260209", name: "web_search", max_uses: input.web.searches },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: input.web.fetches, max_content_tokens: input.web.fetchTokens ?? 12_000 },
        ] satisfies Anthropic.Beta.BetaToolUnion[])
      : []),
    // 参数边生成边传过来（流式请求的默认做法）；这样接口不再替我们校验参数，各个工具的 run 自己收
    ...own.map((t): Anthropic.Beta.BetaToolUnion => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true })),
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
  const web: WebUse = { searches: 0, fetches: 0, seen: [], errors: [] };
  let text = "";
  let message: Anthropic.Beta.BetaMessage;
  let container: string | undefined;
  let pauses = 0;
  let toolRounds = 0;
  for (;;) {
    const stream = client().beta.messages.stream({
      model,
      max_tokens: input.maxTokens ?? 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: input.effort ?? vaultEffort() },
      system: input.system,
      messages,
      ...(tools.length > 0 ? { tools, cache_control: { type: "ephemeral" as const } } : {}),
      // 新版的搜索是在 Anthropic 那边的代码执行里跑的：接着跑时带上同一个容器，不然前面跑到一半的东西就丢了
      ...(container ? { container } : {}),
    });
    try {
      message = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error("ANTHROPIC_API_KEY 不对或已失效");
      if (e instanceof Anthropic.RateLimitError) throw new Error("Claude 接口限流了，过一会儿再试");
      // 组织在 Console 里关掉了联网搜索时，带着这个工具的请求直接 400
      if (input.web && e instanceof Anthropic.BadRequestError && /web (search|fetch)/i.test(e.message) && /not enabled|disabled/i.test(e.message)) {
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
    if (input.web) collectWebUse(message.content, web);
    text += message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    container = message.container?.id ?? container;
    // 服务端跑工具跑到一半先停下了：把它已经给的内容原样接在后面再发一次，它从停下的地方接着跑
    if (message.stop_reason === "pause_turn" && pauses < MAX_CONTINUATIONS) {
      pauses++;
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      continue;
    }
    // 模型要调这边的工具：一个一个跑完，结果单独放在一条 user 消息里交回去（里面不能有别的东西）
    const calls = message.stop_reason === "tool_use" ? message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use") : [];
    if (calls.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
      toolRounds++;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const tool = own.find((t) => t.name === call.name);
        try {
          if (!tool) throw new Error(`没有 ${call.name} 这个工具`);
          results.push({ type: "tool_result", tool_use_id: call.id, content: await tool.run(call.input, { web }) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: (e instanceof Error ? e.message : String(e)).slice(0, 500), is_error: true });
        }
      }
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] }, { role: "user", content: results });
      continue;
    }
    break;
  }
  if (message.stop_reason === "refusal") {
    throw new Error(`模型拒绝处理这条内容${message.stop_details?.category ? `（${message.stop_details.category}）` : ""}`);
  }
  if (message.stop_reason === "pause_turn" || message.stop_reason === "tool_use") throw new Error("Claude 联网查了很久还没查完，这次先停了。过一会儿再试");
  return { text, model: message.model, truncated: message.stop_reason === "max_tokens", ...(input.web ? { web } : {}) };
}
