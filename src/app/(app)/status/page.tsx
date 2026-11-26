import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/user";
import { setupChecks, type SetupState } from "@/lib/vault/setup";
import { gatherSetupFacts } from "@/lib/vault/setup-facts";

export const metadata: Metadata = { title: "状态" };
// 每次打开都现查（刚改完 .env.local、刚装完 ffmpeg 回来看）
export const dynamic = "force-dynamic";

const STATE_TEXT: Record<SetupState, string> = { ok: "可用", missing: "缺", optional: "没配（可选）" };
const STATE_CLASS: Record<SetupState, string> = { ok: "bg-accent-soft text-accent", missing: "bg-danger-soft text-danger", optional: "bg-sunken text-ink-muted" };

/**
 * 这台机器配齐了没有。自用阶段只有自己看；以后开放给别人用时，这一页要限制成只有管理员能看
 * （它会显示本机命令的路径）。不显示任何密钥的值。
 */
export default async function StatusPage() {
  await requireSession();
  const checks = setupChecks(await gatherSetupFacts());
  const missing = checks.filter((c) => c.state === "missing");
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight">状态</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          {missing.length === 0
            ? "都配齐了。"
            : `有 ${missing.length} 项没配齐：${missing.map((c) => c.label.replace(/（.*）/, "")).join("、")}。内容读得不完整，多半是因为这里。`}
          配好之后，在已有内容的页面上点「重新分析」就能补上。
        </p>
      </header>
      <ul className="panel divide-y divide-edge">
        {checks.map((c) => (
          <li key={c.key} className="flex flex-col gap-1.5 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-[15px] font-medium">{c.label}</h2>
              <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_CLASS[c.state]}`}>{STATE_TEXT[c.state]}</span>
              <span className="min-w-0 text-xs break-all text-ink-faint">{c.detail}</span>
            </div>
            <p className="text-sm leading-relaxed text-ink-secondary">{c.effect}</p>
            {c.state !== "ok" && <p className="text-sm leading-relaxed text-ink-muted">怎么补：{c.fix}</p>}
          </li>
        ))}
      </ul>

      <section className="flex flex-col gap-2.5" aria-label="导出">
        <h2 className="text-[15px] font-medium">导出</h2>
        <p className="text-sm leading-relaxed text-ink-secondary">
          把存在 Vault 里的东西打成一个 zip 下载下来：每条内容一个 Markdown 文件（不用 Vault 也能读，能直接放进 Obsidian 这类笔记软件），加上自己建的导图、问过的问题、日记，和每张表完整的数据（JSON）。
        </p>
        <p className="text-sm leading-relaxed text-ink-muted">
          不包含图片、视频、音频这些文件本身，只有它们的路径：文件在 Supabase 的存储桶里，太大的视频原片在这台服务器的磁盘上，要另外备份。包里的 README.md 写着这次导出了什么、没导出成的是哪些。内容多的时候要等一会儿。
        </p>
        <div>
          {/* 普通的下载链接（不是 next/link）：接口直接回一个 zip */}
          <a href="/api/v1/export" download className="btn btn-primary">
            导出整个收藏库
          </a>
        </div>
      </section>
    </div>
  );
}
