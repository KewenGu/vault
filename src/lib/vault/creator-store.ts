import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreatorPostRecord, CreatorRecord, Database, Json } from "@/lib/db/types";
import { accountLabel, type AccountInfo, type ListedPost } from "@/lib/sources/account";
import { ACCOUNT_PLATFORMS, parseLink, type AccountPlatform, type AccountRef, type LinkRef } from "@/lib/sources/link";
import { POST_KINDS, type PostKind } from "@/lib/sources/types";
import { estimateUsd } from "@/lib/usage/prices";
import { VaultError } from "./errors";
import { STUCK_MS } from "./store";

/**
 * creators / creator_posts 两张表的读写（收藏的博主和他们的作品清单，迁移 20261126000001_creators.sql）。
 * 每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），后台任务用 service role 时只靠它。
 *
 * 一轮（列作品 → 一条条存）由 creators.started_at 标识：后台任务拿着开始时间，每一步先看这一行还是不是自己这一轮
 * （状态是进行中、开始时间对得上），不是就什么都不做——中途又开始了新的一轮、或者用户点了停。
 */

type Db = SupabaseClient<Database>;

export const CREATOR_STATUSES = ["listing", "saving", "ready", "failed"] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];
export const POST_STATUSES = ["pending", "saved", "held"] as const;
export type CreatorPostStatus = (typeof POST_STATUSES)[number];

/** 一次最多列这么多条（「全部」也是这个数：再多的账号分几次存） */
export const CREATOR_MAX_POSTS = 1000;
/**
 * 进行中、但这么久没动静，按中断处理（页面上能接着存）。存每一条之前都会碰一下这一行；一条内容自己最多处理 STUCK_MS，
 * 两条一起处理、再加上列作品时等 actor 的时间，留两倍。
 */
export const CREATOR_STUCK_MS = Math.max(2 * STUCK_MS, 40 * 60_000);

/** 一次同时处理几条内容：默认 2（小服务器上抽帧、转码吃 CPU，开多了反而都慢），VAULT_CREATOR_PARALLEL 调，最多 4 */
export function creatorParallel(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.VAULT_CREATOR_PARALLEL);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 4) : 2;
}

