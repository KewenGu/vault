import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@/lib/auth/user";
import type { Database } from "@/lib/db/types";
import { embedTexts } from "@/lib/embeddings";
import { loadGraph } from "@/lib/graph/data";
import { VaultError } from "./errors";
import { notesOfItems } from "./note-store";
import type { ItemNote } from "./notes";
import { PAGE_SIZE, escapeLike, searchItems } from "./search";
import { displayTitle, type Item } from "./store";
import { ENTITY_TYPE_INFO, toEntityType, type EntityType, type Relation } from "./taxonomy";
import { entityKey } from "./understand";

/**
 * 实体页：知识图谱里的一个人 / 地方 / 东西，和收藏库里关于它的一切——它是什么、提到它的内容（各自说它是什么角色）、
 * 和它有关系的别的实体、自己在这些内容上划的线和写的批注。都是处理时已经算好的数据，不调模型。
 *
 * 还有手动整理图谱的几样：改名字和说明、去掉一个别名、并进另一个实体（模型没认出是同一个的）、
 * 把几条内容移到另一个实体（模型并错了的，拆开）。合并和移动是数据库函数（迁移 20261127000001_entity_ops.sql），一次做完。
 *
 * 页面的 server action 和 /api/v1/entities 的接口都调这里。
 */

type Db = SupabaseClient<Database>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENTITY_NAME_MAX = 80;
export const ENTITY_SUMMARY_MAX = 300;
/** 一次最多移这么多条内容 */
export const MOVE_MAX = 200;
/** 页面上最多列这么多个有关系的实体、这么多条自己写的 */
const NEIGHBORS_MAX = 40;
const NOTES_MAX = 30;
const NAMES_MAX = 300;

export type EntityInfo = { id: string; type: EntityType; name: string; aliases: string[]; summary: string };
export type EntityNeighbor = {
  id: string;
  name: string;
  type: EntityType;
  /** 内容里明说的关系；cooccur = 只是出现在同一条内容里 */
  relation: Relation | "cooccur";
  /** 关系的方向：true = 这个实体 → 它（「位于」它），false = 它 → 这个实体。一起出现没有方向，总是 false */
  outgoing: boolean;
  /** 几条内容这么说 / 一起出现了几次 */
  weight: number;
};
export type EntityPage = {
  entity: EntityInfo;
  /** 这一页的内容，新存的在前；about = 这个实体在那条内容里是什么角色 */
  items: { item: Item; about: string }[];
  /** 提到它的内容一共几条；capped = 到了能列的上限（200），实际可能更多 */
  total: number;
  capped: boolean;
  neighbors: EntityNeighbor[];
  /** 自己在这一页的内容上划的线、写的批注，新写的在前 */
  notes: { note: ItemNote; itemTitle: string }[];
  /** 同一类里别的实体的名字（提到的内容多的在前）：合并、移动的输入框拿来提示 */
  names: string[];
  /** 这次没读到的（图谱、笔记查询出错）：页面上写出来，免得把「没读到」当成「没有」 */
  gaps: string[];
};

type EntityRow = { id: string; type: string; name: string; aliases: string[]; summary: string };
const COLUMNS = "id,type,name,aliases,summary" as const;

const toInfo = (row: EntityRow): EntityInfo | null => {
  const type = toEntityType(row.type);
  return type ? { id: row.id, type, name: row.name, aliases: row.aliases ?? [], summary: row.summary ?? "" } : null;
};

/** 合并 / 移动用的数据库函数还没有（迁移没推）：Postgres 报 42883，PostgREST 的缓存里没有时报 PGRST202 */
const missingFunction = (error: { message: string; code?: string }) => error.code === "42883" || error.code === "PGRST202";
const NOT_MIGRATED = "数据库里还没有整理图谱用的函数：把迁移 supabase/migrations/20261127000001_entity_ops.sql 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）";

async function getRow(db: Db, userId: string, id: string): Promise<EntityRow | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await db.from("entities").select(COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`读取实体失败: ${error.message}`);
  return data;
}

async function mustGet(db: Db, userId: string, id: string): Promise<EntityRow> {
  const row = await getRow(db, userId, id);
  if (!row) throw new VaultError("图谱里没有这个了（可能已经并进了别的，或者提到它的内容都删了）", 404);
  return row;
}

