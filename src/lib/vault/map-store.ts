import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json, MapRecord } from "@/lib/db/types";
import { VaultError } from "./errors";
import { cleanMapNodes, cleanSources, mapNodeSchema, type MapNode } from "./map-nodes";

/** maps 表的读写（自己建的思维导图）。每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），后台用 service role 时只靠它。 */

type Db = SupabaseClient<Database>;

const chatMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string(), at: z.string() }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    at: z.string(),
    /** 这一次改了导图 */
    changed: z.boolean(),
    /** 这次没看到 / 没做到的（材料没带全、搜索不可用…）：页面上列在回复下面 */
    notes: z.array(z.string()).default([]),
    /** 改之前的导图：只有最近一次改图的那条带着，「撤销」就是换回它 */
    before: z.array(mapNodeSchema).optional(),
    undone: z.boolean().optional(),
  }),
]);
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** 对话最多留这么多条（再早的丢掉；给模型看的更少，见 map-chat.ts） */
export const CHAT_KEEP = 60;

export type VaultMap = {
  id: string;
  title: string;
  nodes: MapNode[];
  sources: string[];
  chat: ChatMessage[];
  usage: Record<string, number>;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
};
export type MapSummary = Pick<VaultMap, "id" | "title" | "updatedAt"> & { nodeCount: number; branches: string[] };

/**
 * 查 maps 表出错。表还不存在（应用更新了、迁移还没推到 Supabase——自动更新不动数据库）时说清楚要做什么，
 * 而不是一句「出错了」：Postgres 报 42P01，PostgREST 的表结构缓存里没有这张表时报 PGRST205。
 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError("数据库里还没有导图用的那张表：把迁移 supabase/migrations/20261121000001_maps.sql 推到 Supabase（npx supabase db push，或者把文件内容贴进控制台的 SQL Editor 运行）", 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const MAP_COLUMNS = "id,user_id,title,nodes,sources,chat,usage,cost_usd,created_at,updated_at" as const;

function readChat(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = chatMessageSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

function readUsage(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
}

export function toMap(row: Pick<MapRecord, "id" | "title" | "nodes" | "sources" | "chat" | "usage" | "cost_usd" | "created_at" | "updated_at">): VaultMap {
  return {
    id: row.id,
    title: row.title,
    nodes: cleanMapNodes(row.nodes),
    sources: cleanSources(row.sources),
    chat: readChat(row.chat),
    usage: readUsage(row.usage),
    costUsd: Number(row.cost_usd) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const mapTitle = (map: Pick<VaultMap, "title">) => map.title || "没起名的导图";

/** 这个人的导图，最近改的在前。 */
export async function listMaps(db: Db, userId: string): Promise<MapSummary[]> {
  const { data, error } = await db.from("maps").select("id,title,nodes,updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(200);
  if (error) fail("读取导图失败", error);
  return (data ?? []).map((row) => {
    const nodes = cleanMapNodes(row.nodes);
    return { id: row.id, title: row.title, updatedAt: row.updated_at, nodeCount: nodes.length, branches: nodes.filter((n) => n.depth === 1).map((n) => n.text) };
  });
}

export async function getMap(db: Db, userId: string, id: string): Promise<VaultMap | null> {
  const { data, error } = await db.from("maps").select(MAP_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取导图失败", error);
  return data ? toMap(data) : null;
}

export async function createMap(db: Db, userId: string, input: { title: string; nodes?: MapNode[]; sources?: string[] }): Promise<string> {
  const { data, error } = await db
    .from("maps")
    .insert({ user_id: userId, title: input.title, nodes: (input.nodes ?? []) as unknown as Json, sources: input.sources ?? [] })
    .select("id")
    .single();
  if (error) fail("新建导图失败", error);
  return data.id;
}

export type MapPatch = Partial<Pick<VaultMap, "title" | "nodes" | "sources" | "chat" | "usage" | "costUsd">>;

/** 改一张图（只改给了的列）。图不在了（或不是这个人的）返回 false。 */
export async function updateMap(db: Db, userId: string, id: string, patch: MapPatch): Promise<boolean> {
  const row = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.nodes !== undefined ? { nodes: patch.nodes as unknown as Json } : {}),
    ...(patch.sources !== undefined ? { sources: patch.sources } : {}),
    ...(patch.chat !== undefined ? { chat: patch.chat as unknown as Json } : {}),
    ...(patch.usage !== undefined ? { usage: patch.usage as Json } : {}),
    ...(patch.costUsd !== undefined ? { cost_usd: patch.costUsd } : {}),
  };
  if (Object.keys(row).length === 0) return true;
  const { data, error } = await db.from("maps").update(row).eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("保存导图失败", error);
  return (data ?? []).length > 0;
}

export async function deleteMap(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("maps").delete().eq("id", id).eq("user_id", userId);
  if (error) fail("删除导图失败", error);
}
