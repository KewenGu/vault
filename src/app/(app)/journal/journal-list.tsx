import Link from "next/link";
import { dayParts, styleLabel, weekdayLabel } from "@/lib/vault/journal-doc";
import type { EntrySummary } from "@/lib/vault/journal-service";

const monthOf = (day: string) => day.slice(0, 7);
const monthLabel = (day: string) => `${dayParts(day).year} 年 ${dayParts(day).month} 月`;

function EntryRow({ entry }: { entry: EntrySummary }) {
  const meta = [entry.mood, entry.weather, entry.photos > 0 ? `${entry.photos} 张照片` : "", entry.audios > 0 ? `${entry.audios} 段录音` : "", styleLabel(entry.style)].filter(Boolean);
  return (
    <li>
      <Link href={`/journal/${entry.id}`} className="panel flex items-stretch gap-3.5 px-3.5 py-3 transition-colors hover:border-edge-strong">
        <span className="flex w-11 shrink-0 flex-col items-center justify-center rounded-md bg-sunken py-1.5">
          <span className="text-lg leading-6 font-semibold tabular-nums">{dayParts(entry.day).date}</span>
          <span className="text-[11px] leading-4 text-ink-muted">{weekdayLabel(entry.day)}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          {entry.title && <span className="truncate font-medium">{entry.title}</span>}
          <span className={`line-clamp-2 text-sm leading-relaxed ${entry.title ? "text-ink-muted" : "text-ink-secondary"}`}>{entry.excerpt || (entry.title ? "" : "（还没写字）")}</span>
          <span className="truncate text-xs text-ink-faint">{meta.join(" · ")}</span>
        </span>
        {entry.cover && (
          // 签名地址要先确认登录再跳转，走不了 next/image 的优化
          // eslint-disable-next-line @next/next/no-img-element
          <img src={entry.cover} alt="" loading="lazy" className="size-16 shrink-0 self-center rounded-md border border-edge object-cover" />
        )}
      </Link>
    </li>
  );
}

/** 日记列表：按月份分组，日期新的在前；底下是翻页。q 不为空 = 这是搜索结果。 */
export function JournalList({ entries, more, q, page }: { entries: EntrySummary[]; more: boolean; q: string; page: number }) {
  const months: { key: string; label: string; entries: EntrySummary[] }[] = [];
  for (const entry of entries) {
    const last = months[months.length - 1];
    if (last?.key === monthOf(entry.day)) last.entries.push(entry);
    else months.push({ key: monthOf(entry.day), label: monthLabel(entry.day), entries: [entry] });
  }
  const pageHref = (n: number) => `/journal?${new URLSearchParams({ ...(q ? { q } : {}), ...(n > 0 ? { page: String(n) } : {}) })}`;
  return (
    <section className="flex flex-col gap-6" aria-label={q ? "搜索结果" : "写过的日记"}>
      {entries.length === 0 ? (
        <p className="panel px-4 py-8 text-center text-sm text-ink-muted">{q ? `没有找到写着「${q}」的日记。多个词用空格隔开，要每个词都出现才算。` : page > 0 ? "后面没有了。" : "还没有日记。点上面的「写一篇」开始。"}</p>
      ) : (
        months.map((month) => (
          <div key={month.key} className="flex flex-col gap-2.5">
            <h2 className="label">{month.label}</h2>
            <ul className="flex flex-col gap-2.5">
              {month.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </div>
        ))
      )}
      {(page > 0 || more) && (
        <nav className="flex justify-between text-sm" aria-label="翻页">
          {page > 0 ? (
            <Link href={pageHref(page - 1)} className="btn btn-quiet">
              ← 更新的
            </Link>
          ) : (
            <span />
          )}
          {more && (
            <Link href={pageHref(page + 1)} className="btn btn-quiet">
              更早的 →
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
