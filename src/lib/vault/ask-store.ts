import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AskRecord, Database, Json } from "@/lib/db/types";
import { stripCiteMarks } from "./ask";
import { VaultError } from "./errors";
import { cleanSources } from "./map-nodes";

/** asks 表的读写（「问 Vault」的一次次提问）。每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），后台用 service role 时只靠它。 */

type Db = SupabaseClient<Database>;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** 回答引用的一条收藏：标题和来源是回答那一刻的样子（那条内容后来删了，这里还说得出引用的是什么） */
const citeSchema = z.object({ id: uuid, title: z.string(), origin: z.string() });
export type AskCite = z.infer<typeof citeSchema>;

const askMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string(), at: z.string() }),
  z.object({
    role: z.literal("assistant"),
    /** 回答。出处写成 [1]、[2]…：第 n 个是 cites[n - 1] */
    text: z.string(),
    at: z.string(),
    cites: z.array(citeSchema).default([]),
    /** 这次没看到 / 没做到的（语义搜索不可用、回答被截断、编号对不上…）：页面上列在回答下面 */
    notes: z.array(z.string()).default([]),
    /** 这次给模型看了几条收藏；收藏库里处理好的一共几条（没数出来是 null） */
    seen: z.number().int().min(0).default(0),
    total: z.number().int().min(0).nullable().default(null),
  }),
]);
export type AskMessage = z.infer<typeof askMessageSchema>;

/** 一次提问最多留这么多条对话（再早的丢掉；给模型看的更少，见 ask.ts） */
export const ASK_CHAT_KEEP = 60;
export const ASK_TITLE_MAX = 120;

export type Ask = {
  id: string;
  title: string;
  chat: AskMessage[];
  sources: string[];
  usage: Record<string, number>;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
};
/** 列表里的一行：turns = 问了几句；excerpt = 最后一次回答的开头 */
export type AskSummary = Pick<Ask, "id" | "title" | "updatedAt"> & { turns: number; excerpt: string };

/**
 * 查 asks 表出错。表还不存在（应用更新了、迁移还没推到 Supabase——自动更新不动数据库）时说清楚要做什么，
 * 而不是一句「出错了」：Postgres 报 42P01，PostgREST 的表结构缓存里没有这张表时报 PGRST205。
 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError("数据库里还没有「问」用的那张表：把迁移 supabase/migrations/20261126000002_asks.sql 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）", 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const ASK_COLUMNS = "id,user_id,title,chat,sources,usage,cost_usd,created_at,updated_at" as const;

function readChat(raw: unknown): AskMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = askMessageSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

function readUsage(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
}

export function toAsk(row: Pick<AskRecord, "id" | "title" | "chat" | "sources" | "usage" | "cost_usd" | "created_at" | "updated_at">): Ask {
  return {
    id: row.id,
    title: row.title,
    chat: readChat(row.chat),
    sources: cleanSources(row.sources),
    usage: readUsage(row.usage),
    costUsd: Number(row.cost_usd) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const askTitle = (ask: Pick<Ask, "title">) => ask.title || "没写问题的一次提问";

const EXCERPT = 90;

/** 这个人问过的，最近的在前。 */
export async function listAsks(db: Db, userId: string): Promise<AskSummary[]> {
  const { data, error } = await db.from("asks").select("id,title,chat,updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(100);
  if (error) fail("读取问过的问题失败", error);
  return (data ?? []).map((row) => {
    const chat = readChat(row.chat);
    const last = chat.findLast((m) => m.role === "assistant");
    const text = last ? stripCiteMarks(last.text).replace(/\s+/g, " ").trim() : "";
    return { id: row.id, title: row.title, updatedAt: row.updated_at, turns: chat.filter((m) => m.role === "user").length, excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text };
  });
}

/** 按标题找一次提问（一周回顾靠标题认是哪一周的，见 review.ts）。没有返回 null。 */
export async function findAskByTitle(db: Db, userId: string, title: string): Promise<string | null> {
  const { data, error } = await db.from("asks").select("id").eq("user_id", userId).eq("title", title).order("updated_at", { ascending: false }).limit(1);
  if (error) fail("读取问过的问题失败", error);
  return data?.[0]?.id ?? null;
}

export async function getAsk(db: Db, userId: string, id: string): Promise<Ask | null> {
  const { data, error } = await db.from("asks").select(ASK_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("读取这次提问失败", error);
  return data ? toAsk(data) : null;
}

export type AskPatch = Partial<Pick<Ask, "chat" | "sources" | "usage" | "costUsd">>;

const toRow = (patch: AskPatch) => ({
  ...(patch.chat !== undefined ? { chat: patch.chat as unknown as Json } : {}),
  ...(patch.sources !== undefined ? { sources: patch.sources } : {}),
  ...(patch.usage !== undefined ? { usage: patch.usage as Json } : {}),
  ...(patch.costUsd !== undefined ? { cost_usd: patch.costUsd } : {}),
});

export async function createAsk(db: Db, userId: string, input: { title: string } & AskPatch): Promise<string> {
  const { data, error } = await db
    .from("asks")
    .insert({ user_id: userId, title: input.title, ...toRow(input) })
    .select("id")
    .single();
  if (error) fail("保存这次提问失败", error);
  return data.id;
}

/** 改一次提问（只改给了的列）。不在了（或不是这个人的）返回 false。 */
export async function updateAsk(db: Db, userId: string, id: string, patch: AskPatch): Promise<boolean> {
  const row = toRow(patch);
  if (Object.keys(row).length === 0) return true;
  const { data, error } = await db.from("asks").update(row).eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("保存这次提问失败", error);
  return (data ?? []).length > 0;
}

export async function deleteAsk(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("asks").delete().eq("id", id).eq("user_id", userId);
  if (error) fail("删除失败", error);
}

/** 表在不在（「问」页在提问之前先看一眼：没推迁移时先说，不让他等完模型才知道存不下）。 */
export async function asksReady(db: Db, userId: string): Promise<void> {
  const { error } = await db.from("asks").select("id").eq("user_id", userId).limit(1);
  if (error) fail("读取问过的问题失败", error);
}
