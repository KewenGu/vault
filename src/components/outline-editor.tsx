"use client";

import Link from "next/link";
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { indentRow, insertAfter, insertLines, moveSubtree, outdentRow, removeSubtree, subtreeEnd, type Row } from "@/lib/vault/map-edit";
import { MAP_MAX } from "@/lib/vault/map-nodes";
import { parseIndented } from "@/lib/vault/outline";
import { BRANCH_COLORS } from "./mind-map";

/**
 * 导图的大纲编辑器：一行一个节点，缩进就是层级（旁边的思维导图跟着变）。操作本身是纯函数（lib/vault/map-edit.ts），这里只管键盘、焦点和按钮。
 *
 * 键盘：回车 = 在下面加一行（光标在中间就把这一行拆开）；Tab / Shift+Tab = 缩进 / 反缩进（连同它下面的）；
 * 空行上按退格 = 删掉这一行；↑ ↓ = 上下换行；Alt+↑ / Alt+↓ = 把这一行连同它下面的上移 / 下移。
 * 贴进来好几行（从别处拷的大纲、笔记）= 按缩进变成好几个节点。
 * 手机上没有 Tab：上面一排按钮对「当前这一行」（最后点过的那行）做同样的事。
 */

type Props = {
  rows: Row[];
  /** 改了：新的行（调用方存下、标成没保存） */
  onChange: (rows: Row[]) => void;
  newKey: () => string;
  /** 当前这一行（最后点过的）：上面那排按钮对它操作 */
  activeKey: string | null;
  onActive: (key: string) => void;
  /** AI 刚加 / 刚改的行 */
  fresh: ReadonlySet<string>;
  /** AI 在改图的时候不让编辑（它回来会把整张图换掉） */
  locked: boolean;
};

/** 上面那排按钮里的一个：按下时不让输入框失去焦点（不然手机上键盘会收起来），做完由操作把光标放回去 */
function Tool({ label, title, enabled, onRun }: { label: string; title: string; enabled: boolean; onRun: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={!enabled} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={onRun} className="btn h-8 min-w-8 px-2 text-xs">
      {label}
    </button>
  );
}

