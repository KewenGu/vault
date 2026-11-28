"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { resurfacedAction, type ResurfacedRow } from "@/app/(app)/review/actions";
import { localDay } from "@/lib/vault/journal-doc";

/**
 * 首页上的「翻出来的」：往期的今天存的、今天从旧内容里翻到的几条。不用去找，打开收藏库就看得到。
 * 今天是哪一天只有浏览器知道，所以页面出来之后才去问；一条都没有就什么都不显示。更多的在「回顾」页。
 */
export function Resurfaced() {
  const [rows, setRows] = useState<ResurfacedRow[]>([]);
  useEffect(() => {
    let gone = false;
    void resurfacedAction(localDay(), new Date().getTimezoneOffset())
      .then((res) => {
        if (!gone) setRows(res);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  return <ResurfacedRows rows={rows} />;
}

/** 画出来的样子（单独拆出来：能对着写死的数据看）。一条都没有就什么都不显示。 */
export function ResurfacedRows({ rows }: { rows: ResurfacedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="翻出来的">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label">翻出来的</h2>
        <Link href="/review" prefetch={false} className="text-xs text-accent hover:underline">
          这一周的回顾 →
        </Link>
      </div>
      <ul className="chip-row sm:flex-nowrap sm:overflow-x-auto">
        {rows.map((item) => (
          <li key={`${item.tag}-${item.id}`} className="w-64 shrink-0">
            {/* 不预取，原因见 (app)/layout.tsx */}
            <Link href={`/items/${item.id}`} prefetch={false} className="panel flex h-full flex-col gap-1 p-3 transition-colors hover:border-edge-strong">
              <span className="text-xs text-accent">{item.tag}</span>
              <span className="line-clamp-2 text-sm leading-snug font-medium">{item.title}</span>
              {item.summary && <span className="line-clamp-2 text-xs leading-relaxed text-ink-muted">{item.summary}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
