"use client";
import { useRef, useState } from "react";

/** 一行只读的文字 + 「复制」按钮。剪贴板接口不可用（非 https）或被拒时选中文字，让人自己拷。 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
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
        <input ref={ref} readOnly value={value} aria-label={label} className="field min-w-0 flex-1 font-mono text-[13px]" onFocus={(e) => e.target.select()} />
        <button type="button" className="btn" onClick={() => void copy()}>
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
