import { vi } from "vitest";

// Native download transports must be explicitly mocked, just like global fetch.
vi.mock("node:http", async (original) => ({ ...await original<typeof import("node:http")>(), request: vi.fn(() => { throw new Error("单测不许真实 HTTP 连接，请模拟 publicFetch 或 node:http"); }) }));
vi.mock("node:https", async (original) => ({ ...await original<typeof import("node:https")>(), request: vi.fn(() => { throw new Error("单测不许真实 HTTPS 连接，请模拟 publicFetch 或 node:https"); }) }));

/**
 * 所有单测共用的隔离（vitest.config.ts 的 setupFiles，每个测试文件加载前跑一次）：
 *
 * 1. 清掉会连到真实服务的环境变量（本机 .env.local、云端容器里配的真实 key / 令牌）：单测一律按「没配」起步，
 *    要用的自己 vi.stubEnv。否则「配了就真发」的代码会在跑测试时打到真实账号——
 *    2026-09-28 云端容器配上真实变量后，一个 AI 生图测试把假的「媒体预算超支」推到了用户的 Telegram。
 * 2. 默认的 fetch 不许真实联网：http(s) 请求直接失败（和断网一样，报错里写明是哪个主机）；
 *    要网络的测试自己 vi.stubGlobal("fetch", …)。data: 等本地 URL 照常放行。
 */

const REAL_SERVICE_ENV =
  /^(VAULT_|WHISPER_|FFMPEG_PATH$|YTDLP_PATH$|PUBLIC_EGRESS_MODE$|TELEGRAM_|ARK_|VOLC_|ANTHROPIC_|OPENAI_|YOUTUBE_|AGENT_|MCP_|X_|REDDIT_|SUPABASE_|NEXT_PUBLIC_SUPABASE_|EXA_|BRAVE_|SERPER_|VOYAGE_|JINA_|APIFY_|KG_|INSTAGRAM_|E2E_|ACCOUNT_SECRETS_KEY$|APP_BASE_URL$|CRON_SECRET$|MEDIA_MONTHLY_BUDGET_USD$|CNY_PER_USD$)/;

for (const key of Object.keys(process.env)) {
  if (REAL_SERVICE_ENV.test(key)) delete process.env[key];
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:/i.test(url)) {
    throw new TypeError("fetch failed", { cause: new Error(`单测里不许真实联网（${new URL(url).host}）——用 vi.stubGlobal("fetch", …) 模拟`) });
  }
  return realFetch(input, init);
}) as typeof fetch;
