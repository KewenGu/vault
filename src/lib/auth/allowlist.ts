/**
 * 自用阶段用 `VAULT_ALLOWED_EMAILS`（逗号分隔）把站点限制在自己的邮箱：没列在里面的账号登录了也进不来。
 * 不设 = 任何能登录的账号都能用（开放注册与否在 Supabase 的 Auth 设置里控制）。纯函数，登录网关和服务端都用。
 */

export function allowedEmails(env: Record<string, string | undefined> = process.env): string[] | null {
  const list = (env.VAULT_ALLOWED_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export function isAllowed(email: string | undefined | null, env: Record<string, string | undefined> = process.env): boolean {
  const list = allowedEmails(env);
  return list === null || (!!email && list.includes(email.toLowerCase()));
}
