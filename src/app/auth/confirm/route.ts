import { NextResponse, type NextRequest } from "next/server";
import { isAllowed } from "@/lib/auth/allowlist";
import { safeNext } from "@/lib/auth/gate";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * 邮件链接回跳（注册确认）：把链接里的 `?code=` 换成登录态，再去 `next` 指定的页面。
 * 只认 PKCE 的 `code`：它要和发邮件时写进这个浏览器的 verifier cookie 配对才换得出会话，别人拼的链接在你的浏览器里
 * 换不出来。所以邮件要在发起操作的同一个浏览器里点开；换了浏览器会提示链接失效，重新操作即可。
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const toLogin = (key: string) => NextResponse.redirect(new URL(`/login?error=${key}`, request.url));
  const code = params.get("code");
  if (params.get("error_description") || !code) return toLogin("link");
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("邮件链接验证失败:", error.code ?? "", error.message);
    return toLogin("link");
  }
  if (!isAllowed(data.user?.email)) {
    await supabase.auth.signOut();
    return toLogin("not_allowed");
  }
  return NextResponse.redirect(new URL(safeNext(params.get("next")), request.url));
}
