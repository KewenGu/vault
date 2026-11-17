import { NextResponse } from "next/server";
import { beginUpload } from "@/lib/vault/service";
import { BUCKET } from "@/lib/vault/store";
import { jsonBody, str, withSession } from "../respond";

/**
 * 开始上传一个文件：`{ name, mime, size, sha256, note? }` →
 * `{ id, existing, upload: { bucket, path, token } | null }`。
 * upload 不是 null 时，把文件用 Supabase Storage 的签名上传传到 path（supabase-js 的 uploadToSignedUrl），
 * 传完调 `POST /api/v1/uploads/<id>/complete`。upload 是 null = 这个文件已经存过，不用再传。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    const ticket = await beginUpload(session, { name: str(body.name), mime: str(body.mime), size: Number(body.size) || 0, sha256: str(body.sha256) }, str(body.note));
    return NextResponse.json({ id: ticket.id, existing: ticket.existing, upload: ticket.upload ? { bucket: BUCKET, ...ticket.upload } : null }, { status: ticket.upload ? 201 : 200 });
  });
}
