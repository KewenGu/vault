"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** 有内容还在后台处理时，隔几秒让页面重新取一次数据（处理完就停）。页面在后台标签里时不刷。 */
export function AutoRefresh({ active, everyMs = 4000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
  return null;
}
