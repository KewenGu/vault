/**
 * 情报的一条候选：从一个来源（Reddit 的版块、Hacker News 的搜索）看到的一条内容，还没存进库里。
 * 只有标题、链接、一小段开头和几个数字——不下载、不交给模型；要细看，存进收藏库走平常的处理。
 * 标题和开头是外部内容：页面上只当文字显示。
 */

export const INTEL_SOURCES = ["reddit", "hackernews"] as const;
export type IntelSource = (typeof INTEL_SOURCES)[number];
export const INTEL_SOURCE_LABEL: Record<IntelSource, string> = { reddit: "Reddit", hackernews: "Hacker News" };

export type Candidate = {
  source: IntelSource;
  externalId: string;
  /** 存入时用的链接 */
  url: string;
  /** 讨论页（HN：文章在别处，讨论在 HN） */
  discussionUrl: string | null;
  title: string;
  excerpt: string;
  author: string | null;
  /** 「r/LocalLLaMA」「Hacker News」 */
  channel: string;
  score: number | null;
  comments: number | null;
  publishedAt: string | null;
};

/** 一次去看的结果。notes 是没看到的（帖子太多只看了最近多少小时、符合的太多只取了最新的几条…）。 */
export type Listing = { candidates: Candidate[]; notes: string[] };

export const EXCERPT_MAX = 300;
export const TITLE_MAX = 300;

/** 一段文字的开头：空白压成一个空格，最多 EXCERPT_MAX 个字（按字不按字节，表情不会切成两半）。 */
export function excerptOf(text: string, max = EXCERPT_MAX): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

export const httpUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

/** 关键词：空白隔开，引号里的算一个词；去重，最多 12 个。 */
export function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"([^"]+)"|“([^”]+)”|(\S+)/g)) {
    const word = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (word && !out.includes(word)) out.push(word);
    if (out.length >= 12) break;
  }
  return out;
}

/** 标题或开头里带任意一个关键词（不分大小写）；没给关键词 = 全要。英文词按整词算（「agent」不匹配「reagent」），带中文的按字面找。 */
export function matchesKeywords(c: Pick<Candidate, "title" | "excerpt">, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const hay = `${c.title}\n${c.excerpt}`.toLowerCase();
  return keywords.some((word) => {
    if (!/^[\x20-\x7e]+$/.test(word)) return hay.includes(word);
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?([^a-z0-9]|$)`).test(hay);
  });
}

/** 「3 小时前」「2 天前」：页面上说一条内容是什么时候发的 / 一个来源上次是什么时候看的。 */
export function agoLabel(iso: string | null, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 36 * 60) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}
