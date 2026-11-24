import { httpError } from "@/lib/error-text";
import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import { TITLE_MAX, excerptOf, httpUrl, type Candidate, type Listing } from "./candidate";

/**
 * Hacker News 上最近带某些词的帖子：走 HN 官方用的搜索（Algolia，hn.algolia.com，免费、不要密钥、机房 IP 也能用）。
 *
 * `/api/v1/search_by_date?query=…&tags=story&numericFilters=points>=N,created_at_i>T`：新的在前，分数是现在的。
 * 两个开关是试出来的（2026-11-24）：
 * - `typoTolerance=false`：默认会容错，搜「Sora」出来 14 条全是带「sort」「solar」的；关掉之后 0 条（那一周确实没有）。
 * - `restrictSearchableAttributes=title,story_text`：只在标题和正文里找，不然网址、作者名里带这个词的也算。
 * 几个词之间是「都要有」；要整句连着出现，用引号括起来（`"AI agent"`）。
 */

const SERVICE = "Hacker News 搜索(hn.algolia.com)";
export const HN_WINDOW_DAYS = 7;
/** 一次最多取这么多条（新的在前） */
export const HN_PAGE = 50;
export const HN_QUERY_MAX = 100;

type Hit = { objectID?: unknown; title?: unknown; url?: unknown; author?: unknown; points?: unknown; num_comments?: unknown; created_at_i?: unknown; story_text?: unknown };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** story_text 是 HTML：去掉标签、还原实体，只当文字用。 */
export function plainText(html: string): string {
  return html
    .replace(/<\/?(p|br|pre|li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : key.startsWith("#") ? Number(key.slice(1)) : NaN;
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    });
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** 搜索结果里的一条 → 候选。没有 id / 标题的返回 null。 */
export function mapHnHit(raw: unknown): Candidate | null {
  const h = (raw && typeof raw === "object" ? raw : {}) as Hit;
  const id = typeof h.objectID === "string" && /^\d{1,12}$/.test(h.objectID) ? h.objectID : null;
  const title = typeof h.title === "string" ? h.title.trim() : "";
  if (!id || !title) return null;
  const discussion = `https://news.ycombinator.com/item?id=${id}`;
  const link = httpUrl(h.url);
  const created = int(h.created_at_i);
  return {
    source: "hackernews",
    externalId: id,
    // 指向一篇文章的存文章；Ask HN / Show HN 这类没有链接的存讨论页
    url: link ?? discussion,
    discussionUrl: discussion,
    title: Array.from(title).slice(0, TITLE_MAX).join(""),
    excerpt: excerptOf(typeof h.story_text === "string" ? plainText(h.story_text) : "") || (link ? `链接：${new URL(link).hostname.replace(/^www\./, "")}` : ""),
    author: typeof h.author === "string" && h.author ? h.author : null,
    channel: "Hacker News",
    score: int(h.points),
    comments: int(h.num_comments),
    publishedAt: created !== null ? new Date(created * 1000).toISOString() : null,
  };
}

export function hnSearchUrl(query: string, minScore: number, since: Date): string {
  const params = new URLSearchParams({
    query,
    tags: "story",
    numericFilters: `points>=${Math.max(0, Math.round(minScore))},created_at_i>${Math.floor(since.getTime() / 1000)}`,
    hitsPerPage: String(HN_PAGE),
    typoTolerance: "false",
    restrictSearchableAttributes: "title,story_text",
  });
  return `https://hn.algolia.com/api/v1/search_by_date?${params}`;
}

/** since 之后、分数到线、带这些词的帖子（新的在前，最多 HN_PAGE 条）。接口出错往上抛；符合的比取到的多记进 notes。 */
export async function searchHn(query: string, minScore: number, since: Date): Promise<Listing> {
  const res = await labeledFetch(SERVICE, hnSearchUrl(query, minScore, since), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw await httpError(SERVICE, res);
  const json = (await res.json()) as { hits?: unknown; nbHits?: unknown };
  if (!Array.isArray(json.hits)) throw new Error(`${SERVICE} 返回的不是搜索结果`);
  const candidates = json.hits.map(mapHnHit).filter((c): c is Candidate => c !== null);
  const total = int(json.nbHits) ?? candidates.length;
  return { candidates, notes: total > json.hits.length ? [`符合的有 ${total} 条，只取了最新的 ${json.hits.length} 条：把分数线调高，或者把词写窄一点`] : [] };
}
