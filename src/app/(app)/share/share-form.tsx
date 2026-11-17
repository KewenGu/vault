"use client";
import Link from "next/link";
import { saveAction } from "@/app/(app)/actions";
import { ActionForm } from "@/components/action-form";

export function ShareForm({ input, title }: { input: string; title: string }) {
  return (
    <ActionForm action={saveAction} className="flex flex-col gap-3">
      {(pending) => (
        <>
          <input type="hidden" name="then" value="open" />
          {title && <p className="text-sm font-medium">{title}</p>}
          <label className="flex flex-col gap-1.5">
            <span className="label">内容</span>
            <textarea name="input" rows={4} defaultValue={input} className="field resize-y" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label">备注</span>
            <input name="note" placeholder="为什么存（可不填）" maxLength={1000} className="field" autoFocus />
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={pending}>
              {pending ? "存入中…" : "存入"}
            </button>
            <Link href="/" className="btn btn-quiet">
              取消
            </Link>
          </div>
        </>
      )}
    </ActionForm>
  );
}
