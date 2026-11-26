import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { embedTexts } from "@/lib/embeddings";
import { clock, parseTranscript } from "@/lib/media/transcript";
import { unmetered } from "@/lib/usage/meter";
import { ITEM_LIST_COLUMNS, getItemsInOrder, toItem, type Item } from "./store";

/**
 * 搜索收藏库：关键词 + 语义，在数据库里融合排序（函数 search_items，见迁移）。
 *
 * - 关键词：把输入按空白拆成词（引号里的算一个词），每个词在标题 / 标签 / 概括 / 全文里按字面找。中文不分词：
 *   「三亚 酒店」是两个词，「三亚酒店」是一个词——要更宽的结果靠语义那一路补。
 * - 语义：整句话算一个向量（Voyage），和每条内容的向量比。没配 VOYAGE_API_KEY 或接口出错时只走关键词，搜索照常能用。
 *
 * 翻页（给了 offset）分两种情况：
 * - 只是列出 / 筛选（没有搜索词、没有按实体筛）：直接按时间倒序查表，一页一页往后翻，翻得到最早的一条，total 是确切的条数。
 * - 搜索、或者按图谱里的一个实体筛：走数据库函数 search_items，它按相关程度排、最多给 SEARCH_CAP 条（函数里写死的上限），
 *   只能在这些里面翻；到了上限 capped = true，页面上要说「只列了最相关的前 200 条」，不让人以为后面没有了。
 */

type Db = SupabaseClient<Database>;

export type SearchFilters = Partial<{ kind: string; contentType: string; category: string; tag: string; platform: string; source: string; entityId: string }>;

const TERMS_MAX = 8;
/** 首页一页列多少条 */
export const PAGE_SIZE = 60;
/** search_items 一次最多给这么多条（迁移里的函数写死的：`least(p_limit, 200)`） */
export const SEARCH_CAP = 200;

/** 输入 → 关键词（纯函数）。去重，最多 8 个；只有一个字符的英文 / 数字不要（太宽）。 */
export function parseQuery(q: string): string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|“([^”]+)”|「([^」]+)」|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!t || (t.length === 1 && /[\x00-\x7f]/.test(t))) continue;
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
    if (terms.length >= TERMS_MAX) break;
  }
  return terms;
}

/** ilike 里的通配符按字面找 */
export const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

export type Snippet = { text: string; at: number | null; where: "口播" | "正文" | "图中文字" | "要点" | "大纲" };

/** 一段文字里命中处前后各留一点（纯函数）。 */
function around(text: string, index: number, length: number, radius = 60): string {
  const chars = text.replace(/\s+/g, " ");
  const i = Math.max(0, index - radius);
  const j = Math.min(chars.length, index + length + radius);
  return `${i > 0 ? "…" : ""}${chars.slice(i, j).trim()}${j < chars.length ? "…" : ""}`;
}

/**
 * 关键词具体落在这条内容的哪里（纯函数）：标题 / 概括已经显示在卡片上，这里找卡片上看不到的地方——
 * 口播（带时间，点了能跳到那一秒）、要点、大纲（思维导图的节点）、图里的字、正文。都没有返回 null（多半是语义命中的）。
 */
export function findSnippet(item: Pick<Item, "transcript" | "understanding" | "userText" | "post">, terms: string[]): Snippet | null {
  const lower = terms.map((t) => t.toLowerCase());
  const hit = (text: string) => {
    const hay = text.toLowerCase();
    for (const t of lower) {
      const i = hay.indexOf(t);
      if (i >= 0) return { i, n: t.length };
    }
    return null;
  };
  if (item.transcript) {
    for (const line of parseTranscript(item.transcript)) {
      const h = hit(line.text);
      if (h) return { text: around(line.text, h.i, h.n), at: line.at, where: "口播" };
    }
  }
  for (const p of item.understanding?.points ?? []) {
    const h = hit(p.text);
    if (h) return { text: around(p.text, h.i, h.n), at: p.at, where: "要点" };
  }
  for (const n of item.understanding?.outline ?? []) {
    const h = hit(n.text);
    if (h) return { text: around(n.text, h.i, h.n), at: n.at, where: "大纲" };
  }
  const ocr = item.understanding?.ocr ?? "";
  const o = ocr ? hit(ocr) : null;
  if (o) return { text: around(ocr, o.i, o.n), at: null, where: "图中文字" };
  const body = item.userText || item.post.text;
  const b = body ? hit(body) : null;
  if (b) return { text: around(body, b.i, b.n), at: null, where: "正文" };
  return null;
}

export const snippetTime = (s: Snippet) => (s.at === null ? "" : clock(s.at));

