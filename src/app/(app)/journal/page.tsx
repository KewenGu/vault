import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { listMyEntries } from "@/lib/vault/journal-service";
import { JournalList } from "./journal-list";
import { NewEntryButton } from "./new-entry-button";

export const metadata: Metadata = { title: "日记" };

type Props = { searchParams: Promise<{ q?: string; page?: string }> };

/** 日记本：写一篇，下面按月份往回翻；搜索找标题、正文、照片说明和录音里说过的话。 */
export default async function JournalPage({ searchParams }: Props) {
  const session = await requireSession();
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const page = Math.max(0, Number(params.page) || 0);
  let list;
  try {
    list = await listMyEntries(session, { q, page });
  } catch (e) {
    // 表还没建（迁移没推）：告诉他要做什么，不是整页报错
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">日记</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-warning">
          {e.message}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">日记</h1>
        <p className="text-sm leading-relaxed text-ink-muted">自己写的日记：打字、放照片、录一段话（会转成文字）。每一篇可以换风格。日记不进知识图谱，也不交给 AI 读；只有录音会发给语音识别转成文字。</p>
        <NewEntryButton />
      </section>

      <form action="/journal" className="flex gap-2" role="search">
        <input name="q" defaultValue={q} aria-label="搜索日记" placeholder="搜日记：写过的字、照片说明、录音里说过的话" className="field min-w-0 flex-1" />
        <button className="btn">搜索</button>
        {q && (
          <Link href="/journal" className="btn btn-quiet">
            清除
          </Link>
        )}
      </form>

      <JournalList entries={list.entries} more={list.more} q={q} page={page} />
    </div>
  );
}