/** 一个实体和关于它的一切。offset = 内容从第几条开始（翻页）。 */
export async function getEntityPage(session: Session, id: string, input: { offset?: number } = {}): Promise<EntityPage> {
  const { user, db } = session;
  const entity = toInfo(await mustGet(db, user.id, id));
  if (!entity) throw new VaultError("图谱里没有这个了", 404);
  const gaps: string[] = [];

  // 提到它的内容：和首页按实体筛是同一个查法（按存进来的时间倒序，最多 200 条）
  const found = await searchItems(db, user.id, { filters: { entityId: id }, limit: PAGE_SIZE, offset: Math.max(0, Math.floor(input.offset ?? 0)) });
  const ids = found.hits.map((h) => h.item.id);
  const about = new Map<string, string>();
  if (ids.length > 0) {
    const { data, error } = await db.from("item_entities").select("item_id,about").eq("entity_id", id).eq("user_id", user.id).in("item_id", ids);
    if (error) throw new Error(`读取图谱关联失败: ${error.message}`);
    for (const r of data ?? []) about.set(r.item_id, r.about);
  }
  const items = found.hits.map((h) => ({ item: h.item, about: about.get(h.item.id) ?? "" }));

  // 有关系的实体：从整张图里取连着它的线（图谱页也是这么读的）。读不出来不拦着这一页
  let neighbors: EntityNeighbor[] = [];
  let names: string[] = [];
  try {
    const graph = await loadGraph(db, user.id);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    neighbors = graph.links
      .flatMap((l): EntityNeighbor[] => {
        if (l.source !== id && l.target !== id) return [];
        const other = byId.get(l.source === id ? l.target : l.source);
        return other ? [{ id: other.id, name: other.name, type: other.type, relation: l.relation, outgoing: l.relation !== "cooccur" && l.source === id, weight: l.weight }] : [];
      })
      // 明说了关系的在前，再按几条内容这么说
      .sort((a, b) => Number(a.relation === "cooccur") - Number(b.relation === "cooccur") || b.weight - a.weight || a.name.localeCompare(b.name))
      .slice(0, NEIGHBORS_MAX);
    names = graph.nodes.filter((n) => n.type === entity.type && n.id !== id).slice(0, NAMES_MAX).map((n) => n.name);
  } catch (e) {
    console.error(`实体页：读图谱出错 entity=${id}: ${e instanceof Error ? e.message : String(e)}`);
    gaps.push("这次没读到和它有关系的其他实体（查询出错），刷新再试");
  }

  // 自己在这些内容上划的线、写的批注（表还没建就是没有）
  let notes: EntityPage["notes"] = [];
  try {
    const { byItem } = await notesOfItems(db, user.id, ids);
    const titleOf = new Map(found.hits.map((h) => [h.item.id, displayTitle(h.item)]));
    notes = [...byItem.values()]
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, NOTES_MAX)
      .map((note) => ({ note, itemTitle: titleOf.get(note.itemId) ?? "" }));
  } catch (e) {
    console.error(`实体页：读笔记出错 entity=${id}: ${e instanceof Error ? e.message : String(e)}`);
    gaps.push("这次没读到你在这些内容上划的线和写的批注（查询出错），刷新再试");
  }

  return { entity, items, total: found.total, capped: found.capped, neighbors, notes, names, gaps };
}

const cleanName = (raw: string) => Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, ENTITY_NAME_MAX).join("");

/**
 * 改名字和说明。名字换了的话，旧名字记成别名：以后的内容再用旧的叫法，还是认到它。
 * 同一类里已经有一个叫新名字的：不改，告诉他那是另一个实体（要的是合并）。
 */
