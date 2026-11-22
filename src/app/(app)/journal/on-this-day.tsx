"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { dayParts, localDay } from "@/lib/vault/journal-doc";
import type { LookBack } from "@/lib/vault/journal-service";
import { lookBackAction } from "./actions";

/**
 * 「那年今日」：一个月前、半年前、往年的今天写过的日记。今天是哪一天只有浏览器知道，所以页面出来之后才去问；
 * 一篇都没有就什么都不显示。
 */
export function OnThisDay() {
  const [items, setItems] = useState<LookBack[]>([]);
  useEffect(() => {
    let gone = false;
    void lookBackAction(localDay())
      .then((res) => {
        if (!gone && "items" in res) setItems(res.items);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label="那年今日">
      <h2 className="label">那年今日</h2>
      <ul className="chip-row sm:flex-nowrap sm:overflow-x-auto">
        {items.map(({ label, entry }) => (
          <li key={entry.id} className="w-56 shrink-0">
            <Link href={`/journal/${entry.id}`} prefetch={false} className="panel flex h-full gap-2.5 p-2.5 transition-colors hover:border-edge-strong">
              {entry.cover && (
                // 签名地址要先确认登录再跳转，走不了 next/image 的优化
                // eslint-disable-next-line @next/next/no-img-element
                <img src={entry.cover} alt="" loading="lazy" className="size-14 shrink-0 rounded-md border border-edge object-cover" />
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs text-accent">
                  {label} · {dayParts(entry.day).year} 年
                </span>
                <span className="line-clamp-2 text-sm leading-snug text-ink-secondary">{entry.title || entry.excerpt || "（还没写字）"}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
