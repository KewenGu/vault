import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { selectAll } from "@/lib/db/select-all";
import { entitiesOfItem } from "@/lib/graph/data";
import { getItemsInOrder, type Item } from "./store";
import type { EntityType } from "./taxonomy";

/**
 * 一条内容的「相关的内容」：收藏库里和它有关系的其他内容（详情页用）。不调模型、不另外花钱，两路都是现成的数据：
 *
 * - 内容相近：拿这条内容自己的向量（处理时算好存着的）去和别的内容比，用的就是搜索的那个数据库函数（search_items）。
 * - 提到同一个人 / 地方 / 东西：知识图谱里和它连着同一个实体的内容。每条都说得出为什么相关（「都提到：亚特兰蒂斯」）。
 *
 * 排序：内容相近的在前（相似度，加上共同提到的东西的分），只靠共同提到的排在后面、而且要够「稀有」才算——
 * 一个被几十条内容提到的实体（「小红书」「中国」）说明不了两条内容有关系。
 *
 * 「没看到」和「没有」分开：这条内容没有向量、某一路查询出错时，记进 notes，页面上写出来。
 */

type Db = SupabaseClient<Database>;

/** 最多列这么多条 */
export const RELATED_MAX = 6;
/**
 * 两条内容的向量有多像才算「内容相近」。比搜索的门槛（0.35，一句话对一条内容）高得多：两条内容之间的相似度本来就高。
 * 2026-11-26 用真实的 Voyage（voyage-3.5-lite）量了 12 条编的内容、按应用里向量用的那种文字写的：
 * 讲同一件事的几对在 0.69–0.80（两条应急金 0.76，中英文的同一道菜 0.80，三亚的酒店和海鲜店 0.69），
 * 不相关的最高到 0.67（理财和睡眠），大多在 0.45–0.62。间隔很窄，样本也小——真实的收藏多了之后要再校准。
 */
export const RELATED_MIN_SIMILARITY = 0.68;
/** 共同提到的东西在总分里最多占这么多（相似度是 0–1） */
const SHARED_WEIGHT = 0.25;
/** 只靠共同提到的东西（内容不相近）时，稀有度的分要到这么多才列出来：等于一个只有它们两条提到的实体的一半 */
const SHARED_ONLY_MIN = 0.5;

export type SharedEntity = { id: string; name: string; type: EntityType };
export type RelatedItem = {
  item: Item;
  /** 向量的相似度（0–1）；不是靠内容相近找到的是 null */
  similarity: number | null;
  /** 两条内容都提到的人 / 地方 / 东西，稀有的在前 */
  shared: SharedEntity[];
};
export type Related = { items: RelatedItem[]; notes: string[] };

export type Candidate = { id: string; similarity: number | null; shared: { id: string; others: number }[] };

/**
 * 候选排序（纯函数）。shared 里每个实体带着 others = 除了这条内容以外还有几条内容提到它：只有一条提到的记 1 分，
 * n 条提到的每条记 1/n 分——越多内容提到的实体越说明不了什么。
 * 返回要列出来的，按分数从高到低；只靠共同提到、分又不够的不要。
 */
export function rankRelated(candidates: Candidate[], max = RELATED_MAX): (Candidate & { score: number })[] {
  return candidates
    .map((c) => {
      const rarity = c.shared.reduce((sum, e) => sum + 1 / Math.max(1, e.others), 0);
      return { rarity, ranked: { ...c, shared: [...c.shared].sort((a, b) => a.others - b.others), score: (c.similarity ?? 0) + SHARED_WEIGHT * Math.min(1, rarity) } };
    })
    .filter((c) => c.ranked.similarity !== null || c.rarity >= SHARED_ONLY_MIN)
    .map((c) => c.ranked)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, max);
}

