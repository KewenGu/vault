import { NextResponse } from "next/server";
import { moveItems } from "@/lib/vault/entity-service";
import { jsonBody, withSession } from "../../../respond";

/**
 * 把几条内容从这个实体移到另一个（拆开并错的）：`{ items: ["内容的 id", …], to: "那个实体的 id 或名字" }`。
 * 图谱里没有叫这个名字的就新建一个（和这个同一类）。一次最多 200 条。
 * 返回 `{ id, name, created, moved, emptied }`：移到的那个实体、是不是新建的、动了几条关联；`emptied` = 这个实体上一条内容都不剩，已经删掉了。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    const items = Array.isArray(body.items) ? body.items.filter((i): i is string => typeof i === "string") : [];
    return NextResponse.json(await moveItems(session, (await params).id, items, typeof body.to === "string" ? body.to : ""));
  });
}
