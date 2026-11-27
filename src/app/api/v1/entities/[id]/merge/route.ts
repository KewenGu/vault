import { NextResponse } from "next/server";
import { mergeEntity } from "@/lib/vault/entity-service";
import { jsonBody, withSession } from "../../../respond";

/**
 * 把这个实体并进另一个：`{ into: "那一个的 id 或名字" }`。提到它的内容和它的关系都挂到那一个上，它的名字和别名变成那一个的别名，它自己删掉。
 * 不能撤销。返回 `{ id, name, moved }`：并进去的那个实体，和动了几条关联。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json(await mergeEntity(session, (await params).id, typeof body.into === "string" ? body.into : ""));
  });
}
