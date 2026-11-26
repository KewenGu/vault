import type { Metadata } from "next";
import Link from "next/link";
import { LocalDate } from "@/components/local-date";
import { requireSession } from "@/lib/auth/user";
import { clock } from "@/lib/media/transcript";
import { VaultError } from "@/lib/vault/errors";
import { listMyNotes } from "@/lib/vault/note-service";
import { NOTES_LIST_MAX } from "@/lib/vault/note-store";

export const metadata: Metadata = { title: "笔记" };

/**
 * 「笔记」页：在各条内容上划的线、写的批注汇在一起，新写的在前；能按字面搜。
 * 这里只看，点一条回到它挂着的那条内容去改、去删、接着写。
 */
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q: rawQ }, session] = await Promise.all([searchParams, requireSession()]);
  const q = typeof rawQ === "string" ? rawQ.trim() : "";
  let result;
  try {
    result = await listMyNotes(session, { q });
  } catch (e) {
    // 表还没建（迁移没推）：告诉他要做什么，不是整页报错
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">笔记</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed break-words text-warning">
          {e.message}
        </p>
      </div>
    );
  }
  const { notes, more } = result;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">笔记</h1>
        <p className="text-sm leading-relaxed text-ink-muted">你在各条内容上划的线、写的批注。要划线、写批注：打开一条内容，选中一段话，或者在「我的划线和批注」里直接写。
          <Link href="/?from=own" prefetch={false} className="ml-1 text-accent hover:underline">
            自己写的整条内容在收藏库里 →
          </Link>
        </p>
        <form action="/notes" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            在笔记里找
          </label>
          <input id="q" name="q" type="search" defaultValue={q} placeholder="在划的话和写的话里找…" className="field h-10" />
          <button className="btn h-10">找</button>
        </form>
      </header>

      <section aria-label="笔记" className="flex flex-col gap-3">
        <p className="flex items-baseline justify-between text-sm text-ink-muted">
          <span>
            {q ? `找到 ${notes.length} 条` : `共 ${notes.length} 条`}
            {more ? `以上，只列了最近的 ${NOTES_LIST_MAX} 条${q ? "" : "：更早的用上面的框找"}` : ""}
            {q ? "（只按字面找）" : ""}
          </span>
          {q && (
            <Link href="/notes" className="text-accent hover:underline">
              看全部
            </Link>
          )}
        </p>
        {notes.length === 0 ? (
          <p className="panel px-6 py-12 text-center text-sm leading-relaxed text-ink-muted">{q ? "没有符合的笔记。换个词试试。" : "还没有笔记。打开收藏库里的一条内容，选中一段话划线，或者写下自己的想法。"}</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {notes.map(({ note, item }) => (
              <li key={note.id} className="panel flex flex-col gap-2 px-4 py-3">
                {note.quote && (
                  <blockquote className="border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink-secondary">
                    {note.at !== null && <span className="mr-2 font-mono text-xs text-ink-faint">{clock(note.at)}</span>}
                    {note.quote}
                  </blockquote>
                )}
                {note.body && <p className="text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>}
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-ink-faint">
                  <LocalDate iso={note.createdAt} />
                  {item ? (
                    // 不预取：一页上百条（原因见 (app)/layout.tsx）
                    <Link href={`/items/${item.id}`} prefetch={false} className="min-w-0 truncate text-accent hover:underline">
                      {item.title}
                    </Link>
                  ) : (
                    <span>它挂着的那条内容不在了</span>
                  )}
                  {item?.origin && <span className="shrink-0">{item.origin}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
