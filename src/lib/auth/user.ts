import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Database } from "@/lib/db/types";
import { createServerSupabase, createTokenSupabase } from "@/lib/supabase/server";
import { isAllowed } from "./allowlist";

/**
 * 谁在用。数据按用户隔离（每张表有 user_id + 行级安全），所以这里只回答两件事：这个请求是哪个用户、他能不能用这个站
 * （邮箱名单见 allowlist.ts）。
 */

export type Session = { user: User; db: SupabaseClient<Database> };

/** 当前浏览器登录的用户（验过签的，不是只读 cookie）；没登录 / 不在名单里是 null。同一次渲染里只验一次。 */
export const currentSession = cache(async (): Promise<Session | null> => {
  const db = await createServerSupabase();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user || !isAllowed(data.user.email)) return null;
  return { user: data.user, db };
});

/** 页面和 server action 用：没登录去登录页。 */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * 接口（/api/v1/*）用：认浏览器的登录态，也认 `Authorization: Bearer <Supabase 访问令牌>`（以后的手机 App、脚本）。
 * 没登录 / 不在名单里返回 null，调用方回 401。
 */
export async function apiSession(request: Request): Promise<Session | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) return currentSession();
  const db = createTokenSupabase(token);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user || !isAllowed(data.user.email)) return null;
  return { user: data.user, db };
}
