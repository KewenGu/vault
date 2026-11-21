import { NextResponse } from "next/server";
import { createMapFor, draftMap, listMyMaps } from "@/lib/vault/map-service";
import { jsonBody, str, withSession } from "../respond";

/** 列出自己的导图：`[{ id, title, nodeCount, branches, updatedAt }]`，最近改的在前。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json({ maps: await listMyMaps(session) }));
}

/**
 * 新建一张导图：`{ title?, itemId?, draft? }`。itemId = 从收藏库里的一条内容开始（抄它的大纲、挂成来源）；
 * draft = true 建好后让 AI 按标题从收藏库里起草（要等模型，一般十几秒到一分钟）。返回 `{ id }`。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    const id = await createMapFor(session, { title: str(body.title), itemId: str(body.itemId) || undefined });
    if (body.draft === true) await draftMap(session, id);
    return NextResponse.json({ id });
  });
}
