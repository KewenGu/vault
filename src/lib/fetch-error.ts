/**
 * Node（undici）的 fetch 连不上对端时只抛一句 `TypeError: fetch failed`，真正原因（ECONNREFUSED /
 * ENOTFOUND / 连接超时…）藏在 `err.cause` 里。WDK step 失败只把 `error.message` 带进失败信封，
 * 图谱详情页横幅上就只剩「fetch failed」——看不出是哪个服务、怎么失败的（2026-09 实例：账号图谱
 * 刷新失败，本地 Ollama 没开与 Voyage 网络不通两种可能无从区分）。
 *
 * 在直接调 fetch 的外部服务调用点用 `labeledFetch` 替代：网络层失败时把「服务名 + 底层原因」写进
 * message，原错误挂 `cause`；HTTP 非 2xx 不归这里管（调用方照旧按 status 抛自己的错）。
 * 服务名只写服务与主机，**不要**带完整 URL——部分调用点的 URL 带 token（如 Apify）。
 */

/** 从 undici 的 cause 里取人读得懂的原因。localhost 同时解析到 ::1 与 127.0.0.1 时（Node 的
 *  happy-eyeballs），cause 是 message 为空的 AggregateError，真正的每条失败在 `errors` 里。 */
function causeDetail(cause: unknown): string {
  if (cause === undefined || cause === null) return "未知原因";
  if (!(cause instanceof Error)) return String(cause);
  let msg = cause.message;
  if (!msg && cause instanceof AggregateError) {
    msg = [...new Set(cause.errors.map((e) => (e instanceof Error ? e.message : String(e))))].join("; ");
  }
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && !msg.includes(code)) msg = msg ? `${code} ${msg}` : code;
  return msg || cause.name;
}

/** 把 fetch 的网络层失败改写成带服务名与底层原因的错误；其他错误原样返回（供 `throw` 直接用）。 */
export function explainFetchError(err: unknown, service: string): unknown {
  // AbortSignal.timeout 触发时 fetch 以 name='TimeoutError' 的 DOMException reject。
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError") {
    return new Error(`${service} 请求超时: ${(err as { message?: string }).message ?? ""}`.trim(), { cause: err });
  }
  if (err instanceof TypeError && err.message === "fetch failed") {
    return new Error(`${service} 连接失败: ${causeDetail(err.cause)}`, { cause: err });
  }
  return err;
}

/** 同 fetch，但网络层失败时抛出带服务名与底层原因的错误（见文件顶注）。 */
export async function labeledFetch(service: string, input: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    throw explainFetchError(err, service);
  }
}
