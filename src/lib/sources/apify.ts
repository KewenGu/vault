import { labeledFetch } from "@/lib/fetch-error";
import { httpError } from "@/lib/error-text";
import { SourceFetchError } from "./types";

/**
 * Apify 上跑一个 actor，不在一次请求里等它跑完：先开始，隔一会儿问一次状态，跑完再取结果。
 * 读一条帖子用的是同步端点（等不超过 300 秒，见 douyin.ts）；列一个账号的几百条作品可能更久，所以走这条路——
 * 中间的等待放在后台任务的 sleep 里（workflows/collect-creator.ts），不占着一个请求。
 *
 * 令牌放请求头，不进 URL（报错信息、日志里不会带出来）。
 */

const API = "https://api.apify.com/v2";
const SERVICE = "Apify(api.apify.com)";

export type ActorRun = {
  id: string;
  datasetId: string;
  /** READY / RUNNING 还在跑；SUCCEEDED 跑完了；FAILED / TIMED-OUT / ABORTED 没跑成（数据集里可能有一部分结果） */
  status: string;
  statusMessage: string;
};

/** 还在跑（没到终态）。 */
export const runPending = (run: Pick<ActorRun, "status">) => run.status === "READY" || run.status === "RUNNING" || run.status === "TIMING-OUT" || run.status === "ABORTING";

export function apifyToken(what: string): string {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new SourceFetchError(`${what}要用 Apify（环境变量 APIFY_TOKEN 没配）`);
  return token;
}

function readRun(json: unknown, actor: string): ActorRun {
  const d = (json && typeof json === "object" ? (json as { data?: Record<string, unknown> }).data : null) ?? {};
  const id = typeof d.id === "string" ? d.id : "";
  const datasetId = typeof d.defaultDatasetId === "string" ? d.defaultDatasetId : "";
  if (!id || !datasetId) throw new Error(`apify(${actor}) 结构异常: 没有运行 id`);
  return { id, datasetId, status: typeof d.status === "string" ? d.status : "", statusMessage: typeof d.statusMessage === "string" ? d.statusMessage : "" };
}

/**
 * 开始一次运行。timeoutS：Apify 那边最多跑多久；maxChargeUsd：按结果计费的 actor 这一次最多收多少钱
 * （到了就停，免得一个参数写错跑出几千条）。
 */
export async function startActorRun(token: string, actor: string, input: unknown, opts: { timeoutS: number; maxChargeUsd?: number }): Promise<ActorRun> {
  const qs = new URLSearchParams({ timeout: String(opts.timeoutS) });
  if (opts.maxChargeUsd) qs.set("maxTotalChargeUsd", opts.maxChargeUsd.toFixed(2));
  const res = await labeledFetch(SERVICE, `${API}/acts/${actor}/runs?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await httpError(`apify(${actor})`, res);
  return readRun(await res.json(), actor);
}

export async function getActorRun(token: string, runId: string): Promise<ActorRun> {
  const res = await labeledFetch(SERVICE, `${API}/actor-runs/${runId}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw await httpError("apify(运行状态)", res);
  return readRun(await res.json(), runId);
}

/** 让一次运行停下（等太久不等了）。停不掉只留痕。 */
export async function abortActorRun(token: string, runId: string): Promise<void> {
  try {
    const res = await labeledFetch(SERVICE, `${API}/actor-runs/${runId}/abort`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    console.error(`停止 Apify 运行失败 run=${runId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const PAGE = 250;

/** 取一次运行的全部结果（一页一页取，最多 max 条）。 */
export async function readDatasetItems(token: string, datasetId: string, max: number): Promise<unknown[]> {
  const out: unknown[] = [];
  while (out.length < max) {
    const limit = Math.min(PAGE, max - out.length);
    const res = await labeledFetch(SERVICE, `${API}/datasets/${datasetId}/items?clean=true&offset=${out.length}&limit=${limit}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw await httpError("apify(结果)", res);
    const page = (await res.json()) as unknown;
    if (!Array.isArray(page)) throw new Error(`apify(结果) 结构异常: 期望数组，得到 ${typeof page}`);
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}
