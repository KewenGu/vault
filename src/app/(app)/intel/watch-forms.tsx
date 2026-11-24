"use client";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { addWatchAction, checkAllAction, checkWatchAction, editWatchAction, markSignalAction, removeWatchAction, saveSignalAction } from "./actions";

/** 情报页上的表单和按钮（提交时按钮灰掉，出错的话显示在按钮下面）。 */

const DEFAULTS = { subreddit: 50, hn: 30 } as const;
type Kind = keyof typeof DEFAULTS;

/** 加一个来源：选 Reddit 的版块或 Hacker News 的关键词，写名字，定一条分数线。 */
export function AddWatchForm() {
  const [kind, setKind] = useState<Kind>("subreddit");
  return (
    <ActionForm action={addWatchAction} className="flex flex-col gap-2">
      {(pending) => (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value === "hn" ? "hn" : "subreddit")} aria-label="来源的种类" className="field sm:w-44">
              <option value="subreddit">Reddit 的版块</option>
              <option value="hn">Hacker News 的关键词</option>
            </select>
            <input
              name="query"
              required
              maxLength={100}
              aria-label={kind === "subreddit" ? "版块名" : "关键词"}
              placeholder={kind === "subreddit" ? "版块名，比如 LocalLLaMA" : "关键词，比如 MCP（几个词 = 都要有；加引号 = 连着出现）"}
              className="field min-w-0 flex-1"
            />
            <label className="flex shrink-0 items-center gap-2 text-sm text-ink-muted">
              <span className="whitespace-nowrap">至少</span>
              {/* 换种类时换成那一种的默认线 */}
              <input key={kind} name="minScore" type="number" min={0} max={100000} defaultValue={DEFAULTS[kind]} aria-label="分数线" className="field w-20" />
              <span className="whitespace-nowrap">分</span>
            </label>
            <button className="btn btn-primary" disabled={pending}>
              {pending ? "正在看…" : "开始盯"}
            </button>
          </div>
          {kind === "subreddit" && <input name="keywords" maxLength={200} aria-label="只要带这些词的" placeholder="只要标题或开头带这些词的（空格隔开，可以不填）" className="field" />}
        </>
      )}
    </ActionForm>
  );
}

export function CheckAllButton() {
  return (
    <ActionForm action={checkAllAction}>
      {(pending) => (
        <button className="btn h-8 px-2.5 text-xs" disabled={pending}>
          {pending ? "正在看…" : "现在都看一遍"}
        </button>
      )}
    </ActionForm>
  );
}

/** 一个来源后面的那排按钮：现在看、改分数线和关键词、停 / 开、删。 */
export function WatchControls({ id, enabled, minScore, keywords, withKeywords, label }: { id: string; enabled: boolean; minScore: number; keywords: string; withKeywords: boolean; label: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-1">
        <ActionForm action={checkWatchAction}>
          {(pending) => (
            <>
              <input type="hidden" name="id" value={id} />
              <button className="btn btn-quiet h-8 px-2 text-xs" disabled={pending}>
                {pending ? "正在看…" : "现在看"}
              </button>
            </>
          )}
        </ActionForm>
        <button type="button" className="btn btn-quiet h-8 px-2 text-xs" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          改
        </button>
        <ActionForm action={editWatchAction}>
          {(pending) => (
            <>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
              <button className="btn btn-quiet h-8 px-2 text-xs" disabled={pending}>
                {enabled ? "先停" : "接着盯"}
              </button>
            </>
          )}
        </ActionForm>
        <ActionForm action={removeWatchAction} confirm={`不盯 ${label} 了？它发现的、还没存的内容会一起删掉（已经存进收藏库的不受影响）。`}>
          {(pending) => (
            <>
              <input type="hidden" name="id" value={id} />
              <button className="btn btn-danger h-8 px-2 text-xs" disabled={pending}>
                删
              </button>
            </>
          )}
        </ActionForm>
      </div>
      {editing && (
        <ActionForm action={editWatchAction} className="flex flex-col gap-2">
          {(pending) => (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input type="hidden" name="id" value={id} />
              <label className="flex shrink-0 items-center gap-2 text-sm text-ink-muted">
                <span className="whitespace-nowrap">至少</span>
                <input name="minScore" type="number" min={0} max={100000} defaultValue={minScore} aria-label="分数线" className="field w-20" />
                <span className="whitespace-nowrap">分</span>
              </label>
              {withKeywords && <input name="keywords" maxLength={200} defaultValue={keywords} aria-label="只要带这些词的" placeholder="只要带这些词的（空格隔开；空着 = 全要）" className="field min-w-0 flex-1" />}
              <button className="btn" disabled={pending}>
                {pending ? "保存中…" : "保存"}
              </button>
            </div>
          )}
        </ActionForm>
      )}
    </div>
  );
}

/** 一条发现后面的按钮：新的 → 存入 / 不要；不要的 → 放回去。 */
export function SignalButtons({ id, status }: { id: string; status: "new" | "dismissed" }) {
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {status === "new" && (
        <ActionForm action={saveSignalAction}>
          {(pending) => (
            <>
              <input type="hidden" name="id" value={id} />
              <button className="btn btn-primary h-8 px-3 text-xs" disabled={pending} title="存进收藏库：和自己贴这条链接一样，后台去读、去理解">
                {pending ? "存入中…" : "存入"}
              </button>
            </>
          )}
        </ActionForm>
      )}
      <ActionForm action={markSignalAction}>
        {(pending) => (
          <>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value={status === "new" ? "dismissed" : "new"} />
            <button className="btn btn-quiet h-8 px-2 text-xs" disabled={pending}>
              {status === "new" ? "不要" : "放回去"}
            </button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
