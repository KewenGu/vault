import type { Metadata } from "next";
import { safeNext } from "@/lib/auth/gate";
import { signIn, signUp } from "./actions";

export const metadata: Metadata = { title: "登录" };

const ERRORS: Record<string, string> = {
  credentials: "邮箱或密码不对",
  unconfirmed: "这个邮箱还没确认：去邮箱里点确认链接",
  exists: "这个邮箱已经注册过了，直接登录",
  weak: "密码至少 8 位",
  signup_closed: "现在不开放注册",
  not_allowed: "这个站点只对指定的邮箱开放",
  rate: "操作太频繁了，过一会儿再试",
  link: "邮件里的链接已失效，请重新操作（要在发起操作的同一个浏览器里打开）",
  network: "暂时连不上登录服务，请稍后重试",
};
const NOTICES: Record<string, string> = { confirm: "确认邮件已发出：去邮箱里点链接完成注册" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; next?: string; email?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const error = sp.error ? (ERRORS[sp.error] ?? ERRORS.network) : null;
  const notice = sp.notice ? NOTICES[sp.notice] : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Vault</h1>
      <p className="mt-1 text-sm text-ink-muted">存下看到的任何内容，以后搜得到、用得上。</p>
      <form className="mt-8 flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-1.5">
          <span className="label">邮箱</span>
          <input className="field" type="email" name="email" autoComplete="email" required defaultValue={sp.email ?? ""} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">密码</span>
          <input className="field" type="password" name="password" autoComplete="current-password" required minLength={8} />
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
            {notice}
          </p>
        )}
        <div className="mt-2 flex gap-2">
          <button className="btn btn-primary flex-1" formAction={signIn}>
            登录
          </button>
          <button className="btn" formAction={signUp}>
            注册
          </button>
        </div>
      </form>
    </main>
  );
}
