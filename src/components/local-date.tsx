"use client";
import { useSyncExternalStore } from "react";

/**
 * 一个时间点按看的人自己的时区显示成日期（2026-11-17）。
 * 服务器不知道浏览器在哪个时区：直接截 ISO 字符串的前十位是 UTC 的日期，在美洲晚上存的内容会显示成「明天」
 * （2026-11-18 第一次真实使用时发现）。服务器先按 UTC 出一版，浏览器接手后换成本地日期。
 */
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const subscribe = () => () => {};

export function LocalDate({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => localDay(iso),
    () => iso.slice(0, 10)
  );
  return <time dateTime={iso}>{text}</time>;
}
