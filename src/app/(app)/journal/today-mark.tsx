"use client";
import { useSyncExternalStore } from "react";
import { localDay } from "@/lib/vault/journal-doc";

const subscribe = () => () => {};

/** 月历上「今天」那一格的圈。今天是哪一天只有浏览器知道（服务器不知道看的人在哪个时区），所以服务器先不画，浏览器接手后才画。 */
export function TodayMark({ day }: { day: string }) {
  const today = useSyncExternalStore(
    subscribe,
    () => localDay() === day,
    () => false
  );
  return today ? <span className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-accent ring-inset" aria-label="今天" /> : null;
}
