"use client";
import { useActionState, type ReactNode } from "react";
import type { ActionState } from "@/app/(app)/actions";

/**
 * 包一层表单：提交时按钮进入等待状态，动作返回的错误显示在表单下面。
 * confirm：提交前先问一句（删除这类不能撤销的操作）。children 里放字段和提交按钮（用 <SubmitButton>）。
 */
export function ActionForm({
  action,
  children,
  className,
  confirm,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: (pending: boolean) => ReactNode;
  className?: string;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children(pending)}
      {state.error && (
        <p role="alert" className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