export type SearchHit = { item: Item; keywordHits: number; similarity: number | null; snippet: Snippet | null };
/**
 * total = 符合条件的一共多少条（翻页用）。capped = 结果到了 search_items 的上限，实际符合的可能更多，total 只是上限那么多。
 * 没给 offset 的调用（「问」、导图对话：只要最相关的几条）total 就是这次拿到的条数。
 */
export type SearchResult = { hits: SearchHit[]; terms: string[]; semantic: boolean; total: number; capped: boolean };

async function queryEmbedding(q: string): Promise<number[] | null> {
  if (!process.env.VOYAGE_API_KEY) return null;
  try {
    // 每次搜索一次、单次不到十万分之一美元：不记到任何一条内容上
    const [v] = await unmetered("搜索时的查询向量", () => embedTexts([q.slice(0, 500)], "query"));
    return v ?? null;
  } catch (e) {
    console.error(`搜索：查询向量没算出来，只按关键词搜：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 只是列出 / 筛选时直接查表：按存进来的时间倒序，一页一页往后翻。条件和 search_items 里的一样（还在等上传的不列）。 */
async function browseItems(db: Db, userId: string, f: SearchFilters, limit: number, offset: number): Promise<{ items: Item[]; total: number }> {
  const filtered = () => {
    let query = db.from("items").select(ITEM_LIST_COLUMNS, { count: "exact" }).eq("user_id", userId).neq("status", "uploading");
    if (f.kind) query = query.eq("kind", f.kind);
    if (f.contentType) query = query.eq("content_type", f.contentType);
    if (f.category) query = query.eq("category", f.category);
    if (f.tag) query = query.contains("tags", [f.tag]);
    if (f.platform) query = query.eq("platform", f.platform);
    if (f.source) query = query.eq("source", f.source);
    return query;
  };
  const { data, error, count } = await filtered().order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1);
  if (error) {
    // 翻到了最后一条之后（内容删了、地址里的页码是旧的）：PostgREST 回 416，不是出错——这一页是空的，条数另数一遍
    if (error.code !== "PGRST103") throw new Error(`读取收藏库失败: ${error.message}`);
    const { count: total, error: countError } = await filtered().limit(1);
    if (countError) throw new Error(`读取收藏库失败: ${countError.message}`);
    return { items: [], total: total ?? 0 };
  }
  return { items: (data ?? []).map(toItem), total: count ?? (data ?? []).length };
}

/**
 * 搜索 / 筛选 / 列出。q 为空时按时间倒序列出（带筛选）。
 * offset 给了 = 翻页（首页、接口）：从第 offset 条开始的 limit 条，total 是一共多少条（见顶注的两种情况）。
 */
export async function searchItems(db: Db, userId: string, input: { q?: string; filters?: SearchFilters; limit?: number; offset?: number }): Promise<SearchResult> {
  const q = (input.q ?? "").trim();
  const terms = parseQuery(q);
  const f = input.filters ?? {};
  const limit = Math.max(1, Math.min(input.limit ?? PAGE_SIZE, SEARCH_CAP));
  const paged = input.offset !== undefined;
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  if (paged && !q && !f.entityId) {
    const { items, total } = await browseItems(db, userId, f, limit, offset);
    return { hits: items.map((item) => ({ item, keywordHits: 0, similarity: null, snippet: null })), terms, semantic: false, total, capped: false };
  }
  const embedding = q ? await queryEmbedding(q) : null;
  const { data, error } = await db.rpc("search_items", {
    p_user_id: userId,
    p_terms: terms.map(escapeLike),
    p_embedding: embedding ? JSON.stringify(embedding) : null,
    p_kind: f.kind || null,
    p_content_type: f.contentType || null,
    p_category: f.category || null,
    p_tag: f.tag || null,
    p_platform: f.platform || null,
    p_source: f.source || null,
    p_entity_id: f.entityId || null,
    // 翻页时把能给的都要来（只是 id 和几个数），才知道一共多少条、切得出后面的页
    p_limit: paged ? SEARCH_CAP : limit,
  });
  if (error) throw new Error(`搜索失败: ${error.message}`);
  const all = data ?? [];
  const rows = paged ? all.slice(offset, offset + limit) : all;
  // 有关键词时带上口播 / 正文，好摘出命中的那句话
  const items = await getItemsInOrder(db, userId, rows.map((r) => r.id), terms.length > 0);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    hits: items.map((item) => {
      const r = byId.get(item.id)!;
      return { item, keywordHits: r.keyword_hits, similarity: r.similarity, snippet: terms.length > 0 && r.keyword_hits > 0 ? findSnippet(item, terms) : null };
    }),
    terms,
    semantic: embedding !== null,
    total: all.length,
    capped: paged && all.length >= SEARCH_CAP,
  };
}
