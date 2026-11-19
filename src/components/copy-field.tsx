"use client";
import { useRef, useState } from "react";

/**
 * 只读的文字 + 「复制」按钮。剪贴板接口不可用（非 https）或被拒时选中文字，让人自己拷。
 * multiline：多行的（一段脚本），用文本框显示，换行要原样留着。
 */
export function CopyField({ value, label, multiline = false }: { value: string; label: string; multiline?: boolean }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      ref.current?.select();
      setState("selected");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {multiline ? (
          <textarea ref={ref} readOnly value={value} aria-label={label} rows={6} wrap="off" className="field min-w-0 flex-1 resize-y font-mono text-[12px] leading-snug" onFocus={(e) => e.target.select()} />
        ) : (
          <input ref={ref} readOnly value={value} aria-label={label} className="field min-w-0 flex-1 font-mono text-[13px]" onFocus={(e) => e.target.select()} />
        )}
        <button type="button" className="btn self-start" onClick={() => void copy()}>
          {state === "copied" ? "已复制" : "复制"}
        </button>
      </div>
      {state === "selected" && (
        <p role="status" className="text-xs text-ink-muted">
          没能自动复制，已经选中了，请手动拷贝。
        </p>
      )}
    </div>
  );
}
