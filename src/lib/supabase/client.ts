import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/types";

/** 浏览器端：只用来登录态相关的事和把文件直传到存储桶（签名上传地址由服务端发）。 */
export function createClient() {
  return createBrowserClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
