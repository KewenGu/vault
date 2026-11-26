/**
 * 用量 → 花费。一次处理（读取、转写、理解、建索引）里发生的调用按「计数键」累加（见 meter.ts），这里把计数换成美元。
 * 零依赖纯常量：workflow 主体也可能引用，不能带运行时模块。价格变了只改这里。
 *
 * Claude 价格：platform.claude.com/docs/en/about-claude/pricing（2026-11 核对）。缓存写按 5 分钟 TTL（1.25×）。
 */

export const TOKEN_KINDS = ["tok_in", "tok_out", "tok_cw", "tok_cr", "tok_embed"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export function tokenKey(kind: TokenKind, provider: string, model: string): string {
  return `${kind}|${provider}|${model}`;
}

export function parseTokenKey(key: string): { kind: TokenKind; provider: string; model: string } | null {
  const [kind, provider, ...rest] = key.split("|");
  if (!(TOKEN_KINDS as readonly string[]).includes(kind) || !provider || rest.length === 0) return null;
  return { kind: kind as TokenKind, provider, model: rest.join("|") };
}

type TokenPrices = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** 美元 / 百万 token */
export const CLAUDE_PRICES_PER_MTOK: Record<string, TokenPrices> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
/** 表里没有的模型按 Opus 5.5 估（宁可多算） */
const UNKNOWN_CLAUDE_PRICES = CLAUDE_PRICES_PER_MTOK["claude-opus-5-5"];

export const EMBED_PRICES_PER_MTOK: Record<string, number> = { "voyage-3.5-lite": 0.02 };

const CNY_PER_USD = 7.2;
const cnyToUsd = (cny: number) => cny / CNY_PER_USD;

// 语音识别（按音频秒数）：豆包极速版 ¥4.5 / 小时、录音文件识别 2.0 ¥0.8 / 小时；OpenAI whisper-1 $0.006 / 分钟
export const ASR_COUNT_KEY = "asr_flash_sec";
export const ASR2_COUNT_KEY = "asr_seed2_sec";
export const OPENAI_ASR_COUNT_KEY = "asr_openai_sec";

/** Claude 的联网搜索：$10 / 1000 次，搜出来的内容另按 token 算；读网页（web fetch）不另收费（2026-11-23 核对） */
export const CLAUDE_WEB_SEARCH_KEY = "claude_web_search";

/** 按次 / 按秒计价的调用（美元）。键就是 recordCall 用的计数键。 */
export const UNIT_USD: Record<string, number> = {
  [CLAUDE_WEB_SEARCH_KEY]: 0.01,
  jina_fetch: 0.0005,
  apify_douyin_post: 0.01,
  // 列一个账号的作品（lib/sources/account-apify.ts）：按列出来的条数
  apify_douyin_profile_post: 0.005,
  apify_tiktok_profile_post: 0.002,
  apify_instagram_post: 0.003,
  apify_youtube_video: 0.004,
  apify_youtube_download_minute: 0.000011,
  [ASR_COUNT_KEY]: cnyToUsd(4.5 / 3600),
  [ASR2_COUNT_KEY]: cnyToUsd(0.8 / 3600),
  [OPENAI_ASR_COUNT_KEY]: 0.006 / 60,
};

/** 一组计数值多少美元。认不出的键不计（`uncertain|…` 这类「不确定有没有扣费」的也不计）。 */
export function estimateUsd(counts: Record<string, number>): number {
  let usd = 0;
  for (const [key, n] of Object.entries(counts)) {
    const tok = parseTokenKey(key);
    if (tok) {
      if (tok.kind === "tok_embed") usd += (n / 1e6) * (EMBED_PRICES_PER_MTOK[tok.model] ?? 0.02);
      else {
        const p = CLAUDE_PRICES_PER_MTOK[tok.model] ?? UNKNOWN_CLAUDE_PRICES;
        const per = tok.kind === "tok_in" ? p.input : tok.kind === "tok_out" ? p.output : tok.kind === "tok_cw" ? p.cacheWrite : p.cacheRead;
        usd += (n / 1e6) * per;
      }
    } else if (key in UNIT_USD) usd += n * UNIT_USD[key];
  }
  return Math.round(usd * 1e6) / 1e6;
}
