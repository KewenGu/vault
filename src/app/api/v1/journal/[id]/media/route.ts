import { NextResponse } from "next/server";
import { beginMediaUpload, listEntryMedia } from "@/lib/vault/journal-service";
import { jsonBody, str, withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 这篇日记里的文件现在的样子（录音在转文字时隔几秒来看一眼）：`{ media: [...] }`。 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json({ media: await listEntryMedia(session, (await params).id) }));
}

/**
 * 开始传一个文件（照片或录音）：`{ name, mime, size }` → `{ media, upload: { bucket, path, token } }`。
 * 把文件用 Supabase Storage 的签名上传传到 path（supabase-js 的 uploadToSignedUrl），传完调
 * `POST /api/v1/journal/<id>/media/<media.id>/complete`，再把 `{ type: "photo" | "audio", media: <media.id> }` 这一块放进 doc.blocks 保存。
 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json(await beginMediaUpload(session, (await params).id, { name: str(body.name), mime: str(body.mime), size: Number(body.size) || 0 }), { status: 201 });
  });
}