export function OutlineEditor({ rows, onChange, newKey, activeKey, onActive, fresh, locked }: Props) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  /** 这次改完之后要把光标放到哪一行的哪个位置 */
  const focusNext = useRef<{ key: string; caret: number | "end" } | null>(null);

  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = inputs.current.get(want.key);
    if (!el) return;
    el.focus();
    const caret = want.caret === "end" ? el.value.length : want.caret;
    el.setSelectionRange(caret, caret);
  }, [rows]);

  const commit = (next: Row[], focus?: { key: string; caret: number | "end" }) => {
    if (focus) focusNext.current = focus;
    onChange(next);
  };
  const focusRow = (i: number, caret: number | "end" = "end") => {
    const row = rows[i];
    const el = row ? inputs.current.get(row.key) : undefined;
    if (!el) return;
    el.focus();
    const at = caret === "end" ? el.value.length : caret;
    el.setSelectionRange(at, at);
  };

  const activeIndex = activeKey ? rows.findIndex((r) => r.key === activeKey) : -1;
  const keep = (i: number) => ({ key: rows[i].key, caret: inputs.current.get(rows[i].key)?.selectionStart ?? ("end" as const) });

  const add = (i: number, text = "", caretRow?: { text: string }) => {
    const key = newKey();
    const res = insertAfter(caretRow ? rows.map((r, k) => (k === i ? { ...r, text: caretRow.text } : r)) : rows, i, { key, text });
    if (res) commit(res.rows, { key, caret: 0 });
  };
  const indent = (i: number) => {
    const next = indentRow(rows, i);
    if (next) commit(next, keep(i));
  };
  const outdent = (i: number) => {
    const next = outdentRow(rows, i);
    if (next) commit(next, keep(i));
  };
  // keep(i) 记的是那一行的 key：反缩进、上下挪之后它换了位置，光标还跟着它
  const move = (i: number, dir: -1 | 1) => {
    const res = moveSubtree(rows, i, dir);
    if (res) commit(res.rows, keep(i));
  };
  const remove = (i: number) => {
    const below = subtreeEnd(rows, i) - i - 1;
    if (below > 0 && !window.confirm(`连同它下面的 ${below} 条一起删掉？`)) return;
    const next = removeSubtree(rows, i);
    if (!next) return;
    const to = next[Math.min(i, next.length - 1)] ?? null;
    commit(next, to ? { key: to.key, caret: "end" } : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    // 输入法正在选字时的回车 / 方向键是给输入法的
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const el = e.currentTarget;
    if (e.key === "Enter") {
      e.preventDefault();
      const at = el.selectionStart ?? el.value.length;
      // 拆在空格边上时，两边的空格不带过去
      add(i, el.value.slice(at).trimStart(), { text: el.value.slice(0, at).trimEnd() });
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) outdent(i);
      else indent(i);
    } else if (e.key === "Backspace" && el.value === "" && subtreeEnd(rows, i) === i + 1 && rows.length > 1) {
      e.preventDefault();
      const next = removeSubtree(rows, i);
      const to = next?.[Math.max(0, i - 1)];
      if (next) commit(next, to ? { key: to.key, caret: "end" } : undefined);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      if (e.altKey) move(i, dir);
      else focusRow(i + dir, el.selectionStart ?? "end");
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/\n/.test(text.trim())) return;
    e.preventDefault();
    const lines = parseIndented(text, MAP_MAX);
    if (lines.length === 0) return;
    // 贴在一个空行上：这个空行就不要了
    const emptyHere = rows[i].text.trim() === "" && subtreeEnd(rows, i) === i + 1;
    const res = insertLines(rows, i, lines, newKey);
    const next = emptyHere ? res.rows.filter((_, k) => k !== i) : res.rows;
    const last = next[emptyHere ? res.index - 1 : res.index];
    commit(next, last ? { key: last.key, caret: "end" } : undefined);
  };

  const has = activeIndex >= 0 && !locked;
  const full = rows.length >= MAP_MAX.nodes;

  // 每一行属于第几个第一层分支：颜色跟着分支走，和思维导图里的一样
  const branchOf = rows.reduce<number[]>((acc, r) => [...acc, (acc[acc.length - 1] ?? -1) + (r.depth === 1 ? 1 : 0)], []);
  // 每一行的上一层的出处：和它一样的不再标一遍（和思维导图里一样）
  const parentItem: (string | null)[] = [];
  const trail: (string | null)[] = [];
  for (const r of rows) {
    parentItem.push(trail[r.depth - 2] ?? null);
    trail.length = r.depth - 1;
    trail.push(r.item);
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1.5 bg-canvas px-1 py-1.5">
        <Tool label="＋ 加一条" title="在当前这一行下面加一条（回车）" enabled={!locked && !full} onRun={() => add(activeIndex >= 0 ? activeIndex : rows.length - 1)} />
        <Tool label="⇥" title="缩进：变成上一行的下一层（Tab）" enabled={has && indentRow(rows, activeIndex) !== null} onRun={() => indent(activeIndex)} />
        <Tool label="⇤" title="反缩进：往上提一层（Shift+Tab）" enabled={has && outdentRow(rows, activeIndex) !== null} onRun={() => outdent(activeIndex)} />
        <Tool label="↑" title="连同它下面的上移（Alt+↑）" enabled={has && moveSubtree(rows, activeIndex, -1) !== null} onRun={() => move(activeIndex, -1)} />
        <Tool label="↓" title="连同它下面的下移（Alt+↓）" enabled={has && moveSubtree(rows, activeIndex, 1) !== null} onRun={() => move(activeIndex, 1)} />
        <Tool label="删除" title="删掉这一行，连同它下面的" enabled={has} onRun={() => remove(activeIndex)} />
        <span className="ml-auto text-xs text-ink-faint">
          {rows.length} / {MAP_MAX.nodes}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="panel px-3.5 py-6 text-center text-sm text-ink-muted">还是空的。点上面的「＋ 加一条」开始写，或者让旁边的 AI 从你的收藏里起草。</p>
      ) : (
        <ol className="panel flex flex-col py-1.5" aria-label="大纲">
          {rows.map((row, i) => {
            const color = BRANCH_COLORS[Math.max(0, branchOf[i]) % BRANCH_COLORS.length];
            const active = row.key === activeKey;
            return (
              <li
                key={row.key}
                data-row={row.key}
                className={`flex items-center gap-2 pr-2 ${active ? "bg-accent-soft/60" : ""} ${fresh.has(row.key) ? "shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
                style={{ paddingLeft: `${0.75 + (row.depth - 1) * 1.15}rem` }}
              >
                <span aria-hidden className={`shrink-0 rounded-full ${row.depth === 1 ? "size-2" : "size-1.5 opacity-70"}`} style={{ background: color }} />
                <input
                  ref={(el) => {
                    if (el) inputs.current.set(row.key, el);
                    else inputs.current.delete(row.key);
                  }}
                  value={row.text}
                  readOnly={locked}
                  maxLength={MAP_MAX.text}
                  aria-label={`第 ${i + 1} 行，第 ${row.depth} 层`}
                  placeholder={i === 0 ? "第一个分支…" : "写一点…"}
                  enterKeyHint="enter"
                  onFocus={() => onActive(row.key)}
                  onChange={(e) => onChange(rows.map((r, k) => (k === i ? { ...r, text: e.target.value } : r)))}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  onPaste={(e) => onPaste(e, i)}
                  className={`min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-faint ${row.depth === 1 ? "font-medium" : "text-ink-secondary"}`}
                />
                {row.item && row.item !== parentItem[i] && (
                  <Link href={`/items/${row.item}`} prefetch={false} title="看出处：收藏库里的那条内容" aria-label={`「${row.text}」的出处`} className="shrink-0 text-sm text-accent hover:underline">
                    ↗
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
