import { NextResponse } from "next/server";
import { saveSignal } from "@/lib/vault/intel-service";
import { withSession } from "../../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 把这一条存进收藏库（和 `POST /api/v1/items` 贴它的链接一样）。返回 `{ itemId, existing }`。 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await saveSignal(session, (await params).id)));
}
