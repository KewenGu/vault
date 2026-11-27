import { NextResponse } from "next/server";
import { getEntityPage, removeAlias, renameEntity } from "@/lib/vault/entity-service";
import { itemSummary } from "../../items/serialize";
import { jsonBody, withSession } from "../../respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 图谱里的一个实体和关于它的一切：`{ entity: { id, type, name, aliases, summary }, items: [{ …一条内容（和列表里的一样）, about }], total, capped,
 * neighbors: [{ id, name, type, relation, outgoing, weight }], notes: [{ note, itemTitle }], gaps }`。
 * `items` 是提到它的内容，新存的在前，一次 60 条，`offset` 翻页；`about` 是它在那条内容里的角色；最多能列 200 条（`capped`）。
 * `neighbors` 是和它有关系的实体：`relation` 是内容里明说的关系，`cooccur` = 只是出现在同一条内容里；`outgoing` 是方向；`weight` 是几条内容这么说。
 * `notes` 是自己在这一页的内容上划的线、写的批注。`gaps` 是这次没读到的。
 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    const page = await getEntityPage(session, (await params).id, { offset: Number.isFinite(offset) && offset > 0 ? offset : 0 });
    return NextResponse.json({
      entity: page.entity,
      items: page.items.map(({ item, about }) => ({ ...itemSummary(item), about })),
      total: page.total,
      capped: page.capped,
      neighbors: page.neighbors,
      notes: page.notes,
      gaps: page.gaps,
    });
  });
}

/**
 * 改名字和说明：`{ name?, summary? }`（换了名字，旧名字记成别名；同一类里已经有叫这个名字的回 409）。
 * 去掉一个别名：`{ removeAlias: "那个叫法" }`。返回 `{ entity }`。
 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    const body = await jsonBody(request);
    let entity = typeof body.removeAlias === "string" ? await removeAlias(session, id, body.removeAlias) : null;
    if (typeof body.name === "string" || typeof body.summary === "string" || !entity) {
      entity = await renameEntity(session, id, { name: typeof body.name === "string" ? body.name : undefined, summary: typeof body.summary === "string" ? body.summary : undefined });
    }
    return NextResponse.json({ entity });
  });
}
