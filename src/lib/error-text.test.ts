import { describe, it, expect } from "vitest";
import { httpError, summarizeErrorText } from "./error-text";

const BRAVE_429 =
  '{"type":"ErrorResponse","error":{"id":"8ccdf197","status":429,"detail":"Request rate limit exceeded for plan","meta":{"plan":"Free","rate_limit":1,"rate_current":1,"quota_limit":2000,"quota_current":89},"code":"RATE_LIMITED"},"time":1784404257}';
const REDDIT_403 =
  '<body class=theme-beta><div><style>.theme-light,:root{--rem360:22.5rem;--rem320:20rem}</style><p>You\'ve been blocked by network security.</p><p>To continue, log in to your Reddit account or use your developer token</p></div><script>var x = 1;</script></body>';

describe("summarizeErrorText", () => {
  it("Brave 的 JSON 错误：只留 detail 与错误码", () => {
    expect(summarizeErrorText(BRAVE_429)).toBe("Request rate limit exceeded for plan (RATE_LIMITED)");
    // 数据库里存的旧消息带「源 状态码:」前缀
    expect(summarizeErrorText(`brave 429: ${BRAVE_429}`)).toBe("brave 429: Request rate limit exceeded for plan (RATE_LIMITED)");
  });

  it("Reddit 的拦截网页：去掉样式、脚本与标签，只留正文", () => {
    expect(summarizeErrorText(`reddit 403: ${REDDIT_403}`)).toBe(
      "reddit 403: You've been blocked by network security. To continue, log in to your Reddit account or use your developer token"
    );
  });

  it("截断；纯样式没有正文时给占位说明；普通文本（含花括号）原样", () => {
    expect(summarizeErrorText("x".repeat(500))).toHaveLength(200);
    expect(summarizeErrorText("<style>a{b:c}</style>")).toBe("（对方返回了一个网页，没有可读的错误信息）");
    expect(summarizeErrorText("timeout after {20s}")).toBe("timeout after {20s}");
    expect(summarizeErrorText("  多行\n\n  文本  ")).toBe("多行 文本");
  });

  it("httpError：<服务> <状态码>: <要点>", async () => {
    const err = await httpError("brave", new Response(BRAVE_429, { status: 429 }));
    expect(err.message).toBe("brave 429: Request rate limit exceeded for plan (RATE_LIMITED)");
  });
});
