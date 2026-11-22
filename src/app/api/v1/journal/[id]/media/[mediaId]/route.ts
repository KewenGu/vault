import { NextResponse } from "next/server";
import { removeMedia } from "@/lib/vault/journal-service";
import { withSession } from "../../../../respond";

/** 删一个文件（正文里指着它的那一块要自己从 doc.blocks 里拿掉）。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  return withSession(request, async (session) => {
    await removeMedia(session, (await params).mediaId);
    return NextResponse.json({ ok: true });
  });
}
