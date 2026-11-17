import { NextResponse } from "next/server";
import { apiSession } from "@/lib/auth/user";
import { getServiceClient } from "@/lib/supabase/service";
import { BUCKET, getItem } from "@/lib/vault/store";

/**
 * 页面上读一个转存的文件：确认这条内容是当前用户的、文件登记在它名下，然后跳到存储桶的短时效签名地址
 * （存储服务自己支持分段请求，视频能拖进度条；文件不经过这台服务器）。
 * 地址里的 ?v= 跟着每一轮处理变，所以这个跳转可以让浏览器记一阵子（比签名的有效期短）。
 */
const SIGNED_SECONDS = 3600;

export async function GET(request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const session = await apiSession(request).catch(() => null);
  if (!session) return new NextResponse("请先登录", { status: 401 });
  const item = /^[0-9a-f-]{36}$/i.test(id) ? await getItem(session.db, session.user.id, id) : null;
  const media = item?.media.find((m) => m.path.split("/").pop() === file);
  if (!item || !media) return new NextResponse("文件不在了", { status: 404 });
  const { data, error } = await getServiceClient().storage.from(BUCKET).createSignedUrl(media.path, SIGNED_SECONDS);
  if (error || !data) {
    console.error(`签名地址没拿到 ${media.path}: ${error?.message ?? "没有返回"}`);
    return new NextResponse("文件暂时读不了", { status: 502 });
  }
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "cache-control": `private, max-age=${SIGNED_SECONDS - 600}` } });
}
