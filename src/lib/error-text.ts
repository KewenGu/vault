/**
 * 第三方接口的错误正文 → 一句人能读的话（2026-09：Reddit 403 返回整页拦截网页、Brave 429 返回一大段
 * JSON，原样写进 stats 后趋势雷达的源衰减横幅被撑满整屏）。
 *
 * - JSON：取 detail / message / description / error 等字段（Brave 429 →
 *   `Request rate limit exceeded for plan (RATE_LIMITED)`）；
 * - HTML：去掉 style / script 块与标签，只留正文文字（Reddit 403 → `You've been blocked by network security…`）；
 * - 折叠空白，截断到 limit。
 * 纯函数、零依赖——也用来清洗数据库里已经存下的旧错误（见 monitoring.ts::detectSourceDecay）。
 */

export const ERROR_TEXT_LIMIT = 200;

function clip(s: string, limit: number): string {
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** 从常见的错误 JSON 形状里取出人读的那句话；取不到返回 null。 */
function fromJson(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const text =
    fromJson(o.detail) ?? fromJson(o.message) ?? fromJson(o.description) ?? fromJson(o.error) ?? fromJson(o.title);
  if (!text) return null;
  const code = typeof o.code === "string" && !text.includes(o.code) ? ` (${o.code})` : "";
  return `${text}${code}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(style|script)\b[\s\S]*$/gi, " ") // 被截断、没有闭合的 style / script
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export function summarizeErrorText(text: string, limit = ERROR_TEXT_LIMIT): string {
  let s = text ?? "";
  // 整段或「前缀 + JSON」（如 `brave 429: {...}`）：把 JSON 部分换成它的要点
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const picked = fromJson(JSON.parse(s.slice(start, end + 1)));
      if (picked) s = `${s.slice(0, start)}${picked}${s.slice(end + 1)}`;
    } catch {
      // 不是合法 JSON，按普通文本处理
    }
  }
  if (/<[a-z!/][^>]*>/i.test(s)) {
    const stripped = stripHtml(s).replace(/\s+/g, " ").trim();
    s = stripped || "（对方返回了一个网页，没有可读的错误信息）";
  }
  return clip(s.replace(/\s+/g, " ").trim(), limit);
}

/** 抛给上层的 HTTP 错误：`<服务> <状态码>: <要点>`。 */
export async function httpError(service: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${service} ${res.status}: ${summarizeErrorText(body) || res.statusText || "无响应正文"}`);
}
