import { NextResponse } from "next/server";
import { beginStickerUpload, listMyStickers } from "@/lib/vault/journal-service";
import { jsonBody, str, withSession } from "../../respond";

/** 我的贴纸（自己传的图片），新传的在前：`{ stickers: [{ id, url, width, height }] }`。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json({ stickers: await listMyStickers(session) }));
}

/**
 * 开始传一张贴纸（只收图片）：`{ name, mime, size }` → `{ id, upload: { bucket, path, token } }`。
 * 把文件用签名上传传到 path，传完调 `POST /api/v1/journal/stickers/<id>/complete`。
 * 贴到一篇日记上：往它的 doc.decos 里加 `{ id, kind: "mine", anchor, x, y, r, s, data: { sticker: <id> } }`。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json(await beginStickerUpload(session, { name: str(body.name), mime: str(body.mime), size: Number(body.size) || 0 }), { status: 201 });
  });
}
