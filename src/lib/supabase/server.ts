import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/db/types";

/** 带着当前浏览器登录态（cookie）的客户端：行级安全按这个用户生效。 */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // 服务端组件里不能写 cookie；proxy.ts 已经负责刷新登录态，这里忽略
        }
      },
    },
  });
}

/** 带着一个访问令牌的客户端（手机 App、脚本用 `Authorization: Bearer <令牌>` 调接口时）：行级安全按令牌的用户生效。 */
export function createTokenSupabase(accessToken: string) {
  return createSupabase<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
