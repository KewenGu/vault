import { getServiceClient } from "@/lib/supabase/service";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { getItem } from "@/lib/vault/store";
import { traceInputOf, traceSources } from "@/lib/vault/trace";
import { readPageForTrace } from "@/lib/vault/trace-reader";
import { endTrace, getTrace } from "@/lib/vault/trace-store";
import type { OutputLanguage } from "@/lib/vault/understand";

/**
 * 用户点了「溯源」之后的后台任务：让 Claude 联网去找这条内容引用的东西的第一手出处、读原文核对（lib/vault/trace.ts），
 * 把结果写进 item_traces。要搜、要读网页，一般一两分钟，所以不在请求里等，页面自己刷新看结果。
 *
 * - 开头先看这一行还是不是「这一轮在查」（startedAt 对得上）：中途又点了一次、或者服务重启后重跑到已经结束的一轮，直接不做。
 * - 没成（接口出错、被截断、没给出结果）把原因写回去，不自动重试：每做一次都要重新搜、重新读，是要花钱的；上一轮的结果留着。
 * - 花掉的量（token、搜索次数）成不成都记进这一行的 usage（钱已经花了）。
 */

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const outputLanguage = (): OutputLanguage => (process.env.VAULT_LANGUAGE?.trim().toLowerCase() === "en" ? "en" : "zh");

async function traceItemStep(itemId: string, userId: string, startedAt: string): Promise<void> {
  "use step";
  const db = getServiceClient();
  const trace = await getTrace(db, userId, itemId);
  if (!trace || trace.status !== "running" || Date.parse(trace.startedAt) !== Date.parse(startedAt)) return;
  const counts: Record<string, number> = {};
  const spent = () => {
    const usage = { ...trace.usage };
    for (const [k, n] of Object.entries(counts)) usage[k] = (usage[k] ?? 0) + n;
    return { usage, costUsd: estimateUsd(usage) };
  };
  try {
    const item = await getItem(db, userId, itemId);
    if (!item) return; // 这会儿被删了：这一行跟着内容级联删掉了
    const result = await meterInto(counts, () => traceSources(traceInputOf(item, outputLanguage(), new Date()), { readPage: readPageForTrace }));
    await endTrace(db, userId, itemId, startedAt, { status: "ready", error: null, result, ...spent() });
  } catch (e) {
    console.error(`溯源出错 item=${itemId}: ${messageOf(e)}`);
    await endTrace(db, userId, itemId, startedAt, { status: "failed", error: messageOf(e).slice(0, 500), ...spent() }).catch((err) => console.error(`标记溯源失败出错 item=${itemId}: ${messageOf(err)}`));
  }
}

export async function traceItem(itemId: string, userId: string, startedAt: string) {
  "use workflow";
  await traceItemStep(itemId, userId, startedAt);
}
