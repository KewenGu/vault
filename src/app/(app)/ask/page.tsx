import type { Metadata } from "next";
import Link from "next/link";
import { LocalDate } from "@/components/local-date";
import { requireSession } from "@/lib/auth/user";
import { QUESTION_MAX, listMyAsks } from "@/lib/vault/ask-service";
import { askTitle } from "@/lib/vault/ask-store";
import { VaultError } from "@/lib/vault/errors";
import { AskForm } from "./ask-form";

export const metadata: Metadata = { title: "问" };

/** 「问 Vault」：对着收藏库问一个问题（回答带出处），下面列出问过的。`?q=` 先把问题填进框里（从首页的搜索过来），不自动提问——提问要花钱。 */
export default async function AskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, session] = await Promise.all([searchParams, requireSession()]);
  let asks;
  try {
    asks = await listMyAsks(session);
  } catch (e) {
    // 表还没建（迁移没推）：告诉他要做什么，不是整页报错
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">问</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed break-words text-warning">
          {e.message}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">问</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          问你存过的东西。它按你的问题去收藏库里找相关的内容，只根据找到的那几条回答，每句话后面标着出处，点了回到那条内容。日记不在里面。
        </p>
        <AskForm initial={typeof q === "string" ? q.slice(0, QUESTION_MAX) : ""} max={QUESTION_MAX} />
      </section>

      <section className="flex flex-col gap-3" aria-label="问过的">
        {asks.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-muted">还没问过。问过的问题和回答会留在这里，可以回来接着追问。</p>
        ) : (
          <>
            <h2 className="label">问过的</h2>
            <ul className="flex flex-col gap-2.5">
              {asks.map((a) => (
                <li key={a.id}>
                  <Link href={`/ask/${a.id}`} className="panel flex flex-col gap-1.5 px-4 py-3 transition-colors hover:border-edge-strong">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate font-medium">{askTitle(a)}</span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {a.turns > 1 ? `问了 ${a.turns} 句 · ` : ""}
                        <LocalDate iso={a.updatedAt} />
                      </span>
                    </span>
                    {a.excerpt && <span className="line-clamp-2 text-sm text-ink-muted">{a.excerpt}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
