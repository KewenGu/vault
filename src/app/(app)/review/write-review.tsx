"use client";
import { ActionForm } from "@/components/action-form";
import { writeReviewAction } from "./actions";

/** 「让 AI 写一段回顾」：点了才调模型。要等一会儿，等的时候按钮上写着。 */
export function WriteReviewButton({ week, tz, count }: { week: string; tz: number; count: number }) {
  return (
    <ActionForm action={writeReviewAction} className="flex flex-col gap-2">
      {(pending) => (
        <>
          <input type="hidden" name="week" value={week} />
          <input type="hidden" name="tz" value={tz} />
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={pending}>
              {pending ? "正在写，要等十几秒到一分钟…" : "让 AI 写一段这一周的回顾"}
            </button>
            <span className="text-xs leading-relaxed text-ink-faint">
              把这一周存的 {count} 条和你写的话归成几条线，带出处。调一次模型，按用量计费（几美分到一两毛）；写完在「问」里，可以接着追问。
            </span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
