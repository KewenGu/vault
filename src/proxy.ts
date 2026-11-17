import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowed } from "@/lib/auth/allowlist";
import { gate } from "@/lib/auth/gate";
import type { Database } from "@/lib/db/types";

/** 登录网关：每个页面请求刷新一次登录态 cookie；没登录的送去登录页（规则见 lib/auth/gate.ts）。 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  // 登录了但不在邮箱名单里的，按没登录算（和页面里的判断一致，不然会在登录页和首页之间来回跳）
  const decision = gate(request.nextUrl.pathname, request.nextUrl.search, !!data.user && isAllowed(data.user.email));
  if (decision.kind === "redirect") {
    const redirected = NextResponse.redirect(new URL(decision.to, request.url));
    response.cookies.getAll().forEach((c) => redirected.cookies.set(c));
    return redirected;
  }
  return response;
}

export const config = {
  // 排除接口（自己鉴权）、.well-known（Workflow DevKit 的运行时端点）、Next 内部文件和静态文件
  matcher: ["/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
