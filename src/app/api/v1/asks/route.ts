import { NextResponse } from "next/server";
import { askVault, listMyAsks } from "@/lib/vault/ask-service";
import { jsonBody, str, withSession } from "../respond";

/** 问过的问题：`{ asks: [{ id, title, turns, excerpt, updatedAt }] }`，最近的在前。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json({ asks: await listMyAsks(session) }));
}

/**
 * 对着收藏库问一个问题：`{ question }`。要等模型，一般十几秒到一分钟。返回这次提问的全部内容（和 `GET /api/v1/asks/:id` 一样的形状）：
 * `{ ask: { id, title, chat, costUsd… }, gone }`。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => NextResponse.json(await askVault(session, { question: str((await jsonBody(request)).question) })));
}
