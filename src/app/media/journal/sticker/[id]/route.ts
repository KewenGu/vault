import { NextResponse } from "next/server";
import { apiSession } from "@/lib/auth/user";
import { getServiceClient } from "@/lib/supabase/service";
import { getSticker } from "@/lib/vault/journal-store";
import { isUuid } from "@/lib/vault/map-nodes";
import { BUCKET } from "@/lib/vault/store";

/**
 * 页面上读一张「我的贴纸」：确认它是当前用户的，然后跳到存储桶的短时效签名地址（和 /media/journal/<文件> 同一个做法）。
 * 一张贴纸传好之后不会再变，这个跳转可以让浏览器记一阵子（比签名的有效期短）。
 */
const SIGNED_SECONDS = 3600;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await apiSession(request).catch(() => null);
  if (!session) return new NextResponse("请先登录", { status: 401 });
  const sticker = isUuid(id) ? await getSticker(session.db, session.user.id, id).catch(() => null) : null;
  if (!sticker || sticker.status !== "ready") return new NextResponse("贴纸不在了", { status: 404 });
  const { data, error } = await getServiceClient().storage.from(BUCKET).createSignedUrl(sticker.path, SIGNED_SECONDS);
  if (error || !data) {
    console.error(`签名地址没拿到 ${sticker.path}: ${error?.message ?? "没有返回"}`);
    return new NextResponse("贴纸暂时读不了", { status: 502 });
  }
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "cache-control": `private, max-age=${SIGNED_SECONDS - 600}` } });
}
