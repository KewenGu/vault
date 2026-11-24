import { NextResponse } from "next/server";
import { editWatch, removeWatch } from "@/lib/vault/intel-service";
import { jsonBody, withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 改一个来源：`{ enabled?, minScore?, keywords? }`，只改给了的。 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    await editWatch(session, (await params).id, { enabled: body.enabled, minScore: body.minScore, keywords: body.keywords });
    return NextResponse.json({ ok: true });
  });
}

/** 删一个来源，它发现的内容跟着删（已经存进收藏库的那些内容不受影响）。 */
export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    await removeWatch(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
