import Link from "next/link";
import { dayParts, monthGrid, monthLabel, shiftMonth } from "@/lib/vault/journal-doc";
import type { EntrySummary } from "@/lib/vault/journal-service";
import { openDayAction } from "./actions";
import { TodayMark } from "./today-mark";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
export const calendarHref = (month: string, day?: string) => `/journal?${new URLSearchParams({ view: "cal", month, ...(day ? { day } : {}) })}`;

/**
 * 一个月的月历（周一开头）。写过的日子：有照片的铺成这一格的底，没有的显示标题或开头几个字；只有一篇点了直接打开，
 * 有好几篇的点了在下面列出来。没写过的日子点一下就开一篇那一天的（补记）。
 */
export function JournalCalendar({ month, entries, picked }: { month: string; entries: EntrySummary[]; picked: string | null }) {
  const byDay = new Map<string, EntrySummary[]>();
  for (const e of entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  return (
    <section className="flex flex-col gap-3" aria-label={`${monthLabel(month)}的日记`}>
      <div className="flex items-center justify-between">
        <Link href={calendarHref(shiftMonth(month, -1))} className="btn btn-quiet" aria-label="上个月">
          ←
        </Link>
        <h2 className="font-medium tabular-nums">{monthLabel(month)}</h2>
        <Link href={calendarHref(shiftMonth(month, 1))} className="btn btn-quiet" aria-label="下个月">
          →
        </Link>
      </div>
      <div className="grid grid-cols-7 gap-1 sm:gap-1.5" role="grid">
        {WEEK.map((w) => (
          <span key={w} className="pb-1 text-center text-xs text-ink-faint" role="columnheader">
            {w}
          </span>
        ))}
        {monthGrid(month)
          .flat()
          .map((day, i) => {
            if (!day) return <span key={`gap-${i}`} />;
            const date = dayParts(day).date;
            const list = byDay.get(day) ?? [];
            const cell = "relative block aspect-square w-full overflow-hidden rounded-md text-left";
            if (list.length === 0) {
              return (
                <form key={day} action={openDayAction}>
                  <input type="hidden" name="day" value={day} />
                  <button className={`${cell} flex cursor-pointer items-start border border-transparent p-1.5 text-xs text-ink-faint tabular-nums transition-colors hover:border-edge-strong hover:text-ink`} title={`补记 ${dayParts(day).month} 月 ${date} 日`}>
                    {date}
                    <TodayMark day={day} />
                  </button>
                </form>
              );
            }
            const first = list[0];
            const cover = list.find((e) => e.cover)?.cover;
            return (
              <Link
                key={day}
                href={list.length === 1 ? `/journal/${first.id}` : `${calendarHref(month, day)}#day`}
                prefetch={false}
                className={`${cell} border p-1.5 transition-colors hover:border-edge-strong ${picked === day ? "border-accent" : "border-edge"} ${cover ? "" : "bg-accent-soft"}`}
                title={list.map((e) => e.title || e.excerpt || "（还没写字）").join(" / ")}
              >
                {cover && (
                  <>
                    {/* 签名地址要先确认登录再跳转，走不了 next/image 的优化 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cover} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                    <span className="absolute inset-0 bg-linear-to-b from-black/45 to-transparent to-50%" />
                  </>
                )}
                <span className={`relative text-xs font-semibold tabular-nums ${cover ? "text-white" : "text-accent"}`}>{date}</span>
                {!cover && <span className="relative mt-0.5 line-clamp-2 hidden text-[11px] leading-snug text-ink-secondary sm:block">{first.title || first.excerpt}</span>}
                {list.length > 1 && <span className={`absolute right-1 bottom-1 rounded-full px-1.5 text-[10px] leading-4 ${cover ? "bg-black/55 text-white" : "bg-accent text-on-accent"}`}>{list.length} 篇</span>}
                <TodayMark day={day} />
              </Link>
            );
          })}
      </div>
    </section>
  );
}
