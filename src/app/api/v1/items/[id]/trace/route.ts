import { NextResponse } from "next/server";
import { getItemTrace, startTrace } from "@/lib/vault/service";
import { traceRunning, traceStuck, type ItemTrace } from "@/lib/vault/trace-store";
import { withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 接口返回的溯源结果：status 里把「卡住了」算成 failed（和内容的 status 一样），running 的时候隔几秒再来读。 */
const serialize = (trace: ItemTrace | null) =>
  trace && {
    status: traceStuck(trace) ? "failed" : trace.status,
    running: traceRunning(trace),
    error: traceStuck(trace) ? "溯源中断了（后台任务没跑完）" : trace.error,
    result: trace.result,
    costUsd: trace.costUsd,
    startedAt: trace.startedAt,
    updatedAt: trace.updatedAt,
  };

/** 这条内容的溯源结果：`{ trace }`，还没溯源过是 `{ trace: null }`。 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    return NextResponse.json({ trace: serialize(await getItemTrace(session, id)) });
  });
}

/** 开始溯源（溯源过的是重新查一遍）。后台做，一般一两分钟：返回 `{ trace }`（running），之后用 GET 看结果。 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    return NextResponse.json({ trace: serialize(await startTrace(session, id)) });
  });
}
