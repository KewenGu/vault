import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ItemTraceRecord, Json } from "@/lib/db/types";
import { VaultError } from "./errors";
import { readTraceResult, type TraceResult } from "./trace";

/**
 * item_traces 表的读写（一条内容的溯源结果，迁移 20261123000001_item_traces.sql）。
 * 每个查询都带 user_id：页面用登录用户的客户端（行级安全也拦一道），后台任务用 service role 时只靠它。
 */

type Db = SupabaseClient<Database>;

export const TRACE_STATUSES = ["running", "ready", "failed"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** 溯源超过这么久还没结束，按中断处理（页面上能重新点）。联网查一般一两分钟，慢的几分钟 */
export const TRACE_STUCK_MS = 15 * 60_000;

export type ItemTrace = {
  itemId: string;
  status: TraceStatus;
  error: string | null;
  /** 最近一次查成的结果；这一轮失败了，上一轮的还留着 */
  result: TraceResult | null;
  usage: Record<string, number>;
  costUsd: number;
  startedAt: string;
  updatedAt: string;
};

/**
 * 一条内容一共花了多少：处理（读取、理解、建索引，还有批注）记在 items.cost_usd，溯源记在这张表里，这里加起来。
 * 溯源的不直接写进 items.cost_usd：那个数还被拿来估「存一条内容大概多少钱」（creator-service 的 costHint），
 * 溯源一次可能比处理贵一个数量级，混进去那个估计就不准了。
 */
export function itemTotalCost(item: { costUsd: number }, trace: Pick<ItemTrace, "costUsd"> | null): number {
  return Math.round((item.costUsd + (trace?.costUsd ?? 0)) * 1e6) / 1e6;
}

/** 还在查（没卡住）。 */
export function traceRunning(trace: Pick<ItemTrace, "status" | "startedAt">, now = Date.now()): boolean {
  return trace.status === "running" && now - new Date(trace.startedAt).getTime() < TRACE_STUCK_MS;
}

/** 状态是在查、但早就该结束了（后台任务没跑完就断了）。 */
export function traceStuck(trace: Pick<ItemTrace, "status" | "startedAt">, now = Date.now()): boolean {
  return trace.status === "running" && !traceRunning(trace, now);
}

/**
 * 查 item_traces 表出错。表还不存在（应用更新了、迁移还没推到 Supabase——自动更新不动数据库）时说清楚要做什么：
 * Postgres 报 42P01，PostgREST 的表结构缓存里没有这张表时报 PGRST205。
 */
function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new VaultError("数据库里还没有溯源用的那张表：把迁移 supabase/migrations/20261123000001_item_traces.sql 推到 Supabase（把文件内容贴进控制台的 SQL Editor 运行；或者 npx supabase link 之后 npx supabase db push --remote）", 503);
  }
  throw new Error(`${what}: ${error.message}`);
}

const TRACE_COLUMNS = "item_id,status,error,result,usage,cost_usd,started_at,updated_at" as const;

function readUsage(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
}

export function toTrace(row: Pick<ItemTraceRecord, "item_id" | "status" | "error" | "result" | "usage" | "cost_usd" | "started_at" | "updated_at">): ItemTrace {
  return {
    itemId: row.item_id,
    status: TRACE_STATUSES.find((s) => s === row.status) ?? "failed",
    error: row.error,
    result: readTraceResult(row.result),
    usage: readUsage(row.usage),
    costUsd: Number(row.cost_usd) || 0,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export async function getTrace(db: Db, userId: string, itemId: string): Promise<ItemTrace | null> {
  const { data, error } = await db.from("item_traces").select(TRACE_COLUMNS).eq("item_id", itemId).eq("user_id", userId).maybeSingle();
  if (error) fail("读取溯源结果失败", error);
  return data ? toTrace(data) : null;
}

/**
 * 开始一轮：没有这一行就建，有就标回 running（上一轮的结果和累计的用量留着）。返回这一轮的开始时间——
 * 后台任务拿着它，写结果时对得上才写（中途又点了一次「重新溯源」，前一轮的结果就不写了）。
 */
export async function beginTrace(db: Db, userId: string, itemId: string, had: ItemTrace | null): Promise<string> {
  const startedAt = new Date().toISOString();
  if (had) {
    const { data, error } = await db.from("item_traces").update({ status: "running", error: null, started_at: startedAt }).eq("item_id", itemId).eq("user_id", userId).select("item_id");
    if (error) fail("开始溯源失败", error);
    if ((data ?? []).length > 0) return startedAt;
  }
  const { error } = await db.from("item_traces").insert({ item_id: itemId, user_id: userId, status: "running", started_at: startedAt });
  if (error) {
    // 23503 = 外键拦下了：这条内容不在了（或者不是这个人的）；23505 = 两次点击撞在一起，先到的那次已经建好并开始了
    if (error.code === "23503") throw new VaultError("这条内容不在了", 404);
    if (error.code === "23505") throw new VaultError("正在溯源，等它结束再试", 409);
    fail("开始溯源失败", error);
  }
  return startedAt;
}

export type TracePatch = { status: "ready" | "failed"; error: string | null; result?: TraceResult; usage?: Record<string, number>; costUsd?: number };

/** 写这一轮的结局。只有还是「这一轮在查」（状态是 running、开始时间对得上）才写；写上了返回 true。 */
export async function endTrace(db: Db, userId: string, itemId: string, startedAt: string, patch: TracePatch): Promise<boolean> {
  const { data, error } = await db
    .from("item_traces")
    .update({
      status: patch.status,
      error: patch.error,
      ...(patch.result ? { result: patch.result as unknown as Json } : {}),
      ...(patch.usage ? { usage: patch.usage as Json } : {}),
      ...(patch.costUsd !== undefined ? { cost_usd: patch.costUsd } : {}),
    })
    .eq("item_id", itemId)
    .eq("user_id", userId)
    .eq("status", "running")
    .eq("started_at", startedAt)
    .select("item_id");
  if (error) fail("保存溯源结果失败", error);
  return (data ?? []).length > 0;
}
