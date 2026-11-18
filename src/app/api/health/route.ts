import { NextResponse } from "next/server";

/** 存活检查（部署时容器的健康检查用）：只说明服务起来了，不查数据库，不带任何信息。不需要登录。 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}
