import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import { signOut } from "../(public)/login/actions";

/**
 * 顶栏的链接不预取：处理中的页面每隔几秒刷新一次，每次刷新都会把这几页重新预取一遍（「状态」页还要起 ffmpeg、扫磁盘），
 * 正好压在处理视频的那台机器上。代价是点进这几页时慢一点。
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  return (
    // 页面里有 data-wide 的（导图页的工作区）用更宽的版心，顶栏跟着一起宽，左右对得齐
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 has-[[data-wide]]:max-w-[112rem] sm:px-6">
      <header className="flex h-14 items-center gap-5 border-b border-edge">
        <Link href="/" prefetch={false} className="shrink-0 text-base font-semibold tracking-tight">
          Vault
        </Link>
        {/* 链接不折行；手机上放不下时这一排横着滑（七个链接在 390 宽的屏上会各自折成两行） */}
        <nav className="flex min-w-0 gap-4 overflow-x-auto text-sm whitespace-nowrap text-ink-muted [scrollbar-width:none]" aria-label="主导航">
          <Link href="/" prefetch={false} className="hover:text-ink">
            收藏库
          </Link>
          <Link href="/journal" prefetch={false} className="hover:text-ink">
            日记
          </Link>
          <Link href="/maps" prefetch={false} className="hover:text-ink">
            导图
          </Link>
          <Link href="/intel" prefetch={false} className="hover:text-ink">
            情报
          </Link>
          <Link href="/graph" prefetch={false} className="hover:text-ink">
            图谱
          </Link>
          <Link href="/status" prefetch={false} className="hover:text-ink">
            状态
          </Link>
          <Link href="/mobile" prefetch={false} className="hover:text-ink">
            手机
          </Link>
        </nav>
        <form action={signOut} className="ml-auto flex shrink-0 items-center gap-3">
          <span className="hidden max-w-48 truncate text-xs text-ink-faint sm:inline">{user.email}</span>
          <button className="btn btn-quiet h-8 px-2 text-xs">退出</button>
        </form>
      </header>
      <main className="flex-1 py-6">{children}</main>
    </div>
  );
}
