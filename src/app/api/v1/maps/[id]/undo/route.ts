import { NextResponse } from "next/server";
import { undoMapChange } from "@/lib/vault/map-service";
import { withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 撤销 AI 最近一次改的图。返回撤销之后的整张图；没有能撤销的回 409。 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await undoMapChange(session, (await params).id)));
}
