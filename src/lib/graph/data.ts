import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { selectAll } from "@/lib/db/select-all";
import { toEntityType, toRelation, type EntityType, type Relation } from "@/lib/vault/taxonomy";

/**
 * 图谱页的数据：节点 = 实体（大小按有几条内容提到它），连线有两种——
 * - 内容里明说的关系（位于、出自、属于…），同一对被几条内容说到就粗几分；
 * - 共现：两个实体出现在同一条内容里（没有明说关系的才画），按一起出现的条数算粗细。
 * buildGraph 是纯函数（两端都能用，不带数据库客户端）。
 */

export type GraphNode = { id: string; name: string; type: EntityType; count: number; summary: string; aliases: string[] };
export type GraphLink = { source: string; target: string; relation: Relation | "cooccur"; weight: number };
export type GraphData = { nodes: GraphNode[]; links: GraphLink[] };

export type EntityRowLite = { id: string; type: string; name: string; summary: string; aliases: string[] };
export type ItemEntityLite = { item_id: string; entity_id: string };
export type EdgeLite = { src_id: string; dst_id: string; relation: string };

/** 一条内容里实体太多时，共现连线只连前这么多个（不然一条内容就是一团全连接的毛线） */
const COOCCUR_PER_ITEM = 10;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function buildGraph(entities: EntityRowLite[], itemEntities: ItemEntityLite[], edges: EdgeLite[]): GraphData {
  const nodes = new Map<string, GraphNode>();
  for (const e of entities) {
    const type = toEntityType(e.type);
    if (type) nodes.set(e.id, { id: e.id, name: e.name, type, count: 0, summary: e.summary, aliases: e.aliases });
  }
  const byItem = new Map<string, string[]>();
  for (const ie of itemEntities) {
    const node = nodes.get(ie.entity_id);
    if (!node) continue;
    node.count++;
    byItem.set(ie.item_id, [...(byItem.get(ie.item_id) ?? []), ie.entity_id]);
  }
  const links = new Map<string, GraphLink>();
  const related = new Set<string>();
  for (const e of edges) {
    if (!nodes.has(e.src_id) || !nodes.has(e.dst_id) || e.src_id === e.dst_id) continue;
    const relation = toRelation(e.relation);
    const key = `${e.src_id}|${e.dst_id}|${relation}`;
    const had = links.get(key);
    if (had) had.weight++;
    else links.set(key, { source: e.src_id, target: e.dst_id, relation, weight: 1 });
    related.add(pairKey(e.src_id, e.dst_id));
  }
  const co = new Map<string, GraphLink>();
  for (const ids of byItem.values()) {
    const list = ids.slice(0, COOCCUR_PER_ITEM);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = pairKey(list[i], list[j]);
        if (related.has(key)) continue;
        const had = co.get(key);
        if (had) had.weight++;
        else co.set(key, { source: list[i] < list[j] ? list[i] : list[j], target: list[i] < list[j] ? list[j] : list[i], relation: "cooccur", weight: 1 });
      }
    }
  }
  return { nodes: [...nodes.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), links: [...links.values(), ...co.values()] };
}

type Db = SupabaseClient<Database>;

export async function loadGraph(db: Db, userId: string): Promise<GraphData> {
  const [entities, itemEntities, edges] = await Promise.all([
    selectAll<EntityRowLite>((from, to) => db.from("entities").select("id,type,name,summary,aliases").eq("user_id", userId).order("id").range(from, to), "图谱节点"),
    selectAll<ItemEntityLite>((from, to) => db.from("item_entities").select("item_id,entity_id").eq("user_id", userId).order("item_id").order("entity_id").range(from, to), "图谱关联"),
    selectAll<EdgeLite>(
      (from, to) => db.from("entity_edges").select("src_id,dst_id,relation").eq("user_id", userId).order("item_id").order("src_id").order("dst_id").order("relation").range(from, to),
      "图谱关系"
    ),
  ]);
  return buildGraph(entities, itemEntities, edges);
}

/** 一条内容连着的实体（详情页用）。 */
export async function entitiesOfItem(db: Db, userId: string, itemId: string): Promise<{ id: string; name: string; type: EntityType; about: string }[]> {
  const { data, error } = await db.from("item_entities").select("entity_id, about").eq("item_id", itemId).eq("user_id", userId);
  if (error) throw new Error(`读取图谱关联失败: ${error.message}`);
  const ids = (data ?? []).map((r) => r.entity_id);
  if (ids.length === 0) return [];
  const { data: rows, error: eErr } = await db.from("entities").select("id,type,name").eq("user_id", userId).in("id", ids);
  if (eErr) throw new Error(`读取实体失败: ${eErr.message}`);
  const about = new Map((data ?? []).map((r) => [r.entity_id, r.about]));
  return (rows ?? []).flatMap((r) => {
    const type = toEntityType(r.type);
    return type ? [{ id: r.id, name: r.name, type, about: about.get(r.id) ?? "" }] : [];
  });
}
