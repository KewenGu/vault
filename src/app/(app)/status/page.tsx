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
    </div>
  );
}
