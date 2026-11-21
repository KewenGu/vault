"use client";
import { deleteAction, reprocessAction, updateMetaAction } from "@/app/(app)/actions";
import { createMapFromItemAction } from "@/app/(app)/maps/actions";
import { ActionForm } from "@/components/action-form";

/** 备注和标签：用户自己的话，随时能改。标签改过之后重新分析不再覆盖。 */
export function MetaForm({ id, note, tags }: { id: string; note: string; tags: string[] }) {
  return (
    <ActionForm action={updateMetaAction} className="flex flex-col gap-3">
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <label className="flex flex-col gap-1.5">
            <span className="label">备注</span>
            <textarea name="note" rows={2} defaultValue={note} maxLength={1000} placeholder="为什么存、打算怎么用" className="field resize-y" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label">标签</span>
            <input name="tags" defaultValue={tags.join("，")} placeholder="用逗号分开" className="field" />
          </label>
          <div>
            <button className="btn" disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ReprocessButton({ id, from, label, primary = false }: { id: string; from: "fetch" | "analyze"; label: string; primary?: boolean }) {
  return (
    <ActionForm action={reprocessAction}>
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="from" value={from} />
          <button className={`btn ${primary ? "btn-primary" : ""}`} disabled={pending}>
            {pending ? "开始中…" : label}
          </button>
        </>
      )}
    </ActionForm>
  );
}

/** 链接读不到时（被删、要登录、风控）：自己把正文贴进来，按贴的文字理解。 */
export function PasteTextForm({ id }: { id: string }) {
  return (
    <ActionForm action={reprocessAction} className="flex flex-col gap-2">
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="from" value="fetch" />
          <label className="flex flex-col gap-1.5">
            <span className="label">读不到的话，把内容贴在这里</span>
            <textarea name="text" rows={4} required placeholder="把帖子 / 文章的文字复制过来" className="field resize-y" />
          </label>
          <div>
            <button className="btn" disabled={pending}>
              {pending ? "开始中…" : "按贴的文字理解"}
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteButton({ id }: { id: string }) {
  return (
    <ActionForm action={deleteAction} confirm="删除这条内容和它转存的文件？删了不能恢复。">
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <button className="btn btn-danger" disabled={pending}>
            {pending ? "删除中…" : "删除"}
          </button>
        </>
      )}
    </ActionForm>
  );
}

/** 从这条内容新建一张自己的导图：有大纲就抄过来当起点，并把这条挂成来源（跟 AI 对话时带上）。 */
export function MakeMapButton({ id }: { id: string }) {
  return (
    <ActionForm action={createMapFromItemAction}>
      {(pending) => (
        <>
          <input type="hidden" name="itemId" value={id} />
          <button className="btn" disabled={pending} title="新建一张自己的思维导图，从这条内容开始：可以自己改，也可以跟 AI 说话让它帮着改">
            {pending ? "新建中…" : "做成导图"}
          </button>
        </>
      )}
    </ActionForm>
  );
}
