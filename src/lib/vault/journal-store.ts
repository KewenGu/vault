import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, JournalEntryRecord, JournalMediaRecord } from "@/lib/db/types";
import { VaultError } from "./errors";
import { cleanDay, cleanDoc, cleanMood, cleanStyle, cleanWeather, type JournalDoc, type JournalStyle } from "./journal-doc";

/**
 * journal_entries / journal_media / journal_stickers 三张表的读写（日记本）。每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），
 * 后台用 service role 时只靠它。
 */

type Db = SupabaseClient<Database>;

export type JournalEntry = {
  id: string;
  /** 这一篇写的是哪一天：YYYY-MM-DD */
  day: string;
  title: string;
  style: JournalStyle;
  mood: string;
  weather: string;
  doc: JournalDoc;
  /** 自己保存了多少次（保存时拿它对一下，见 updateEntry） */
  rev: number;
  searchText: string;
  createdAt: string;
  updatedAt: string;
};

export const MEDIA_KINDS = ["image", "audio"] as const;
export const MEDIA_STATUSES = ["uploading", "processing", "ready", "failed"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export type JournalMedia = {
  id: string;
  userId: string;
  entryId: string;
  kind: MediaKind;
  status: MediaStatus;
  error: string | null;
  path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  transcript: string | null;
  notes: string[];
  usage: Record<string, number>;
  costUsd: number;
  startedAt: string;
  createdAt: string;
  updatedAt: string;
};

export const MIGRATION = "supabase/migrations/20261121000002_journal.sql";

/**
 * 查表出错。表还不存在（应用更新了、迁移还没推到 Supabase——自动更新不动数据库）时说清楚要做什么，
 * 而不是一句「出错了」：Postgres 报 42P01，PostgREST 的表结构缓存里没有这张表时报 PGRST205。
 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError(`数据库里还没有日记用的表：把迁移 ${MIGRATION} 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）`, 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const ENTRY_COLUMNS = "id,user_id,day,title,style,mood,weather,doc,rev,search_text,created_at,updated_at" as const;
const MEDIA_COLUMNS = "id,user_id,entry_id,kind,status,error,path,mime,bytes,width,height,duration_s,transcript,notes,usage,cost_usd,started_at,created_at,updated_at" as const;

export function toEntry(row: Omit<JournalEntryRecord, "user_id">): JournalEntry {
  return {
    id: row.id,
    day: cleanDay(row.day) ?? "1970-01-01",
    title: row.title ?? "",
    style: cleanStyle(row.style),
    mood: cleanMood(row.mood),
    weather: cleanWeather(row.weather),
    doc: cleanDoc(row.doc),
    rev: Number(row.rev) || 0,
    searchText: row.search_text ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readUsage(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
}

export function toMedia(row: JournalMediaRecord): JournalMedia {
  return {
    id: row.id,
    userId: row.user_id,
    entryId: row.entry_id,
    kind: MEDIA_KINDS.find((k) => k === row.kind) ?? "image",
    status: MEDIA_STATUSES.find((s) => s === row.status) ?? "failed",
    error: row.error ?? null,
    path: row.path,
    mime: row.mime ?? "",
    bytes: Number(row.bytes) || 0,
    width: row.width ?? null,
    height: row.height ?? null,
    durationS: row.duration_s == null ? null : Number(row.duration_s),
    transcript: row.transcript ?? null,
    notes: Array.isArray(row.notes) ? row.notes.filter((n): n is string => typeof n === "string") : [],
    usage: readUsage(row.usage),
    costUsd: Number(row.cost_usd) || 0,
    startedAt: row.started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 存储桶里放一篇日记的文件的目录。 */
export const journalDir = (userId: string, entryId: string) => `${userId}/journal/${entryId}`;

// ---------------------------------------------------------------- 日记

/** ilike 的模式里 % _ \ 有特殊含义：要找的词里有就转义掉。 */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

/** 这个人的日记，日期新的在前（同一天里后写的在前）。terms：这些词都出现的才要。多取一条用来知道后面还有没有。 */
export async function listEntries(db: Db, userId: string, opts: { terms?: string[]; offset?: number; limit: number }): Promise<{ entries: JournalEntry[]; more: boolean }> {
  const offset = opts.offset ?? 0;
  let query = db.from("journal_entries").select(ENTRY_COLUMNS).eq("user_id", userId);
  for (const term of opts.terms ?? []) query = query.ilike("search_text", likePattern(term));
  const { data, error } = await query.order("day", { ascending: false }).order("created_at", { ascending: false }).range(offset, offset + opts.limit);
  if (error) fail("读取日记失败", error);
  const rows = data ?? [];
  return { entries: rows.slice(0, opts.limit).map(toEntry), more: rows.length > opts.limit };
}

export async function getEntry(db: Db, userId: string, id: string): Promise<JournalEntry | null> {
  const { data, error } = await db.from("journal_entries").select(ENTRY_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取日记失败", error);
  return data ? toEntry(data) : null;
}

/** 某一天的日记，先写的在前。 */
export async function entriesOfDay(db: Db, userId: string, day: string): Promise<JournalEntry[]> {
  const { data, error } = await db.from("journal_entries").select(ENTRY_COLUMNS).eq("user_id", userId).eq("day", day).order("created_at", { ascending: true }).limit(100);
  if (error) fail("读取日记失败", error);
  return (data ?? []).map(toEntry);
}

/** 最近动过的那一篇用的风格（新的一篇接着用）；一篇都没有是 null。 */
export async function lastStyle(db: Db, userId: string): Promise<JournalStyle | null> {
  const { data, error } = await db.from("journal_entries").select("style").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1);
  if (error) fail("读取日记失败", error);
  return data?.[0] ? cleanStyle(data[0].style) : null;
}

/**
 * 往前、往后翻到哪一篇。顺序是日期、同一天里按写的先后。older = 更早的一篇，newer = 更新的一篇，到头了是 null。
 */
export async function neighbors(db: Db, userId: string, entry: Pick<JournalEntry, "id" | "day">): Promise<{ older: string | null; newer: string | null }> {
  const sameDay = await entriesOfDay(db, userId, entry.day);
  const at = sameDay.findIndex((e) => e.id === entry.id);
  let older = at > 0 ? sameDay[at - 1].id : null;
  let newer = at >= 0 && at < sameDay.length - 1 ? sameDay[at + 1].id : null;
  if (!older) {
    const { data, error } = await db.from("journal_entries").select("id").eq("user_id", userId).lt("day", entry.day).order("day", { ascending: false }).order("created_at", { ascending: false }).limit(1);
    if (error) fail("读取日记失败", error);
    older = data?.[0]?.id ?? null;
  }
  if (!newer) {
    const { data, error } = await db.from("journal_entries").select("id").eq("user_id", userId).gt("day", entry.day).order("day", { ascending: true }).order("created_at", { ascending: true }).limit(1);
    if (error) fail("读取日记失败", error);
    newer = data?.[0]?.id ?? null;
  }
  return { older, newer };
}

export async function createEntry(db: Db, userId: string, input: { day: string; style: JournalStyle }): Promise<string> {
  const { data, error } = await db.from("journal_entries").insert({ user_id: userId, day: input.day, style: input.style }).select("id").single();
  if (error) fail("新建日记失败", error);
  return data.id;
}

export type EntryPatch = Partial<Pick<JournalEntry, "day" | "title" | "style" | "mood" | "weather" | "doc" | "searchText">>;

/**
 * 保存自己改的。rev = 改之前看到的版本号：数据库里还是这个数才写、写完加一；对不上（别处改过了）或这篇不在了返回 null，
 * 成功返回新的版本号。
 */
export async function updateEntry(db: Db, userId: string, id: string, rev: number, patch: EntryPatch): Promise<number | null> {
  const row = {
    ...(patch.day !== undefined ? { day: patch.day } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.style !== undefined ? { style: patch.style } : {}),
    ...(patch.mood !== undefined ? { mood: patch.mood } : {}),
    ...(patch.weather !== undefined ? { weather: patch.weather } : {}),
    ...(patch.doc !== undefined ? { doc: patch.doc as unknown as Json } : {}),
    ...(patch.searchText !== undefined ? { search_text: patch.searchText } : {}),
    rev: rev + 1,
  };
  const { data, error } = await db.from("journal_entries").update(row).eq("id", id).eq("user_id", userId).eq("rev", rev).select("id");
  if (error) fail("保存日记失败", error);
  return (data ?? []).length > 0 ? rev + 1 : null;
}

/** 只换搜索用的文字（后台转写完调）：不动版本号，不算「别处改过了」。 */
export async function setSearchText(db: Db, userId: string, id: string, searchText: string): Promise<void> {
  const { error } = await db.from("journal_entries").update({ search_text: searchText }).eq("id", id).eq("user_id", userId);
  if (error) fail("保存日记失败", error);
}

/** 删一篇（它的文件在 journal_media 里的行跟着级联删；存储桶里的文件由调用方删）。这篇不在返回 false。 */
export async function deleteEntry(db: Db, userId: string, id: string): Promise<boolean> {
  const { data, error } = await db.from("journal_entries").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("删除日记失败", error);
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------- 日记里的文件

/** 一篇日记的文件，先传的在前。 */
export async function listMedia(db: Db, userId: string, entryId: string): Promise<JournalMedia[]> {
  const { data, error } = await db.from("journal_media").select(MEDIA_COLUMNS).eq("user_id", userId).eq("entry_id", entryId).order("created_at", { ascending: true }).limit(500);
  if (error) fail("读取日记里的文件失败", error);
  return (data ?? []).map(toMedia);
}

/** 好几篇日记的文件（列表页用：数照片和录音、挑封面）。 */
export async function listMediaOf(db: Db, userId: string, entryIds: string[]): Promise<JournalMedia[]> {
  if (entryIds.length === 0) return [];
  const { data, error } = await db.from("journal_media").select(MEDIA_COLUMNS).eq("user_id", userId).in("entry_id", entryIds).order("created_at", { ascending: true }).limit(5000);
  if (error) fail("读取日记里的文件失败", error);
  return (data ?? []).map(toMedia);
}

export async function getMedia(db: Db, userId: string, id: string): Promise<JournalMedia | null> {
  const { data, error } = await db.from("journal_media").select(MEDIA_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取日记里的文件失败", error);
  return data ? toMedia(data) : null;
}

export async function insertMedia(db: Db, userId: string, input: { id: string; entryId: string; kind: MediaKind; path: string; mime: string; bytes: number }): Promise<void> {
  const { error } = await db.from("journal_media").insert({ id: input.id, user_id: userId, entry_id: input.entryId, kind: input.kind, path: input.path, mime: input.mime, bytes: input.bytes, status: "uploading" });
  if (error) fail("登记文件失败", error);
}

export type MediaPatch = Partial<Pick<JournalMedia, "status" | "error" | "path" | "mime" | "bytes" | "width" | "height" | "durationS" | "transcript" | "notes" | "usage" | "costUsd" | "startedAt">>;

/** 改一个文件的登记。from 给了 = 只在它现在是这个状态时才改（后台任务用：被删了、被重试了就不再写）。改到了返回 true。 */
export async function updateMedia(db: Db, userId: string, id: string, patch: MediaPatch, from?: MediaStatus): Promise<boolean> {
  const row = {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.path !== undefined ? { path: patch.path } : {}),
    ...(patch.mime !== undefined ? { mime: patch.mime } : {}),
    ...(patch.bytes !== undefined ? { bytes: patch.bytes } : {}),
    ...(patch.width !== undefined ? { width: patch.width } : {}),
    ...(patch.height !== undefined ? { height: patch.height } : {}),
    ...(patch.durationS !== undefined ? { duration_s: patch.durationS } : {}),
    ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.usage !== undefined ? { usage: patch.usage as Json } : {}),
    ...(patch.costUsd !== undefined ? { cost_usd: patch.costUsd } : {}),
    ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
  };
  let query = db.from("journal_media").update(row).eq("id", id).eq("user_id", userId);
  if (from) query = query.eq("status", from);
  const { data, error } = await query.select("id");
  if (error) fail("保存文件的登记失败", error);
  return (data ?? []).length > 0;
}

export async function deleteMedia(db: Db, userId: string, id: string): Promise<boolean> {
  const { data, error } = await db.from("journal_media").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("删除文件失败", error);
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------- 我的贴纸

export type JournalSticker = { id: string; userId: string; status: "uploading" | "ready"; path: string; width: number | null; height: number | null; createdAt: string };

const STICKER_COLUMNS = "id,user_id,status,path,width,height,created_at" as const;
const STICKER_MIGRATION = "supabase/migrations/20261122000001_journal_stickers.sql";

/** 同 fail，但缺的是贴纸那张表（它的迁移晚一天）。 */
function failSticker(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError(`数据库里还没有「我的贴纸」用的表：把迁移 ${STICKER_MIGRATION} 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase db push --remote）`, 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

type StickerRow = { id: string; user_id: string; status: string; path: string; width: number | null; height: number | null; created_at: string };
const toSticker = (row: StickerRow): JournalSticker => ({ id: row.id, userId: row.user_id, status: row.status === "ready" ? "ready" : "uploading", path: row.path, width: row.width ?? null, height: row.height ?? null, createdAt: row.created_at });

/** 这个人的贴纸（传好了的），新传的在前。all = 连没传完的一起（数个数用）。 */
export async function listStickers(db: Db, userId: string, all = false): Promise<JournalSticker[]> {
  let query = db.from("journal_stickers").select(STICKER_COLUMNS).eq("user_id", userId);
  if (!all) query = query.eq("status", "ready");
  const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
  if (error) failSticker("读取贴纸失败", error);
  return (data ?? []).map(toSticker);
}

export async function getSticker(db: Db, userId: string, id: string): Promise<JournalSticker | null> {
  const { data, error } = await db.from("journal_stickers").select(STICKER_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) failSticker("读取贴纸失败", error);
  return data ? toSticker(data) : null;
}

export async function insertSticker(db: Db, userId: string, input: { id: string; path: string; bytes: number }): Promise<void> {
  const { error } = await db.from("journal_stickers").insert({ id: input.id, user_id: userId, path: input.path, bytes: input.bytes, status: "uploading" });
  if (error) failSticker("登记贴纸失败", error);
}

export async function readySticker(db: Db, userId: string, id: string, patch: { path: string; width: number; height: number; bytes: number }): Promise<void> {
  const { error } = await db.from("journal_stickers").update({ ...patch, status: "ready" }).eq("id", id).eq("user_id", userId);
  if (error) failSticker("保存贴纸失败", error);
}

export async function deleteSticker(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("journal_stickers").delete().eq("id", id).eq("user_id", userId);
  if (error) failSticker("删除贴纸失败", error);
}
