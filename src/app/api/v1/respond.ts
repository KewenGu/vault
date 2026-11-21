import { NextResponse } from "next/server";
import { apiSession, type Session } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";

/**
 * /api/v1 的公共部分：鉴权（浏览器登录态或 `Authorization: Bearer <Supabase 访问令牌>`）和出错时的回包。
 * 回包形状固定：成功是数据本身，失败是 `{ error: "给用户看的一句话" }` + 对应的状态码。
 */
export async function withSession(request: Request, handler: (session: Session) => Promise<Response>): Promise<Response> {
  let session: Session | null;
  try {
    session = await apiSession(request);
  } catch (e) {
    console.error(`接口鉴权出错: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "暂时无法验证登录状态，请稍后重试" }, { status: 503 });
  }
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    return await handler(session);
  } catch (e) {
    if (e instanceof VaultError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error(`接口出错 ${new URL(request.url).pathname}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return NextResponse.json({ error: "服务器出错了，请稍后重试" }, { status: 500 });
  }
}

/** 读 JSON 请求体；不是对象的当空对象（字段各自校验）。 */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const str = (v: unknown) => (typeof v === "string" ? v : "");
