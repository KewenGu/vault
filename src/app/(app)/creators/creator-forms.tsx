"use client";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ActionState } from "../actions";
import { addCreatorAction, findCreatorAction, removeCreatorAction, resumeCreatorAction, stopCreatorAction, syncCreatorAction } from "./actions";

/** 「博主」页上的表单（客户端组件：按钮要有等待状态、动作的报错要显示出来）。 */

/** 可选的条数；最后一个是上限（「尽量全存」，和 creator-store.ts 的 CREATOR_MAX_POSTS 一样） */
const WANT_OPTIONS = [20, 50, 100, 300, 1000];

const usd = (n: number) => (n >= 10 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);

/** 贴一个主页的链接。 */
export function FindCreatorForm() {
  return (
    <ActionForm action={findCreatorAction} className="flex flex-col gap-2">
      {(pending) => (
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="creator-input" className="sr-only">
            博主主页的链接
          </label>
          <input id="creator-input" name="input" required placeholder="贴他主页的链接，或 App 里「分享主页 → 复制链接」得到的那段话" className="field h-10" />
          <button className="btn btn-primary h-10" disabled={pending}>
            {pending ? "在认…" : "下一步"}
          </button>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * 确认页：选存最近的多少条。perItemUsd 是这个平台上已有内容平均每条的花费（没有可参考的是 null）；
 * listUsd 是列作品每条的花费（X 是 0）。
 */
export function AddCreatorForm({ url, perItemUsd, listUsd }: { url: string; perItemUsd: number | null; listUsd: number }) {
  return (
    <ActionForm action={addCreatorAction} className="flex flex-col gap-4">
      {(pending) => (
        <>
          <input type="hidden" name="url" value={url} />
          <fieldset className="flex flex-col gap-2">
            <legend className="label mb-2">存最近的多少条</legend>
            {WANT_OPTIONS.map((n, i) => {
              const all = i === WANT_OPTIONS.length - 1;
              const cost = perItemUsd !== null ? `大约 ${usd(n * (perItemUsd + listUsd))}` : listUsd > 0 ? `列作品 ${usd(n * listUsd)}，处理另算` : "";
              return (
                <label key={n} className="panel flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm has-checked:border-accent has-checked:bg-accent-soft">
                  <input type="radio" name="want" value={n} defaultChecked={i === 0} className="accent-accent" />
                  <span className="font-medium">{all ? `尽量全存（最多 ${n} 条）` : `${n} 条`}</span>
                  <span className="ml-auto text-xs text-ink-muted">
                    {all && cost ? `${cost}（存满的话）` : cost}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={pending}>
              {pending ? "开始中…" : "开始存"}
            </button>
            <Link href="/creators" className="btn btn-quiet">
              取消
            </Link>
          </div>
        </>
      )}
    </ActionForm>
  );
}

type IdAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function IdButton({ action, id, label, busyLabel, className = "btn", confirm }: { action: IdAction; id: string; label: string; busyLabel: string; className?: string; confirm?: string }) {
  return (
    <ActionForm action={action} confirm={confirm}>
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <button className={className} disabled={pending}>
            {pending ? busyLabel : label}
          </button>
        </>
      )}
    </ActionForm>
  );
}

export function StopButton({ id }: { id: string }) {
  return <IdButton action={stopCreatorAction} id={id} label="停下" busyLabel="停下中…" />;
}

export function ResumeButton({ id, label }: { id: string; label: string }) {
  return <IdButton action={resumeCreatorAction} id={id} label={label} busyLabel="开始中…" className="btn btn-primary" />;
}

export function RemoveButton({ id }: { id: string }) {
  return <IdButton action={removeCreatorAction} id={id} label="移除这个博主" busyLabel="移除中…" className="btn btn-danger" confirm="移除这个博主和他的作品清单？已经存进收藏库的内容会留着。" />;
}

/** 再同步：重新列最近的 N 条，清单里没有的存进来。 */
export function SyncForm({ id, defaultWant, label = "同步" }: { id: string; defaultWant: number; label?: string }) {
  return (
    <ActionForm action={syncCreatorAction}>
      {(pending) => (
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
          <input type="hidden" name="id" value={id} />
          <label htmlFor="sync-want">重新列最近的</label>
          <select id="sync-want" name="want" defaultValue={WANT_OPTIONS.includes(defaultWant) ? defaultWant : WANT_OPTIONS[0]} className="field h-9 w-auto py-0">
            {WANT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </select>
          <span>，没存过的存进来</span>
          <button className="btn" disabled={pending}>
            {pending ? "开始中…" : label}
          </button>
        </div>
      )}
    </ActionForm>
  );
}
