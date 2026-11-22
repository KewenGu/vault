import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { cleanDay, cleanMonth } from "@/lib/vault/journal-doc";
import { listMonth, listMyEntries } from "@/lib/vault/journal-service";
import { openDayAction } from "./actions";
import { JournalCalendar, calendarHref } from "./journal-calendar";
import { JournalList } from "./journal-list";
import { NewEntryButton } from "./new-entry-button";
import { OnThisDay } from "./on-this-day";

export const metadata: Metadata = { title: "日记" };

type Props = { searchParams: Promise<{ q?: string; page?: string; view?: string; month?: string; day?: string }> };

/**
 * 日记本：写一篇；下面是「那年今日」和写过的日记——按月份往回翻的列表，或者月历。搜索找标题、正文、照片说明和录音里说过的话。
 * 月历不带月份时开服务器这边的当月（服务器按 UTC 算，月初月末那几个小时可能和你那边差一个月，点一下箭头就到）。
 */
export default async function JournalPage({ searchParams }: Props) {
  const session = await requireSession();
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const page = Math.max(0, Number(params.page) || 0);
  const calendar = params.view === "cal" && !q;
  const month = cleanMonth(params.month) ?? new Date().toISOString().slice(0, 7);
  const picked = calendar ? cleanDay(params.day) : null;
  let list;
  let monthEntries;
  try {
    if (calendar) monthEntries = await listMonth(session, month);
    else list = await listMyEntries(session, { q, page });
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
  const pickedEntries = picked ? (monthEntries ?? []).filter((e) => e.day === picked) : [];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">日记</h1>
        <p className="text-sm leading-relaxed text-ink-muted">自己写的日记：打字、放照片、录一段话（会转成文字）。每一篇可以换风格。日记不进知识图谱，也不交给 AI 读；只有录音会发给语音识别转成文字。</p>
        <NewEntryButton />
      </section>

      {!q && page === 0 && <OnThisDay />}

      <div className="flex flex-col gap-3">
        <form action="/journal" className="flex gap-2" role="search">
          <input name="q" defaultValue={q} aria-label="搜索日记" placeholder="搜日记：写过的字、照片说明、录音里说过的话" className="field min-w-0 flex-1" />
          <button className="btn">搜索</button>
          {q && (
            <Link href="/journal" className="btn btn-quiet">
              清除
            </Link>
          )}
        </form>
        {!q && (
          <div className="flex gap-1.5" role="group" aria-label="怎么看">
            <Link href="/journal" aria-current={calendar ? undefined : "page"} className={`chip ${calendar ? "" : "chip-on"}`}>
              列表
            </Link>
            <Link href={calendarHref(month)} aria-current={calendar ? "page" : undefined} className={`chip ${calendar ? "chip-on" : ""}`}>
              月历
            </Link>
          </div>
        )}
      </div>

      {calendar ? (
        <>
          <JournalCalendar month={month} entries={monthEntries ?? []} picked={picked} />
          {picked && (
            <div id="day" className="flex scroll-mt-4 flex-col gap-3">
              <JournalList entries={pickedEntries} more={false} q="" page={0} />
              <form action={openDayAction}>
                <input type="hidden" name="day" value={picked} />
                <button className="btn">这一天再写一篇</button>
              </form>
            </div>
          )}
        </>
      ) : (
        <JournalList entries={list?.entries ?? []} more={list?.more ?? false} q={q} page={page} />
      )}
    </div>
  );
}
