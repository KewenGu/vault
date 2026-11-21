"use client";

import { MessageCircle, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

/**
 * 停在屏幕右下角的对话入口：平时是一个圆按钮，点开是一块浮在页面上的对话面板（手机上从底部升起来，占大半屏）。
 * 不是模态的——开着对话照样能改后面的内容。Esc 或右上角的叉收起。
 * 收起时按钮上有状态：busy = AI 在想（旁边带一句话），unread = 有没看过的回复（红点）。
 */
export function ChatDock({
  open,
  onOpenChange,
  title,
  busy,
  busyText,
  unread,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  busy: boolean;
  /** 收起时 AI 在忙，按钮旁边显示的一句话 */
  busyText: string;
  unread: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) {
    return (
      <div className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex items-center gap-2.5 sm:right-6 sm:bottom-6">
        {busy && (
          <span role="status" className="rounded-full border border-edge bg-surface px-3 py-1.5 text-xs text-accent shadow-md">
            {busyText}
          </span>
        )}
        <button
          type="button"
          aria-expanded={false}
          aria-label={unread ? `${title}（有新的回复）` : title}
          title={title}
          onClick={() => onOpenChange(true)}
          className="relative flex size-14 cursor-pointer items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-colors hover:bg-accent-deep"
        >
          <MessageCircle aria-hidden className={`size-6 ${busy ? "animate-pulse" : ""}`} />
          {unread && <span aria-hidden className="absolute top-0.5 right-0.5 size-3.5 rounded-full border-2 border-canvas bg-danger" />}
        </button>
      </div>
    );
  }
  return (
    <section
      aria-label={title}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[78dvh] flex-col rounded-t-xl border border-edge-strong bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl sm:inset-x-auto sm:right-6 sm:bottom-6 sm:h-[min(40rem,calc(100dvh-5rem))] sm:w-[26rem] sm:rounded-xl sm:pb-0"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-edge py-2 pr-2 pl-4">
        <h2 className="text-sm font-medium">{title}</h2>
        <button type="button" aria-label="收起对话" title="收起（Esc）" onClick={() => onOpenChange(false)} className="btn btn-quiet size-8 px-0">
          <X aria-hidden className="size-4" />
        </button>
      </header>
      {children}
    </section>
  );
}
