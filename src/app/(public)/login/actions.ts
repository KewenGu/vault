"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAllowed } from "@/lib/auth/allowlist";
import { safeNext } from "@/lib/auth/gate";
import { createServerSupabase } from "@/lib/supabase/server";

function loginUrl(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/login?${s}` : "/login";
}

/** Supabase 的报错 → 页面上那句话的键（文案在 page.tsx，不把接口原文给用户看）。 */
function errorKey(error: { code?: string; message: string; status?: number }): string {
  if (error.code === "invalid_credentials") return "credentials";
  if (error.code === "email_not_confirmed") return "unconfirmed";
  if (error.code === "user_already_exists" || /already registered/i.test(error.message)) return "exists";
  if (error.code === "weak_password") return "weak";
  if (error.code === "signup_disabled") return "signup_closed";
  if (error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit" || error.status === 429) return "rate";
  return "network";
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));
  // 出错回登录页时 next 放进查询参数：# 片段（在 Safari 里读到的整篇网页，见 next-field.tsx）可能几十 KB，放进地址会超长，不带
  const back = { next: next === "/" ? undefined : next.split("#")[0], email };
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("登录失败:", error.code ?? "", error.message);
    redirect(loginUrl({ ...back, error: errorKey(error) }));
  }
  if (!isAllowed(data.user?.email)) {
    await supabase.auth.signOut();
    redirect(loginUrl({ error: "not_allowed" }));
  }
  redirect(next);
}

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));
  // 出错回登录页时 next 放进查询参数：# 片段（在 Safari 里读到的整篇网页，见 next-field.tsx）可能几十 KB，放进地址会超长，不带
  const back = { next: next === "/" ? undefined : next.split("#")[0], email };
  if (!isAllowed(email)) redirect(loginUrl({ ...back, error: "not_allowed" }));
  if (password.length < 8) redirect(loginUrl({ ...back, error: "weak" }));
  const supabase = await createServerSupabase();
  const h = await headers();
  const origin = h.get("origin") ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}` } });
  if (error) {
    console.error("注册失败:", error.code ?? "", error.message);
    redirect(loginUrl({ ...back, error: errorKey(error) }));
  }
  // 项目关了邮箱确认时直接有登录态；开着的要去邮箱点链接
  if (data.session) redirect(next);
  redirect(loginUrl({ ...back, notice: "confirm" }));
}

export async function signOut() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
