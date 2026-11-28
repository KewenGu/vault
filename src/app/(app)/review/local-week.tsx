"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { localDay } from "@/lib/vault/journal-doc";

/**
 * 今天是哪一天、在哪个时区，只有浏览器知道：没带这两样打开「回顾」时，页面出来之后补上再读一次。
 * week 给了就留着（从别处带着某一周的链接进来）。
 */
export function LocalWeek({ week }: { week?: string }) {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams({ today: localDay(), tz: String(new Date().getTimezoneOffset()) });
    if (week) params.set("week", week);
    router.replace(`/review?${params}`);
  }, [router, week]);
  return <p className="panel px-6 py-14 text-center text-sm text-ink-muted">正在翻这一周的东西…</p>;
}