export type Creator = {
  id: string;
  platform: AccountPlatform;
  externalId: string;
  url: string;
  handle: string;
  name: string;
  bio: string;
  postCount: number | null;
  status: CreatorStatus;
  error: string | null;
  want: number;
  notes: string[];
  usage: Record<string, number>;
  costUsd: number;
  startedAt: string;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatorPost = {
  id: string;
  creatorId: string;
  externalId: string;
  url: string;
  kind: PostKind | null;
  title: string;
  publishedAt: string | null;
  pinned: boolean;
  status: CreatorPostStatus;
  itemId: string | null;
};

/** 还在跑（没卡住）。 */
export function creatorBusy(c: Pick<Creator, "status" | "updatedAt">, now = Date.now()): boolean {
  return (c.status === "listing" || c.status === "saving") && now - new Date(c.updatedAt).getTime() < CREATOR_STUCK_MS;
}

/** 状态是进行中、但早就该有动静了（后台任务断了）。 */
export function creatorStuck(c: Pick<Creator, "status" | "updatedAt">, now = Date.now()): boolean {
  return (c.status === "listing" || c.status === "saving") && !creatorBusy(c, now);
}

/** 页面上叫他什么：名字，没有就用 @用户名，再没有（抖音、小红书刚加进来、还没列过）叫「抖音博主」。 */
export function creatorTitle(c: Pick<Creator, "name" | "handle" | "platform">): string {
  const label = accountLabel(c.platform);
  return c.name || c.handle || `${label}${/[a-z]$/i.test(label) ? " " : ""}博主`;
}

/**
 * 查这两张表出错。表还不存在（应用更新了、迁移还没推到 Supabase——自动更新不动数据库）时说清楚要做什么：
 * Postgres 报 42P01，PostgREST 的表结构缓存里没有这张表时报 PGRST205。
 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError("数据库里还没有「博主」用的那两张表：把迁移 supabase/migrations/20261126000001_creators.sql 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）", 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const CREATOR_COLUMNS = "id,user_id,platform,external_id,url,handle,name,bio,post_count,status,error,want,notes,usage,cost_usd,started_at,synced_at,created_at,updated_at" as const;
const POST_COLUMNS = "id,user_id,creator_id,external_id,url,kind,title,published_at,pinned,status,item_id,created_at,updated_at" as const;

function readUsage(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
}

export function toCreator(row: CreatorRecord): Creator {
  return {
    id: row.id,
    platform: ACCOUNT_PLATFORMS.find((p) => p === row.platform) ?? "x",
    externalId: row.external_id,
    url: row.url,
    handle: row.handle ?? "",
    name: row.name ?? "",
    bio: row.bio ?? "",
    postCount: typeof row.post_count === "number" ? row.post_count : null,
    status: CREATOR_STATUSES.find((s) => s === row.status) ?? "failed",
    error: row.error,
    want: Number(row.want) || 0,
    notes: Array.isArray(row.notes) ? row.notes.filter((n): n is string => typeof n === "string") : [],
    usage: readUsage(row.usage),
    costUsd: Number(row.cost_usd) || 0,
    startedAt: row.started_at,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.started_at,
  };
}

export function toCreatorPost(row: CreatorPostRecord): CreatorPost {
  return {
    id: row.id,
    creatorId: row.creator_id,
    externalId: row.external_id,
    url: row.url,
    kind: POST_KINDS.find((k) => k === row.kind) ?? null,
    title: row.title ?? "",
    publishedAt: row.published_at,
    pinned: row.pinned === true,
    status: POST_STATUSES.find((s) => s === row.status) ?? "held",
    itemId: row.item_id,
  };
}

/**
 * 清单里的一条作品存进收藏库时是哪条内容（平台、id、链接）。B 站不是认得的平台：它的视频和单独贴链接时一样按网页存
 * （id 是整理过的地址的哈希）。链接整理不出来（不该发生）返回 null。
 */
export function itemRefOf(platform: AccountPlatform, post: Pick<CreatorPost, "externalId" | "url">): LinkRef | null {
  if (platform === "bilibili") return parseLink(post.url);
  return { platform, externalId: post.externalId, url: post.url };
}

export const accountRefOf = (c: Pick<Creator, "platform" | "externalId" | "handle" | "url">): AccountRef => ({ platform: c.platform, externalId: c.externalId, handle: c.handle, url: c.url });

export async function getCreator(db: Db, userId: string, id: string): Promise<Creator | null> {
  const { data, error } = await db.from("creators").select(CREATOR_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取博主失败", error);
  return data ? toCreator(data) : null;
}

export async function findCreator(db: Db, userId: string, ref: Pick<AccountRef, "platform" | "externalId">): Promise<Creator | null> {
  const { data, error } = await db.from("creators").select(CREATOR_COLUMNS).eq("user_id", userId).eq("platform", ref.platform).eq("external_id", ref.externalId).maybeSingle();
  if (error) fail("读取博主失败", error);
  return data ? toCreator(data) : null;
}

export async function listCreators(db: Db, userId: string): Promise<Creator[]> {
  const { data, error } = await db.from("creators").select(CREATOR_COLUMNS).eq("user_id", userId).order("created_at", { ascending: false }).limit(500);
  if (error) fail("读取博主失败", error);
  return (data ?? []).map(toCreator);
}

/** 新加一个博主，马上开始第一轮（状态 listing）。这个人已经加过同一个账号时返回 null（调用方去读已有的那行）。 */
export async function insertCreator(db: Db, userId: string, ref: AccountRef, want: number): Promise<Creator | null> {
  const { data, error } = await db
    .from("creators")
    .insert({ user_id: userId, platform: ref.platform, external_id: ref.externalId, url: ref.url, handle: ref.handle, status: "listing", want, started_at: new Date().toISOString() })
    .select(CREATOR_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") return null;
    fail("保存博主失败", error);
  }
  return toCreator(data);
}

/**
 * 开始新的一轮：标成进行中、换一个开始时间、清掉上一轮的报错（listing 时连上一轮的 notes 一起清）。
 * 返回这一轮的开始时间；这一行不在了返回 null。
 */
export async function beginRound(db: Db, userId: string, id: string, status: "listing" | "saving", want?: number): Promise<string | null> {
  const startedAt = new Date().toISOString();
  const { data, error } = await db
    .from("creators")
    .update({ status, error: null, started_at: startedAt, ...(status === "listing" ? { notes: [] as Json } : {}), ...(want !== undefined ? { want } : {}) })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");
  if (error) fail("开始失败", error);
  return (data ?? []).length > 0 ? startedAt : null;
}

export type CreatorPatch = Partial<{ status: CreatorStatus; error: string | null; info: AccountInfo; notes: string[]; counts: Record<string, number>; synced: boolean }>;

/**
 * 这一轮往这一行上写东西。只有还是「这一轮在跑」（状态是进行中、开始时间对得上）才写；写上了返回 true。
 * counts 是这一步用掉的量，加在已有的 usage 上。什么都不改也会碰一下 updated_at（页面按它判断卡没卡住）。
 */
export async function patchRound(db: Db, userId: string, creator: Pick<Creator, "id" | "usage" | "notes">, startedAt: string, patch: CreatorPatch): Promise<boolean> {
  const usage = { ...creator.usage };
  for (const [k, n] of Object.entries(patch.counts ?? {})) usage[k] = (usage[k] ?? 0) + n;
  const info = patch.info;
  const { data, error } = await db
    .from("creators")
    .update({
      updated_at: new Date().toISOString(),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(info ? { ...(info.name ? { name: info.name } : {}), ...(info.handle ? { handle: info.handle } : {}), bio: info.bio, ...(info.postCount !== null ? { post_count: info.postCount } : {}) } : {}),
      ...(patch.notes ? { notes: [...creator.notes, ...patch.notes] as Json } : {}),
      ...(patch.counts ? { usage: usage as Json, cost_usd: estimateUsd(usage) } : {}),
      ...(patch.synced ? { synced_at: new Date().toISOString() } : {}),
    })
    .eq("id", creator.id)
    .eq("user_id", userId)
    .eq("started_at", startedAt)
    .in("status", ["listing", "saving"])
    .select("id");
  if (error) fail("更新博主失败", error);
  return (data ?? []).length > 0;
}

/** 用户点了停：不管是哪一轮，标回 ready（后台任务下一步发现不是进行中就不做了）。 */
export async function stopRound(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("creators").update({ status: "ready", error: null }).eq("id", id).eq("user_id", userId).in("status", ["listing", "saving"]);
  if (error) fail("停止失败", error);
}

/** 把列出来的作品记进清单：已经在清单里的不动，新的排队等存。返回新加了几条。 */
export async function addPosts(db: Db, userId: string, creatorId: string, posts: ListedPost[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < posts.length; i += 100) {
    const chunk = posts.slice(i, i + 100);
    const { data: had, error: selErr } = await db.from("creator_posts").select("external_id").eq("creator_id", creatorId).eq("user_id", userId).in("external_id", chunk.map((p) => p.externalId));
    if (selErr) fail("读取作品清单失败", selErr);
    const known = new Set((had ?? []).map((r) => r.external_id));
    const fresh = chunk.filter((p, at) => !known.has(p.externalId) && chunk.findIndex((q) => q.externalId === p.externalId) === at);
    if (fresh.length === 0) continue;
    const { error } = await db.from("creator_posts").insert(
      fresh.map((p) => ({ user_id: userId, creator_id: creatorId, external_id: p.externalId, url: p.url, kind: p.kind, title: p.title, published_at: p.publishedAt, pinned: p.pinned, status: "pending" }))
    );
    // 23505：这一步被重跑了（上一次已经写进去一部分）——下一轮按「已有的不动」再来一遍就对了
    if (error && error.code !== "23505") fail("保存作品清单失败", error);
    if (!error) added += fresh.length;
  }
  return added;
}

/** 接下来要存的几条（排着队的里面最新发的）。 */
export async function nextPending(db: Db, userId: string, creatorId: string, n: number): Promise<CreatorPost[]> {
  const { data, error } = await db
    .from("creator_posts")
    .select(POST_COLUMNS)
    .eq("creator_id", creatorId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(n);
  if (error) fail("读取作品清单失败", error);
  return (data ?? []).map(toCreatorPost);
}

/** 这条作品已经是收藏库里的一条内容了。 */
export async function markSaved(db: Db, userId: string, postId: string, itemId: string): Promise<void> {
  const { error } = await db.from("creator_posts").update({ status: "saved", item_id: itemId }).eq("id", postId).eq("user_id", userId);
  if (error) fail("更新作品清单失败", error);
}

/** 把一条作品改成某种状态。 */
export async function movePost(db: Db, userId: string, postId: string, to: CreatorPostStatus): Promise<void> {
  const { error } = await db.from("creator_posts").update({ status: to }).eq("id", postId).eq("user_id", userId);
  if (error) fail("更新作品清单失败", error);
}

/** 把一种状态的作品全改成另一种（停下：pending → held；接着存：held → pending）。返回改了几条。 */
export async function movePosts(db: Db, userId: string, creatorId: string, from: CreatorPostStatus, to: CreatorPostStatus): Promise<number> {
  const { data, error } = await db.from("creator_posts").update({ status: to }).eq("creator_id", creatorId).eq("user_id", userId).eq("status", from).select("id");
  if (error) fail("更新作品清单失败", error);
  return (data ?? []).length;
}

export type PostCounts = Record<CreatorPostStatus, number>;

/** 清单里各种状态各有几条。 */
export async function countPosts(db: Db, userId: string, creatorId: string): Promise<PostCounts> {
  const counts: PostCounts = { pending: 0, saved: 0, held: 0 };
  for (const status of POST_STATUSES) {
    const { count, error } = await db.from("creator_posts").select("id", { count: "exact", head: true }).eq("creator_id", creatorId).eq("user_id", userId).eq("status", status);
    if (error) fail("读取作品清单失败", error);
    counts[status] = count ?? 0;
  }
  return counts;
}

/** 清单（从新到旧），最多 CREATOR_MAX_POSTS × 2 条。 */
export async function listPosts(db: Db, userId: string, creatorId: string): Promise<CreatorPost[]> {
  const out: CreatorPost[] = [];
  const PAGE = 1000;
  for (let from = 0; from < CREATOR_MAX_POSTS * 2; from += PAGE) {
    const { data, error } = await db
      .from("creator_posts")
      .select(POST_COLUMNS)
      .eq("creator_id", creatorId)
      .eq("user_id", userId)
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) fail("读取作品清单失败", error);
    out.push(...(data ?? []).map(toCreatorPost));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

/** 一条内容是从哪个博主那里存进来的（不是的返回 null）。 */
export async function creatorOfItem(db: Db, userId: string, itemId: string): Promise<Creator | null> {
  const { data, error } = await db.from("creator_posts").select("creator_id").eq("item_id", itemId).eq("user_id", userId).limit(1);
  // 表还没建：这一行不显示就是了，不拦着详情页
  if (error) return null;
  const creatorId = data?.[0]?.creator_id;
  return creatorId ? getCreator(db, userId, creatorId).catch(() => null) : null;
}

/** 删掉一个博主和他的作品清单（存进收藏库的内容不动）。不在了返回 false。 */
export async function deleteCreator(db: Db, userId: string, id: string): Promise<boolean> {
  const { data, error } = await db.from("creators").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("删除失败", error);
  return (data ?? []).length > 0;
}
