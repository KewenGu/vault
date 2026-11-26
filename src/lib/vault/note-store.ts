import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ItemNoteRecord } from "@/lib/db/types";
import { VaultError } from "./errors";
import type { ItemNote } from "./notes";
import { escapeLike, parseQuery } from "./search";

/**
 * item_notes 表的读写（划线和批注，迁移 20261126000003_item_notes.sql）。
 * 每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），后台任务用 service role 时只靠它。
 */

type Db = SupabaseClient<Database>;

const isMissing = (error: { code?: string }) => error.code === "42P01" || error.code === "PGRST205";

/**
 * 查 item_notes 表出错。表还不存在（应用更新了、迁移还没推到 Supabase——自动更新不动数据库）时说清楚要做什么：
 * Postgres 报 42P01，PostgREST 的表结构缓存里没有这张表时报 PGRST205。
 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (isMissing(error)) {
    throw new VaultError("数据库里还没有笔记用的那张表：把迁移 supabase/migrations/20261126000003_item_notes.sql 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）", 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const COLUMNS = "id,user_id,item_id,quote,body,at,created_at,updated_at" as const;

export function toNote(row: Pick<ItemNoteRecord, "id" | "item_id" | "quote" | "body" | "at" | "created_at" | "updated_at">): ItemNote {
  const at = row.at === null ? null : Number(row.at);
  return { id: row.id, itemId: row.item_id, quote: row.quote ?? "", body: row.body ?? "", at: at !== null && Number.isFinite(at) ? at : null, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** 一条内容上的笔记，先写的在前。 */
export async function listNotesOfItem(db: Db, userId: string, itemId: string): Promise<ItemNote[]> {
  const { data, error } = await db.from("item_notes").select(COLUMNS).eq("user_id", userId).eq("item_id", itemId).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(500);
  if (error) fail("读取笔记失败", error);
  return (data ?? []).map(toNote);
}

/**
 * 好几条内容上的笔记（「问」、导出、建索引用）：内容 id → 它的笔记，先写的在前。
 * 这些地方笔记只是附带的：表还没建时当成没有笔记（missing = true），别的错照常抛。
 */
export async function notesOfItems(db: Db, userId: string, itemIds: string[]): Promise<{ byItem: Map<string, ItemNote[]>; missing: boolean }> {
  const byItem = new Map<string, ItemNote[]>();
  for (let i = 0; i < itemIds.length; i += 50) {
    const { data, error } = await db
      .from("item_notes")
      .select(COLUMNS)
      .eq("user_id", userId)
      .in("item_id", itemIds.slice(i, i + 50))
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1000);
    if (error) {
      if (isMissing(error)) return { byItem: new Map(), missing: true };
      throw new Error(`读取笔记失败: ${error.message}`);
    }
    for (const row of data ?? []) byItem.set(row.item_id, [...(byItem.get(row.item_id) ?? []), toNote(row)]);
  }
  return { byItem, missing: false };
}

export async function getNote(db: Db, userId: string, id: string): Promise<ItemNote | null> {
  const { data, error } = await db.from("item_notes").select(COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取笔记失败", error);
  return data ? toNote(data) : null;
}

export async function countNotesOfItem(db: Db, userId: string, itemId: string): Promise<number> {
  const { count, error } = await db.from("item_notes").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("item_id", itemId);
  if (error) fail("读取笔记失败", error);
  return count ?? 0;
}

export async function createNote(db: Db, userId: string, input: { itemId: string; quote: string; body: string; at: number | null }): Promise<ItemNote> {
  const { data, error } = await db
    .from("item_notes")
    .insert({ user_id: userId, item_id: input.itemId, quote: input.quote, body: input.body, at: input.at })
    .select(COLUMNS)
    .single();
  if (error) fail("保存笔记失败", error);
  return toNote(data);
}

/** 改自己写的那段话。笔记不在了（或不是这个人的）返回 null。 */
export async function updateNoteBody(db: Db, userId: string, id: string, body: string): Promise<ItemNote | null> {
  const { data, error } = await db.from("item_notes").update({ body }).eq("id", id).eq("user_id", userId).select(COLUMNS);
  if (error) fail("保存笔记失败", error);
  return data?.[0] ? toNote(data[0]) : null;
}

export async function deleteNote(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("item_notes").delete().eq("id", id).eq("user_id", userId);
  if (error) fail("删除笔记失败", error);
}

/** 「笔记」页一次最多列这么多条 */
export const NOTES_LIST_MAX = 200;

/**
 * 这个人所有的笔记，新写的在前（「笔记」页用）。q = 按字面找（空格隔开的词都出现才算，划的话和写的话里都找）。
 * more = 还有更早的没列出来。
 */
export async function listNotes(db: Db, userId: string, input: { q?: string } = {}): Promise<{ notes: ItemNote[]; more: boolean }> {
  let query = db.from("item_notes").select(COLUMNS).eq("user_id", userId);
  // search_text 是数据库拼好的那一列（划的话 + 写的话）；词里的 % _ \ 按字面找
  for (const term of parseQuery(input.q ?? "")) query = query.ilike("search_text", `%${escapeLike(term)}%`);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(NOTES_LIST_MAX + 1);
  if (error) fail("读取笔记失败", error);
  const rows = data ?? [];
  return { notes: rows.slice(0, NOTES_LIST_MAX).map(toNote), more: rows.length > NOTES_LIST_MAX };
}
