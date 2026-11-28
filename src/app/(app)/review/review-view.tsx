import Link from "next/link";
import { LocalDate } from "@/components/local-date";
import { clock } from "@/lib/media/transcript";
import { addDays, weekOf } from "@/lib/vault/review";
import type { Review } from "@/lib/vault/review-service";
import { displayTitle, sourceLabel, type Item } from "@/lib/vault/store";
import { ENTITY_TYPE_INFO } from "@/lib/vault/taxonomy";
import { WriteReviewButton } from "./write-review";

/** 「回顾」页画出来的样子（数据由 page.tsx 读好传进来）。 */

function ItemRow({ item, tag }: { item: Item; tag?: string }) {
  // 自己写的那条，标记和来源是同一句话：只写一遍
  const origin = [sourceLabel(item), item.author].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-col gap-1 px-3.5 py-3">
      {/* 不预取，原因见 (app)/layout.tsx */}
      <Link href={`/items/${item.id}`} prefetch={false} className="text-sm leading-snug font-medium hover:text-accent">
        {displayTitle(item)}
      </Link>
      {item.summary && <p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">{item.summary}</p>}
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
        {tag && <span className="text-accent">{tag}</span>}
        {origin !== tag && <span>{origin}</span>}
        <LocalDate iso={item.createdAt} />
        {item.status !== "ready" && <span>{item.status === "failed" ? "没处理成" : "处理中"}</span>}
      </p>
    </li>
  );
}

export function ReviewView({ review, tz }: { review: Review; tz: number }) {
  const { today, week, resurfaced } = review;
  const thisWeek = weekOf(today);
  const href = (w: string) => `/review?${new URLSearchParams({ today, tz: String(tz), ...(w === thisWeek ? {} : { week: w }) })}`;
  const ready = week.byCategory.reduce((n, g) => n + g.items.length, 0);
  const wrote = week.own.length + week.notes.length;
  const empty = week.items.length === 0 && week.notes.length === 0 && week.asks.length === 0;
  const hasOld = !!resurfaced && (resurfaced.picks.length > 0 || resurfaced.lookBack.length > 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">回顾</h1>
        <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="换一周">
          <Link href={href(addDays(week.week, -7))} prefetch={false} className="btn">
            ← 上一周
          </Link>
          <span className="px-1 font-medium">
            {week.label}
            {week.week === thisWeek ? "（这一周）" : ""}
          </span>
          {week.week < thisWeek && (
            <>
              <Link href={href(addDays(week.week, 7))} prefetch={false} className="btn">
                下一周 →
              </Link>
              <Link href={href(thisWeek)} prefetch={false} className="btn btn-quiet">
                回到这一周
              </Link>
            </>
          )}
        </nav>
      </header>

      {week.gaps.length > 0 && (
        <ul role="status" className="flex list-disc flex-col gap-1 rounded-md bg-warning-soft py-3 pr-3.5 pl-8 text-sm leading-relaxed text-warning">
          {week.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}

      {hasOld && resurfaced && (
        <section className="flex flex-col gap-2.5">
          <h2 className="label">翻出来的</h2>
          <ul className="panel divide-y divide-edge">
            {resurfaced.lookBack.map(({ label, item }) => (
              <ItemRow key={`back-${item.id}`} item={item} tag={`${label}的今天存的`} />
            ))}
            {resurfaced.picks.map((item) => (
              <ItemRow key={`pick-${item.id}`} item={item} tag="今天翻到的" />
            ))}
          </ul>
          <p className="text-xs text-ink-faint">每天从这一周之前存的内容里翻几条出来，同一天翻到的是同一批。</p>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="label">{week.week === thisWeek ? "这一周" : week.label}</h2>
        {empty ? (
          <p className="panel px-6 py-10 text-center text-sm text-ink-muted">这一周没有存东西，也没有写东西。</p>
        ) : (
          <>
            <p className="text-[15px] leading-relaxed text-ink-secondary">
              存了 {week.items.length}
              {week.more ? "+" : ""} 条{ready < week.items.length ? `（${ready} 条处理好了）` : ""}
              {wrote > 0 ? `，自己写了 ${wrote} 条` : ""}
              {week.asks.length > 0 ? `，问了 ${week.asks.length} 次` : ""}。
            </p>
            {week.aiReviewId ? (
              <p>
                <Link href={`/ask/${week.aiReviewId}`} prefetch={false} className="btn btn-primary">
                  看 AI 写的这一周的回顾 →
                </Link>
              </p>
            ) : (
              ready > 0 && <WriteReviewButton week={week.week} tz={tz} count={ready} />
            )}
          </>
        )}
      </section>

      {(week.entities.length > 0 || week.tags.length > 0) && (
        <section className="flex flex-col gap-2.5">
          <h2 className="label">这一周不止一次出现的</h2>
          <ul className="flex flex-wrap gap-1.5">
            {week.entities.map((e) => (
              <li key={e.id}>
                <Link href={`/entities/${e.id}`} prefetch={false} className="chip" title={`这一周有 ${e.count} 条内容提到`}>
                  <span className="text-ink-faint">{ENTITY_TYPE_INFO[e.type].label}</span>
                  {e.name}
                  <span className="text-ink-faint">×{e.count}</span>
                </Link>
              </li>
            ))}
            {week.tags.map((t) => (
              <li key={t.tag}>
                <Link href={`/?tag=${encodeURIComponent(t.tag)}`} prefetch={false} className="chip" title={`这一周有 ${t.count} 条内容带着这个标签`}>
                  #{t.tag}
                  <span className="text-ink-faint">×{t.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {wrote > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="label">这一周我写的</h2>
          <ul className="panel divide-y divide-edge">
            {week.own.map((item) => (
              <ItemRow key={item.id} item={item} tag="自己写的" />
            ))}
            {week.notes.map(({ note, itemTitle }) => (
              <li key={note.id} className="flex flex-col gap-1.5 px-3.5 py-3">
                {note.quote && (
                  <blockquote className="border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink-secondary">
                    {note.at !== null && <span className="mr-2 font-mono text-xs text-ink-faint">{clock(note.at)}</span>}
                    {note.quote}
                  </blockquote>
                )}
                {note.body && <p className="text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>}
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                  <LocalDate iso={note.createdAt} />
                  <Link href={`/items/${note.itemId}`} prefetch={false} className="min-w-0 truncate hover:text-ink">
                    {itemTitle || "那条内容"}
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {week.byCategory.map((group) => (
        <section key={group.label} className="flex flex-col gap-2.5">
          <h2 className="label">
            {group.label}（{group.items.length}）
          </h2>
          <ul className="panel divide-y divide-edge">
            {group.items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ))}
      {week.more && <p className="text-xs text-ink-faint">这一周存的太多，只列了最近的 200 条。</p>}

      {week.asks.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="label">这一周问过的</h2>
          <ul className="panel divide-y divide-edge">
            {week.asks.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 px-3.5 py-3">
                <Link href={`/ask/${a.id}`} prefetch={false} className="text-sm leading-snug font-medium hover:text-accent">
                  {a.title || "没写问题的一次提问"}
                </Link>
                {a.excerpt && <p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">{a.excerpt}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
