import { NextResponse } from "next/server";
import { finishStickerUpload } from "@/lib/vault/journal-service";
import { withSession } from "../../../../respond";

/** 贴纸传完了：裁掉四周的空白、缩小、存成保留透明底的 WebP。返回 `{ sticker: { id, url, width, height } }`。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => NextResponse.json({ sticker: await finishStickerUpload(session, (await params).id) }));
}