export async function renameEntity(session: Session, id: string, input: { name?: string; summary?: string }): Promise<EntityInfo> {
  const { user, db } = session;
  const row = await mustGet(db, user.id, id);
  const name = input.name === undefined ? row.name : cleanName(input.name);
  if (!name) throw new VaultError("名字不能是空的");
  const summary = input.summary === undefined ? row.summary : Array.from(input.summary.trim()).slice(0, ENTITY_SUMMARY_MAX).join("");
  const renamed = name !== row.name;
  // 新名字原来是别名的，从别名里拿掉；旧名字（只是大小写不一样的不算）放进别名
  const aliases = renamed ? [...row.aliases.filter((a) => entityKey(a) !== entityKey(name)), ...(entityKey(row.name) === entityKey(name) ? [] : [row.name])] : row.aliases;
  if (!renamed && summary === row.summary) return toInfo(row)!;
  const { data, error } = await db.from("entities").update({ name, summary, aliases }).eq("id", id).eq("user_id", user.id).select(COLUMNS);
  if (error) {
    if (error.code === "23505") {
      const label = ENTITY_TYPE_INFO[toEntityType(row.type) ?? "concept"].label;
      throw new VaultError(`已经有一个叫「${name}」的${label}了。它们是同一个的话，用下面的「并进另一个」`, 409);
    }
    throw new Error(`更新实体失败: ${error.message}`);
  }
  if (!data?.[0]) throw new VaultError("图谱里没有这个了", 404);
  return toInfo(data[0])!;
}

/** 去掉一个别名（并错了留下的叫法）：以后的内容再用这个叫法，不再直接认到它。 */
export async function removeAlias(session: Session, id: string, alias: string): Promise<EntityInfo> {
  const { user, db } = session;
  const row = await mustGet(db, user.id, id);
  const aliases = row.aliases.filter((a) => a !== alias);
  if (aliases.length === row.aliases.length) return toInfo(row)!;
  const { error } = await db.from("entities").update({ aliases }).eq("id", id).eq("user_id", user.id);
  if (error) throw new Error(`更新实体失败: ${error.message}`);
  return toInfo({ ...row, aliases })!;
}

/**
 * 按用户给的东西找一个实体：id，或者名字（先在同一类里按名字、再按别名找；同一类里没有时，别的类里正好只有一个叫这个名字的也算）。
 * except = 不算它自己（它的别名不算数）。找不到返回 null。
 */
async function resolve(db: Db, userId: string, ref: string, type: string, except: string): Promise<EntityRow | null> {
  const wanted = ref.trim();
  if (!wanted) return null;
  if (UUID.test(wanted)) return wanted === except ? null : getRow(db, userId, wanted);
  const name = cleanName(wanted);
  const byName = await db.from("entities").select(COLUMNS).eq("user_id", userId).eq("type", type).ilike("name", escapeLike(name)).neq("id", except).limit(1);
  if (byName.error) throw new Error(`查找实体失败: ${byName.error.message}`);
  if (byName.data?.[0]) return byName.data[0];
  const byAlias = await db.from("entities").select(COLUMNS).eq("user_id", userId).eq("type", type).contains("aliases", [name]).neq("id", except).limit(1);
  if (byAlias.error) throw new Error(`查找实体失败: ${byAlias.error.message}`);
  if (byAlias.data?.[0]) return byAlias.data[0];
  const anyType = await db.from("entities").select(COLUMNS).eq("user_id", userId).ilike("name", escapeLike(name)).neq("id", except).limit(2);
  if (anyType.error) throw new Error(`查找实体失败: ${anyType.error.message}`);
  return anyType.data?.length === 1 ? anyType.data[0] : null;
}

/** 数据库函数的错：没推迁移、实体不在了，换成说得清的话；别的往上抛 */
function rpcFailed(what: string, error: { message: string; code?: string }): never {
  if (missingFunction(error)) throw new VaultError(NOT_MIGRATED, 503);
  if (error.code === "P0002") throw new VaultError("图谱里没有这个了，刷新看看", 404);
  throw new Error(`${what}: ${error.message}`);
}

/**
 * 把这个实体并进另一个（into = 那个实体的 id 或名字）：提到它的内容、它的关系都挂到那一个上，它的名字和别名变成那一个的别名，它自己删掉。
 * 不能撤销。返回并进去的那个实体的 id。
 */
