import { AsyncLocalStorage } from "node:async_hooks";
import { tokenKey } from "./prices";

/**
 * 用量计量域：一次「操作」（一个 workflow step、一个 server action）开一个域，域内发生的所有 LLM / 向量 /
 * 按次计费的调用把真实用量记进这个域的 counts；域结束时由调用方并进这条内容的账（items.usage）。
 * 用 AsyncLocalStorage 而不是层层传参：调用链很深，域对并发天然透明。
 *
 * 约定：
 * - 域不嵌套冒泡：内层域只进它自己的 sink，不再加到外层——避免调用方又把内层结果并进外层时双计。
 * - 域外发生的计费调用会 console.error 留痕（「未计量」= 这笔钱不会记到任何一条内容上，是个要修的漏洞）；
 *   刻意不计的调用（每次打开页面都会触发、单次不到十万分之一美元的即时向量搜索）用 `unmetered` 包起来。
 * - 只在 step / server action 内使用，绝不在 workflow 主体里用（本模块依赖 node:async_hooks）。
 */

type Scope = { counts: Record<string, number>; ignoredReason?: string };
const als = new AsyncLocalStorage<Scope>();

function add(counts: Record<string, number>, key: string, n: number) {
  counts[key] = (counts[key] ?? 0) + n;
}

/**
 * 在一个新的计量域里跑 fn，结束时（成功或抛错都算——钱已经花了）把域内 counts 加进 sink。
 * sink 通常就是本次操作的 costCounts 累加器。
 */
export async function meterInto<T>(sink: Record<string, number>, fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { counts: {} };
  try {
    return await als.run(scope, fn);
  } finally {
    for (const [k, n] of Object.entries(scope.counts)) add(sink, k, n);
  }
}

/** 刻意不计量的调用（见顶注）；reason 只用于代码可读性与调试。 */
export async function unmetered<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ counts: {}, ignoredReason: reason }, fn);
}

function record(key: string, n: number, what: string) {
  if (!(n > 0)) return;
  const scope = als.getStore();
  if (!scope) {
    console.error(`未计量的计费调用: ${what} ${key}=${n}——调用方需要用 meterInto 包住`);
    return;
  }
  if (scope.ignoredReason) return;
  add(scope.counts, key, n);
}

/** Anthropic Messages API 的 `usage` 里本模块用到的字段（input_tokens 不含缓存读写）。 */
export type ClaudeUsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** 记一次 Claude 调用的真实 token 用量。model 用回包里的（发生兜底换模型时，按实际跑的那个记）。 */
export function recordClaudeUsage(model: string, usage: ClaudeUsageLike | undefined | null) {
  if (!usage) return;
  const what = `LLM anthropic/${model}`;
  record(tokenKey("tok_in", "anthropic", model), usage.input_tokens ?? 0, what);
  record(tokenKey("tok_cr", "anthropic", model), usage.cache_read_input_tokens ?? 0, what);
  record(tokenKey("tok_cw", "anthropic", model), usage.cache_creation_input_tokens ?? 0, what);
  record(tokenKey("tok_out", "anthropic", model), usage.output_tokens ?? 0, what);
}

/** 记一次向量调用的真实 token 用量。 */
export function recordEmbeddingUsage(provider: string, model: string, tokens: number | undefined | null) {
  if (tokens == null) return;
  record(tokenKey("tok_embed", provider, model), tokens, `向量 ${provider}/${model}`);
}

/** 记一次按次计价的外部调用（搜索 / 抓取 / Apify 等），key 取 UNIT_USD 里的键。 */
export function recordCall(key: string, n = 1) {
  record(key, n, "调用");
}

/** Record successful external requests at the HTTP boundary. Cache hits never reach this function.
 * Rejected requests are unbilled; timeouts/5xx have unknown billing and are tracked separately. */
export async function meteredProviderFetch(key: string, input: string | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) { recordCall(`uncertain|${key}`); throw error; }
  if (response.ok) recordCall(key);
  else if (![400, 401, 403, 404, 422, 429].includes(response.status)) recordCall(`uncertain|${key}`);
  return response;
}
