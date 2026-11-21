import { NextResponse } from "next/server";
import { getMapDetail, removeMap, saveMap } from "@/lib/vault/map-service";
import { jsonBody, withSession } from "../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 一张导图：`{ map: { id, title, nodes: [{ depth, text, item }], sources, chat, … }, sources: [{ id, title, origin }] }`。 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await getMapDetail(session, (await params).id)));
}

/** 保存自己改的：`{ title?, nodes?, sources? }`，只改给了的。 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    await saveMap(session, (await params).id, { title: body.title, nodes: body.nodes, sources: body.sources });
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    await removeMap(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
