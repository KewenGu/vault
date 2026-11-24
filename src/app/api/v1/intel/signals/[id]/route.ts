import { NextResponse } from "next/server";
import { markSignal } from "@/lib/vault/intel-service";
import { jsonBody, withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 不要这一条 / 把忽略掉的放回去：`{ status: "dismissed" | "new" }`。 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    await markSignal(session, (await params).id, body.status);
    return NextResponse.json({ ok: true });
  });
}