/** 内容相近的：这条内容自己的向量 → search_items。这条没有向量时返回 null（不是「没有相近的」）。 */
async function similarTo(db: Db, userId: string, itemId: string): Promise<Map<string, number> | null> {
  const { data: row, error } = await db.from("items").select("embedding").eq("id", itemId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`读取向量失败: ${error.message}`);
  if (!row?.embedding) return null;
  const { data, error: rpcError } = await db.rpc("search_items", {
    p_user_id: userId,
    p_terms: [],
    p_embedding: row.embedding,
    p_min_similarity: RELATED_MIN_SIMILARITY,
    // 多要几条：它自己一定在里面（相似度 1），还没处理好的后面也会去掉
    p_limit: RELATED_MAX * 2 + 1,
  });
  if (rpcError) throw new Error(`按向量找相近的内容失败: ${rpcError.message}`);
  return new Map((data ?? []).flatMap((r) => (r.id !== itemId && r.similarity !== null ? [[r.id, r.similarity] as const] : [])));
}

/** 和它提到同一个实体的内容：内容 id → 共同的实体（带着各有几条别的内容提到它）。 */
async function sharingEntities(db: Db, userId: string, itemId: string, entityIds: string[]): Promise<Map<string, { id: string; others: number }[]>> {
  if (entityIds.length === 0) return new Map();
  const rows = await selectAll<{ item_id: string; entity_id: string }>(
    (from, to) => db.from("item_entities").select("item_id,entity_id").eq("user_id", userId).in("entity_id", entityIds).neq("item_id", itemId).order("item_id").order("entity_id").range(from, to),
    "图谱关联"
  );
  const others = new Map<string, number>();
  for (const r of rows) others.set(r.entity_id, (others.get(r.entity_id) ?? 0) + 1);
  const byItem = new Map<string, { id: string; others: number }[]>();
  for (const r of rows) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), { id: r.entity_id, others: others.get(r.entity_id) ?? 1 }]);
  return byItem;
}

/**
 * 找一条内容的相关内容。entities = 这条内容连着的实体（详情页已经读过的话传进来，省一次查询）。
 * 只列处理好的；这条内容自己还没处理好时什么都不找。
 */
export async function findRelated(db: Db, userId: string, item: Pick<Item, "id" | "status">, entities?: SharedEntity[]): Promise<Related> {
  if (item.status !== "ready") return { items: [], notes: [] };
  const notes: string[] = [];
  const mine = entities ?? (await entitiesOfItem(db, userId, item.id));

  let similar: Map<string, number> = new Map();
  try {
    const found = await similarTo(db, userId, item.id);
    if (found) similar = found;
    else notes.push("这条内容没有向量（处理时没配 VOYAGE_API_KEY，或者那一步没算成），没法按内容相近去找，只找了提到同一个人、地方或东西的。配好之后点「重新分析」会补上");
  } catch (e) {
    console.error(`相关内容：按向量找出错 item=${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    notes.push("这次没能按内容相近去找（查询出错），只找了提到同一个人、地方或东西的");
  }
  let sharing: Map<string, { id: string; others: number }[]> = new Map();
  try {
    sharing = await sharingEntities(db, userId, item.id, mine.map((e) => e.id));
  } catch (e) {
    console.error(`相关内容：按图谱找出错 item=${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    notes.push("这次没能去找提到同一个人、地方或东西的内容（查询出错），只按内容相近找了");
  }

  const ids = [...new Set([...similar.keys(), ...sharing.keys()])];
  const ranked = rankRelated(ids.map((id) => ({ id, similarity: similar.get(id) ?? null, shared: sharing.get(id) ?? [] })), RELATED_MAX * 2);
  const loaded = new Map((await getItemsInOrder(db, userId, ranked.map((r) => r.id))).map((i) => [i.id, i]));
  const entityOf = new Map(mine.map((e) => [e.id, e]));
  const items = ranked
    .flatMap((r): RelatedItem[] => {
      const found = loaded.get(r.id);
      // 还在处理、处理失败的不列：没有概括，也说不上「相关」
      if (!found || found.status !== "ready") return [];
      return [{ item: found, similarity: r.similarity, shared: r.shared.flatMap((s) => entityOf.get(s.id) ?? []) }];
    })
    .slice(0, RELATED_MAX);
  return { items, notes };
}
