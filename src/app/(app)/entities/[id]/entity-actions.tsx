"use client";
import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { LocalDate } from "@/components/local-date";
import { mergeEntityAction, moveItemsAction, removeAliasAction, renameEntityAction } from "../actions";

/** 实体页上能动手的几处：改名字和说明、去掉别名、并进另一个、把几条内容移走。逻辑在 lib/vault/entity-service.ts。 */

/** 别名一个个列出来，每个能去掉（并错了留下的叫法）。 */
export function Aliases({ id, aliases }: { id: string; aliases: string[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
      <li>也叫</li>
      {aliases.map((alias) => (
        <li key={alias}>
          <ActionForm action={removeAliasAction} confirm={`「${alias}」不是它的另一个叫法？去掉之后，以后的内容再用这个叫法，不会直接认到它。`}>
            {(pending) => (
              <span className="chip gap-1.5">
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="alias" value={alias} />
                {alias}
                <button className="cursor-pointer text-ink-faint hover:text-danger disabled:opacity-50" disabled={pending} aria-label={`去掉别名 ${alias}`} title="不是它的另一个叫法：去掉">
                  ✕
                </button>
              </span>
            )}
          </ActionForm>
        </li>
      ))}
    </ul>
  );
}

export function RenameForm({ id, name, summary }: { id: string; name: string; summary: string }) {
  return (
    <ActionForm action={renameEntityAction} className="flex flex-col gap-3">
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <label className="flex flex-col gap-1.5">
            <span className="label">名字</span>
            <input name="name" defaultValue={name} required maxLength={80} className="field" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label">说明</span>
            <textarea name="summary" rows={2} defaultValue={summary} maxLength={300} placeholder="一句话说它是什么" className="field resize-y" />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn" disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </button>
            <span className="text-xs text-ink-faint">换了名字的话，旧名字记成别名：以后的内容再用旧的叫法，还是认到它。</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function MergeForm({ id, name, listId }: { id: string; name: string; listId: string }) {
  return (
    <ActionForm action={mergeEntityAction} className="flex flex-col gap-2" confirm={`把「${name}」并进另一个？提到它的内容都会挂到那一个上，「${name}」变成那一个的别名。并了不能撤销。`}>
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <label className="flex flex-col gap-1.5">
            <span className="label">它和另一个其实是同一个：并进去</span>
            <input name="into" list={listId} required autoComplete="off" placeholder="那一个的名字" className="field" />
          </label>
          <div>
            <button className="btn" disabled={pending}>
              {pending ? "合并中…" : "并进去"}
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export type EntityItemRow = { id: string; title: string; origin: string; createdAt: string; about: string; summary: string; own: boolean };

/**
 * 提到它的内容。每条前面能勾：勾上几条，在底下写一个名字，把它们移到那个实体上（这几条说的其实是另一个东西——模型并错了）。
 * 不勾的时候就是一张普通的列表。
 */
export function EntityItems({ id, name, items, listId }: { id: string; name: string; items: EntityItemRow[]; listId: string }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (itemId: string, on: boolean) =>
    setPicked((had) => {
      const next = new Set(had);
      if (on) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  return (
    <ActionForm action={moveItemsAction} className="flex flex-col gap-3">
      {(pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <ul className="panel divide-y divide-edge">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-3.5 py-3">
                <input
                  type="checkbox"
                  name="items"
                  value={item.id}
                  checked={picked.has(item.id)}
                  disabled={pending}
                  onChange={(e) => toggle(item.id, e.target.checked)}
                  aria-label={`选中「${item.title}」`}
                  title="这条说的不是它：勾上，在下面移到别的实体"
                  className="mt-1 size-4 shrink-0 accent-accent"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {/* 不预取，原因见 (app)/layout.tsx */}
                  <Link href={`/items/${item.id}`} prefetch={false} className="text-sm leading-snug font-medium hover:text-accent">
                    {item.title}
                  </Link>
                  {item.about && <p className="text-sm leading-relaxed text-ink-secondary">在这条里：{item.about}</p>}
                  {!item.about && item.summary && <p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">{item.summary}</p>}
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                    {item.own && <span className="text-accent">自己写的</span>}
                    {!item.own && item.origin && <span>{item.origin}</span>}
                    <LocalDate iso={item.createdAt} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {picked.size > 0 && (
            <div className="flex flex-col gap-2 rounded-md bg-sunken px-3.5 py-3">
              <label className="flex flex-col gap-1.5">
                <span className="label">
                  选中的 {picked.size} 条说的不是「{name}」：移到
                </span>
                <input name="to" list={listId} required autoComplete="off" placeholder="它们说的那个东西的名字（图谱里没有的话新建一个）" className="field" />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn" disabled={pending}>
                  {pending ? "移动中…" : "移过去"}
                </button>
                <button type="button" className="btn btn-quiet" disabled={pending} onClick={() => setPicked(new Set())}>
                  不移了
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </ActionForm>
  );
}
