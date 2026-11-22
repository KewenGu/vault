import { NextResponse } from "next/server";
import { removeSticker } from "@/lib/vault/journal-service";
import { withSession } from "../../../respond";

/** 从「我的贴纸」里删一张。日记上贴着的那一件不会被拿掉，只是画不出来了。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    await removeSticker(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
