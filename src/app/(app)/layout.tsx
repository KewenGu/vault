import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import { signOut } from "../(public)/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 sm:px-6">
      <header className="flex h-14 items-center gap-5 border-b border-edge">
        <Link href="/" className="text-base font-semibold tracking-tight">
          Vault
        </Link>
        <nav className="flex gap-4 text-sm text-ink-muted" aria-label="主导航">
          <Link href="/" className="hover:text-ink">
            收藏库
          </Link>
          <Link href="/graph" className="hover:text-ink">
            图谱
          </Link>
        </nav>
        <form action={signOut} className="ml-auto flex items-center gap-3">
          <span className="hidden max-w-48 truncate text-xs text-ink-faint sm:inline">{user.email}</span>
          <button className="btn btn-quiet h-8 px-2 text-xs">退出</button>
        </form>
      </header>
      <main className="flex-1 py-6">{children}</main>
    </div>
  );
}
