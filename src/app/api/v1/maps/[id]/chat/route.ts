import { NextResponse } from "next/server";
import { chatOnMap, draftMap } from "@/lib/vault/map-service";
import { jsonBody, str, withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 跟 AI 说一句话：`{ message, title?, nodes? }`（title / nodes 是客户端当前还没保存的样子，给了就先存下再问）。
 * `{ draft: true }` = 让它按标题从收藏库里起草。要等模型，一般十几秒到一分钟。返回改完之后的整张图（和 GET 一样的形状）。
 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    const body = await jsonBody(request);
    const edits = { title: body.title, nodes: body.nodes };
    return NextResponse.json(body.draft === true ? await draftMap(session, id, edits) : await chatOnMap(session, id, { message: str(body.message), ...edits }));
  });
}
