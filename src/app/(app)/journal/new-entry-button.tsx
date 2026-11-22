"use client";
import { useActionState, useRef } from "react";
import { localDay } from "@/lib/vault/journal-doc";
import { createEntryAction } from "./actions";

/** 「写一篇」：日期用浏览器这边的今天（服务器不知道看的人在哪个时区），点的时候才算。 */
export function NewEntryButton() {
  const [state, formAction, pending] = useActionState(createEntryAction, { error: null });
  const day = useRef<HTMLInputElement>(null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input ref={day} type="hidden" name="day" />
      <button
        className="btn btn-primary self-start"
        disabled={pending}
        onClick={() => {
          if (day.current) day.current.value = localDay();
        }}
      >
        {pending ? "打开中…" : "写一篇"}
      </button>
      {state.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
