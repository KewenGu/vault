"use client";
import { useState, type KeyboardEvent } from "react";
import { ActionForm } from "@/components/action-form";
import { askAction } from "./actions";

const EXAMPLES = ["我存过哪些适合周末做的菜？", "关于睡眠，我收藏的内容里有哪些具体的建议？", "之前存的那几家店，地址和人均各是多少？"];

/** 新问一个问题。回车提问，Shift + 回车换行；等模型的时候说明在做什么、要多久。 */
export function AskForm({ initial = "", max }: { initial?: string; max: number }) {
  const [text, setText] = useState(initial);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法还在选字时的回车不算
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (text.trim()) e.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <ActionForm action={askAction} className="flex flex-col gap-2">
      {(pending) => (
        <>
          <div className="flex items-end gap-2">
            <textarea
              name="question"
              value={text}
              rows={2}
              maxLength={max}
              readOnly={pending}
              autoFocus
              aria-label="想问的问题"
              placeholder="问你存过的东西，比如「我存过哪些关于理财的建议？」"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              className="field max-h-48 min-w-0 flex-1 resize-none"
            />
            <button className="btn btn-primary" disabled={pending || !text.trim()}>
              {pending ? "在找…" : "问"}
            </button>
          </div>
          {pending ? (
            <p role="status" className="rounded-md bg-accent-soft px-3.5 py-2.5 text-sm text-accent">
              正在从你的收藏里找相关的内容、写回答…一般要十几秒到一分钟，答完会自己跳过去。
            </p>
          ) : (
            !text && (
              <div className="chip-row">
                {EXAMPLES.map((q) => (
                  <button key={q} type="button" className="chip cursor-pointer" onClick={() => setText(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )
          )}
        </>
      )}
    </ActionForm>
  );
}