export async function mergeEntity(session: Session, id: string, into: string): Promise<{ id: string; name: string; moved: number }> {
  const { user, db } = session;
  const from = await mustGet(db, user.id, id);
  if (!into.trim()) throw new VaultError("要并进哪一个？写它的名字");
  const target = await resolve(db, user.id, into, from.type, id);
  if (!target) throw new VaultError(`图谱里没找到叫「${cleanName(into)}」的（名字要写全；它叫别的名字的话，先去那一页看看）`, 404);
  const { data, error } = await db.rpc("merge_entities", { p_user_id: user.id, p_from: id, p_into: target.id });
  if (error) rpcFailed("合并实体失败", error);
  return { id: target.id, name: target.name, moved: Number(data) || 0 };
}

/** 新建一个实体（拆开并错的时候用）。配了向量服务就算上向量：以后的内容提到它的别的叫法时，才找得到它。 */
async function createEntity(db: Db, userId: string, type: string, name: string): Promise<EntityRow> {
  let embedding: string | null = null;
  if (process.env.VOYAGE_API_KEY) {
    try {
      embedding = JSON.stringify((await embedTexts([name], "document"))[0]);
    } catch (e) {
      console.error(`实体页：新实体的向量没算成 name=${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { data, error } = await db.from("entities").insert({ user_id: userId, type, name, embedding }).select(COLUMNS).single();
  if (error) throw new Error(`新建实体失败: ${error.message}`);
  return data;
}

/**
 * 把几条内容从这个实体移到另一个（拆开并错的）：to = 那个实体的 id 或名字；图谱里没有叫这个名字的就新建一个（和这个同一类）。
 * to 是这个实体的一个别名时，是把这个叫法拆出去：新建一个叫这个名字的，并从别名里拿掉。
 * 这个实体上一条内容都不剩时，它自己也删掉。返回移到的那个实体。
 *
 * 注意：以后重新分析这几条内容时，模型抽出来的名字是什么就认到哪个实体——内容里用的还是原来那个叫法的话，会连回去。
 */
export async function moveItems(session: Session, id: string, itemIds: string[], to: string): Promise<{ id: string; name: string; created: boolean; moved: number; emptied: boolean }> {
  const { user, db } = session;
  const from = await mustGet(db, user.id, id);
  const picked = [...new Set(itemIds.filter((i) => UUID.test(i)))];
  if (picked.length === 0) throw new VaultError("先勾上要移走的内容");
  if (picked.length > MOVE_MAX) throw new VaultError(`一次最多移 ${MOVE_MAX} 条`);
  const name = UUID.test(to.trim()) ? "" : cleanName(to);
  if (!to.trim()) throw new VaultError("要移到哪一个？写它的名字（图谱里没有的话会新建一个）");
  if (name && entityKey(name) === entityKey(from.name)) throw new VaultError("这就是它自己");

  let target = await resolve(db, user.id, to, from.type, id);
  let created = false;
  if (!target) {
    if (!name) throw new VaultError("图谱里没有这个了，刷新看看", 404);
    target = await createEntity(db, user.id, from.type, name);
    created = true;
  }
  const { data, error } = await db.rpc("move_entity_links", { p_user_id: user.id, p_from: id, p_into: target.id, p_item_ids: picked });
  if (error) rpcFailed("移动内容失败", error);

  // 拆出去的叫法不再是它的别名
  const aliases = from.aliases.filter((a) => entityKey(a) !== entityKey(target.name));
  if (aliases.length !== from.aliases.length) {
    const { error: upErr } = await db.from("entities").update({ aliases }).eq("id", id).eq("user_id", user.id);
    if (upErr) throw new Error(`更新实体失败: ${upErr.message}`);
  }
  // 一条内容都不剩了：这个实体没有存在的理由了
  const { count, error: countErr } = await db.from("item_entities").select("item_id", { count: "exact", head: true }).eq("entity_id", id).eq("user_id", user.id);
  if (countErr) throw new Error(`读取图谱关联失败: ${countErr.message}`);
  const emptied = count === 0;
  if (emptied) {
    const { error: delErr } = await db.from("entities").delete().eq("id", id).eq("user_id", user.id);
    if (delErr) throw new Error(`删除实体失败: ${delErr.message}`);
  }
  return { id: target.id, name: target.name, created, moved: Number(data) || 0, emptied };
}
