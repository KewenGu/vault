"use client";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

/**
 * 有内容还在后台处理时，隔几秒让页面重新取一次数据（处理完就停）。页面在后台标签里时不刷，切回来马上刷一次。
 *
 * 上一次刷新落到页面上之后才排下一次：服务器忙着处理视频时一次刷新可能要好几秒，
 * 固定每几秒发一次的话，新的刷新会顶掉还没回来的旧刷新，结果一次都落不到页面上，处理完了页面也不变
 * （2026-11-20 在手机上遇到，后端每次查询慢一两秒就能复现）。
 */
export function AutoRefresh({ active, everyMs = 4000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  useEffect(() => {
    if (!active || refreshing) return;
    const refresh = () => startTransition(() => router.refresh());
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => (document.visibilityState === "visible" ? refresh() : schedule()), everyMs);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      refresh();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refreshing, everyMs, router]);
  return null;
}
