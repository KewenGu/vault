import "server-only";
import { createClient as createSupabase } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

/**
 * service role 客户端：绕过行级安全，只在服务器代码（后台任务、读写存储桶、已经验过身份的接口）里用。
 * 用它查表时，条件里必须自己带上 user_id（或已经核对过归属的 id）。
 */
export function getServiceClient() {
  return createSupabase<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}
