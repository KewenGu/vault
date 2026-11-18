import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ItemRecord, Json } from "@/lib/db/types";
import type { LinkRef } from "@/lib/sources/link";
import { POST_KINDS, SOURCE_PLATFORMS, SOURCE_PLATFORM_LABEL, fallbackTitle, readMedia, readPost, type ItemMedia, type PostKind, type PostSnapshot, type SourcePlatform } from "@/lib/sources/types";
import { cleanTags, toCategory, toContentType, type Category, type ContentType } from "./taxonomy";
import { readUnderstanding, type Understanding } from "./understand";

/**
 * Vault 里一条内容的读写（表 items，迁移 20261117000001_vault.sql）。
 *
 * - 一条内容属于一个用户；同一个人同一条内容（去重键）只有一行，重复存回到已有的那条；
 * - 文件在存储桶 vault 的 `<用户>/<内容 id>/` 下，删内容时整个目录一起删；
 * - 这里的函数都显式带 userId：页面用登录用户的客户端调（行级安全再兜一层），后台任务用 service_role 调（只靠这个条件）。
 */

type Db = SupabaseClient<Database>;

export const ITEM_SOURCES = ["link", "upload", "text"] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];
export const ITEM_STATUSES = ["uploading", "fetching", "analyzing", "ready", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const BUCKET = "vault";
export const NOTE_MAX = 1000;
/** 贴进来的文字最多这么长（再长的请存成文件上传） */
export const TEXT_MAX = 200_000;
/** 处理超过这么久还没结束，按卡住处理（页面显示成失败、可以重试） */
export const STUCK_MS = 20 * 60_000;
/** 等浏览器上传超过这么久没来，按没传成处理 */
export const UPLOAD_STUCK_MS = 30 * 60_000;

export type Item = {
  id: string;
  userId: string;
  source: ItemSource;
  platform: SourcePlatform | null;
  externalId: string | null;
  url: string | null;
  status: ItemStatus;
  error: string | null;
  kind: PostKind | null;
  title: string;
  author: string;
  post: PostSnapshot;
  media: ItemMedia[];
  transcript: string | null;
  userText: string | null;
  understanding: Understanding | null;
  summary: string;
  contentType: ContentType | null;
  category: Category | null;
  tags: string[];
  tagsLocked: boolean;
  note: string;
  costUsd: number;
  startedAt: string;
  processedAt: string | null;
  createdAt: string;
};

/** 详情要的列：不带 embedding 和 search_text（大，页面用不上） */
export const ITEM_COLUMNS =
  "id,user_id,source,dedupe_key,platform,external_id,url,status,error,kind,title,author,post,media,transcript,user_text,understanding,summary,content_type,category,tags,tags_locked,note,usage,cost_usd,started_at,processed_at,created_at,updated_at" as const;
/** 列表要的列：再去掉口播、正文、理解结果（一条可能几万字，列表一页几十条）。读出来的 Item 这几项是空的。 */
export const ITEM_LIST_COLUMNS =
  "id,user_id,source,dedupe_key,platform,external_id,url,status,error,kind,title,author,media,summary,content_type,category,tags,tags_locked,note,cost_usd,started_at,processed_at,created_at,updated_at" as const;
type Heavy = "post" | "transcript" | "user_text" | "understanding" | "usage";
type Row = Omit<ItemRecord, "embedding" | "search_text" | Heavy> & Partial<Pick<ItemRecord, Heavy>>;

export function itemDir(userId: string, id: string): string {
  return `${userId}/${id}`;
}

export function toItem(row: Row): Item {
  return {
    id: row.id,
    userId: row.user_id,
    source: ITEM_SOURCES.find((s) => s === row.source) ?? "link",
    // 认不出的平台（以后加了新平台、代码又回退）当网页：详情页还能打开
    platform: row.platform ? (SOURCE_PLATFORMS.find((p) => p === row.platform) ?? "web") : null,
    externalId: row.external_id,
    url: row.url,
    status: ITEM_STATUSES.find((s) => s === row.status) ?? "failed",
    error: row.error,
    kind: POST_KINDS.find((k) => k === row.kind) ?? null,
    title: row.title ?? "",
    author: row.author ?? "",
    post: readPost(row.post),
    media: readMedia(row.media),
    transcript: row.transcript ?? null,
    userText: row.user_text ?? null,
    understanding: readUnderstanding(row.understanding),
    summary: row.summary ?? "",
    contentType: row.content_type ? toContentType(row.content_type) : null,
    category: row.category ? toCategory(row.category) : null,
    tags: row.tags ?? [],
    tagsLocked: row.tags_locked,
    note: row.note ?? "",
    costUsd: Number(row.cost_usd) || 0,
    startedAt: row.started_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

/** 页面上叫它什么：有标题用标题；没有（还在读、读失败、内容本来没字）给一个认得出来源的叫法。 */
export function displayTitle(item: Pick<Item, "title" | "source" | "platform" | "kind" | "userText">): string {
  if (item.title) return item.title;
  if (item.source === "link" && item.platform) return fallbackTitle(item.platform, item.kind);
  if (item.source === "text") return Array.from((item.userText ?? "").trim().split("\n")[0] ?? "").slice(0, 40).join("") || "文字";
  return item.kind === "video" ? "上传的视频" : item.kind === "audio" ? "上传的音频" : item.kind === "image" ? "上传的图片" : "上传的文件";
}

/** 来源一栏写什么：平台名，或「上传」「文字」。 */
export function sourceLabel(item: Pick<Item, "source" | "platform">): string {
  return item.source === "link" && item.platform ? SOURCE_PLATFORM_LABEL[item.platform] : item.source === "upload" ? "上传" : "文字";
}

/** 页面上读一个转存文件的地址（/media/<内容>/<文件>）。v 跟着每一轮处理变：重新读取换了文件，地址也跟着换。 */
export function itemFileUrl(item: Pick<Item, "id" | "startedAt">, m: Pick<ItemMedia, "path">): string {
  return `/media/${item.id}/${m.path.split("/").pop()}?v=${new Date(item.startedAt).getTime().toString(36)}`;
}

const elapsed = (item: Pick<Item, "startedAt">, now: number) => now - new Date(item.startedAt).getTime();

/** 还在处理中（没卡住）。 */
export function inProgress(item: Pick<Item, "status" | "startedAt">, now = Date.now()): boolean {
  if (item.status === "uploading") return elapsed(item, now) < UPLOAD_STUCK_MS;
  return (item.status === "fetching" || item.status === "analyzing") && elapsed(item, now) < STUCK_MS;
}

/** 状态是进行中、但早就该结束了（后台任务没跑完就断了、浏览器没把文件传上来）。 */
export function isStuck(item: Pick<Item, "status" | "startedAt">, now = Date.now()): boolean {
  return (item.status === "uploading" || item.status === "fetching" || item.status === "analyzing") && !inProgress(item, now);
}

/** 页面上能看的图（图文的图 / 视频封面 / 上传的图），按顺序。 */
export const imagesOf = (item: Pick<Item, "media">) => item.media.filter((m) => m.role === "image");
export const videoOf = (item: Pick<Item, "media">) => item.media.find((m) => m.role === "video") ?? null;
export const audioOf = (item: Pick<Item, "media">) => item.media.find((m) => m.role === "audio") ?? null;
export const framesOf = (item: Pick<Item, "media">) => item.media.filter((m) => m.role === "frame").sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
/** 帧格（按文件名的顺序，也就是时间顺序） */
export const sheetsOf = (item: Pick<Item, "media">) => item.media.filter((m) => m.role === "sheet").sort((a, b) => a.path.localeCompare(b.path));
/**
 * 列表里用的封面：第一张图，没有就用视频的第一帧。刚传上来还没处理的原文件（upload.*）不算：
 * 处理时会被换成统一格式的图，这时候引用它会得到一张裂图。
 */
export const coverOf = (item: Pick<Item, "media">) => [...imagesOf(item), ...framesOf(item)].find((m) => !/\/upload\.[a-z0-9]+$/i.test(m.path)) ?? null;

export async function getItem(db: Db, userId: string, id: string): Promise<Item | null> {
  const { data, error } = await db.from("items").select(ITEM_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`读取内容失败: ${error.message}`);
  return data ? toItem(data) : null;
}

/** 后台任务用：只按 id 读（调用方是 service_role，id 来自自己发起的任务）。 */
export async function getItemById(db: Db, id: string): Promise<Item | null> {
  const { data, error } = await db.from("items").select(ITEM_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`读取内容失败: ${error.message}`);
  return data ? toItem(data) : null;
}

/** 按给定的 id 顺序读一批（搜索结果用）。full = 带上口播、正文、理解结果（要摘出命中的那句话时）。 */
export async function getItemsInOrder(db: Db, userId: string, ids: string[], full = false): Promise<Item[]> {
  if (ids.length === 0) return [];
  const out = new Map<string, Item>();
  // id 列表放在查询串里：分块，免得地址太长
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { data, error } = full
      ? await db.from("items").select(ITEM_COLUMNS).eq("user_id", userId).in("id", chunk)
      : await db.from("items").select(ITEM_LIST_COLUMNS).eq("user_id", userId).in("id", chunk);
    if (error) throw new Error(`读取内容失败: ${error.message}`);
    for (const row of data ?? []) out.set(row.id, toItem(row));
  }
  return ids.flatMap((id) => out.get(id) ?? []);
}

export type NewItem = { source: ItemSource; dedupeKey: string; status: ItemStatus; note?: string } & Partial<{
  /** 指定 id（上传时文件路径里要先用到它）；不给由数据库生成 */
  id: string;
  platform: SourcePlatform;
  externalId: string;
  url: string;
  kind: PostKind;
  title: string;
  userText: string;
  media: ItemMedia[];
}>;

const cleanNote = (note: string | undefined) => Array.from((note ?? "").trim()).slice(0, NOTE_MAX).join("") || null;

/** 新存一条；这个人已经存过同一条内容时返回已有的那条（existing: true），不新建。 */
export async function createItem(db: Db, userId: string, input: NewItem): Promise<{ id: string; existing: boolean }> {
  const find = async () => {
    const { data, error } = await db.from("items").select("id").eq("user_id", userId).eq("dedupe_key", input.dedupeKey).maybeSingle();
    if (error) throw new Error(`读取收藏库失败: ${error.message}`);
    return data?.id ?? null;
  };
  const had = await find();
  if (had) return { id: had, existing: true };
  const { data, error } = await db
    .from("items")
    .insert({
      ...(input.id ? { id: input.id } : {}),
      user_id: userId,
      source: input.source,
      dedupe_key: input.dedupeKey,
      status: input.status,
      platform: input.platform ?? null,
      external_id: input.externalId ?? null,
      url: input.url ?? null,
      kind: input.kind ?? null,
      title: input.title ?? null,
      user_text: input.userText ?? null,
      media: (input.media ?? []) as unknown as Json,
      note: cleanNote(input.note),
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    // 两次提交撞在一起：唯一索引拦下后面那次，回到先建好的那条
    const raced = error.code === "23505" ? await find() : null;
    if (raced) return { id: raced, existing: true };
    throw new Error(`保存失败: ${error.message}`);
  }
  return { id: data.id, existing: false };
}

export const linkDedupeKey = (ref: Pick<LinkRef, "platform" | "externalId">) => `${ref.platform}:${ref.externalId}`;

/**
 * 重新来一轮，清掉上次的报错。`from` 决定后台任务从哪一步开始：
 * fetch = 重新读链接 / 重新处理上传的文件（会换掉转存的文件）；analyze = 不重读，只重新抽帧转写 + 理解。
 */
export async function restartItem(db: Db, userId: string, id: string, from: "fetch" | "analyze", patch: { url?: string; userText?: string | null } = {}): Promise<void> {
  const { data, error } = await db
    .from("items")
    .update({
      status: from === "fetch" ? "fetching" : "analyzing",
      error: null,
      started_at: new Date().toISOString(),
      ...(patch.url ? { url: patch.url } : {}),
      ...(patch.userText !== undefined ? { user_text: patch.userText } : {}),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");
  if (error) throw new Error(`更新失败: ${error.message}`);
  if (!data?.length) throw new Error("这条内容不在了，刷新看看");
}

/** 用户改备注和标签。标签和模型提的不一样时锁住（重新分析不再覆盖）。 */
export async function updateItemMeta(db: Db, userId: string, id: string, input: { note: string; tags: string[] }): Promise<void> {
  const { data: row, error: selErr } = await db.from("items").select("tags").eq("id", id).eq("user_id", userId).maybeSingle();
  if (selErr) throw new Error(`读取内容失败: ${selErr.message}`);
  if (!row) throw new Error("这条内容不在了，刷新看看");
  const tags = cleanTags(input.tags, 20);
  const changed = tags.join("\n") !== (row.tags ?? []).join("\n");
  const { error } = await db
    .from("items")
    .update({ note: cleanNote(input.note), tags, ...(changed ? { tags_locked: true } : {}) })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(`保存失败: ${error.message}`);
}

/** 删掉这条内容在存储桶里的所有文件（目录下一层，不会有子目录）。best-effort：删不掉只留痕。 */
export async function removeItemFiles(db: Db, userId: string, id: string, keep: string[] = []): Promise<void> {
  const dir = itemDir(userId, id);
  const { data, error } = await db.storage.from(BUCKET).list(dir, { limit: 500 });
  if (error) {
    console.error(`列出文件失败 ${dir}: ${error.message}`);
    return;
  }
  const paths = (data ?? []).map((f) => `${dir}/${f.name}`).filter((p) => !keep.includes(p));
  if (paths.length === 0) return;
  const { error: rmErr } = await db.storage.from(BUCKET).remove(paths);
  if (rmErr) console.error(`删除文件失败 ${dir}: ${rmErr.message}`);
}

/** 删一条内容：行（图谱里的关联跟着级联删）、文件、没人指着的实体。db 要是 service_role（删文件、清实体要权限）。 */
export async function deleteItem(db: Db, userId: string, id: string): Promise<void> {
  const { data, error } = await db.from("items").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) throw new Error(`删除失败: ${error.message}`);
  if (!data?.length) throw new Error("这条内容不在了，刷新看看");
  await removeItemFiles(db, userId, id);
  const { error: pruneErr } = await db.rpc("prune_orphan_entities", { p_user_id: userId });
  if (pruneErr) console.error(`清理没人用的实体失败 user=${userId}: ${pruneErr.message}`);
}

/** 这个人用过的标签（用得多的在前）。 */
export async function tagCounts(db: Db, userId: string): Promise<{ tag: string; n: number }[]> {
  const { data, error } = await db.rpc("tag_counts", { p_user_id: userId });
  if (error) throw new Error(`读取标签失败: ${error.message}`);
  return data ?? [];
}

/**
 * 存储桶自己的单文件上限（字节）；桶没设上限是 null，读不到（桶不在、没权限）是 undefined。db 要是 service_role。
 * 项目还有一个全局的上传上限，接口读不到，只能去控制台看（Storage → Settings）。
 */
export async function bucketFileLimit(db: Db): Promise<number | null | undefined> {
  const { data, error } = await db.storage.getBucket(BUCKET);
  if (error || !data) return undefined;
  return typeof data.file_size_limit === "number" ? data.file_size_limit : null;
}
