import { NextResponse } from "next/server";
import { entitiesOfItem } from "@/lib/graph/data";
import { removeItem, VaultError } from "@/lib/vault/service";
import { getItem, updateItemMeta } from "@/lib/vault/store";
import { parseTagInput } from "@/lib/vault/taxonomy";
import { jsonBody, str, withSession } from "../../respond";
import { itemDetail } from "../serialize";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    const item = UUID.test(id) ? await getItem(session.db, session.user.id, id) : null;
    if (!item) throw new VaultError("这条内容不在了", 404);
    return NextResponse.json({ ...itemDetail(item), entities: await entitiesOfItem(session.db, session.user.id, id) });
  });
}

/** 改备注 / 标签：`{ note?: string, tags?: string[] | "逗号分隔" }`。 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    const item = UUID.test(id) ? await getItem(session.db, session.user.id, id) : null;
    if (!item) throw new VaultError("这条内容不在了", 404);
    const body = await jsonBody(request);
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : typeof body.tags === "string" ? parseTagInput(body.tags) : item.tags;
    await updateItemMeta(session.db, session.user.id, id, { note: typeof body.note === "string" ? str(body.note) : item.note, tags });
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    if (!UUID.test(id)) throw new VaultError("这条内容不在了", 404);
    await removeItem(session, id);
    return NextResponse.json({ ok: true });
  });
}
