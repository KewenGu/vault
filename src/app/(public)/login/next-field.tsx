"use client";
import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/**
 * 登录后回到哪里（next）。没登录时打开 `/share#page=…`（快捷指令「存入 Vault」在 Safari 里分享时）会被带到登录页，
 * 浏览器把 # 片段一起带过来，但服务器看不到它：在这里接到 next 后面，登录完回确认页时网页的内容还在。
 */
export function NextField({ next }: { next: string }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  const value = hash.length > 1 && !next.includes("#") ? next + hash : next;
  return <input type="hidden" name="next" value={value} />;
}
