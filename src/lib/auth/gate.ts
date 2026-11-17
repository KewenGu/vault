/**
 * 登录网关的纯逻辑（proxy.ts 调用）：哪些路径不登录也能看、没登录时去哪、登录后 `next` 参数能跳回哪里。
 *
 * - 公开页：/login、/auth/*（邮件链接回跳）。
 * - 没登录访问别的页面：带上原路径跳 /login?next=…，登录后回到原来要看的页面
 *   （手机上「分享到 Vault」落在 /share?url=…，没登录时登录完接着存）。
 * - 已登录访问 /login：直接进收藏库。
 */

export type GateDecision = { kind: "next" } | { kind: "redirect"; to: string };

export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/auth/");
}

export function gate(pathname: string, search: string, authed: boolean): GateDecision {
  // 邮件链接落到了站点根地址（Supabase 没把 /auth/confirm 加进「允许的回跳地址」时会退回站点地址）：带着 code 转去真正处理的路由
  if (pathname === "/" && /(?:^|[?&])code=/.test(search)) return { kind: "redirect", to: `/auth/confirm${search}` };
  if (authed) return pathname === "/login" ? { kind: "redirect", to: "/" } : { kind: "next" };
  if (isPublicPath(pathname)) return { kind: "next" };
  return { kind: "redirect", to: pathname === "/" && !search ? "/login" : `/login?next=${encodeURIComponent(pathname + search)}` };
}

/** 登录 / 邮件链接后要回的页面：只接受站内路径（防开放重定向），公开页和空值都回首页。 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const value = raw.trim();
  // 只认「/ 开头」的站内路径；反斜杠和控制字符一律不要（WHATWG URL 把 \ 当 / 解析，"/\\evil" 会变成 "//evil"）
  if (!value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\\]/.test(value)) return "/";
  let url: URL;
  try {
    url = new URL(value, "http://local.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "http://local.invalid") return "/";
  const path = url.pathname + url.search + url.hash;
  if (/^\/(login|auth)(\/|\?|$)/.test(path)) return "/";
  return path;
}
