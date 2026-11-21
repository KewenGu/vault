"use client";
import { ActionForm } from "@/components/action-form";
import { MAP_MAX } from "@/lib/vault/map-nodes";
import { createMapAction } from "./actions";

/** 新建导图：写一个主题，选「让 AI 起草」（按主题从收藏库里找内容）或「空白开始」。 */
export function NewMapForm() {
  return (
    <ActionForm action={createMapAction} className="flex flex-col gap-2">
      {(pending) => (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input name="title" maxLength={MAP_MAX.title} aria-label="新导图的主题" placeholder="主题，比如「普通人怎么开始理财」" className="field min-w-0 flex-1" />
          <div className="flex gap-2">
            <button name="mode" value="draft" className="btn btn-primary" disabled={pending} title="按这个主题去你的收藏库里找相关的内容，起草一张图">
              {pending ? "新建中…" : "让 AI 从收藏里起草"}
            </button>
            <button name="mode" value="blank" className="btn" disabled={pending}>
              空白开始
            </button>
          </div>
        </div>
      )}
    </ActionForm>
  );
}
