"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NoteResult } from "@/app/(app)/notes/actions";
import { clock } from "@/lib/media/transcript";
import { NOTE_MAX, cleanQuote, type ItemNote } from "@/lib/vault/notes";
import { LocalDate } from "./local-date";
import { SeekTime } from "./seek-time";

/**
 * 详情页的「我的划线和批注」：在这条内容上留下自己的东西。
 * - 划线：在页面上选中一段话（概括、要点、原话、原文、说的话…都行），选区旁边浮出两个按钮——「划线」直接存下这段话，
 *   「写批注」把这段话带进下面的框里，接着写自己的想法再存。从带时间的地方（要点、说的话）划的记下时间，点了跳过去。
 * - 批注：不划线也能直接在框里写一段。
 * 每条能改自己写的那段话、能删。存好后这条内容的搜索索引跟着更新（搜索、「问」找得到自己写过的话）；没更新成时下面写明。
 *
 * 能划线的范围是带 data-notes-scope 的那一块（整个详情页）；这个组件自己（data-notes-ui）不算——不能划自己的笔记。
 * 动作（加、改、删）从页面传进来：都是 server action，逻辑在 lib/vault/note-service.ts。
 */

export type NotesApi = {
  add: (itemId: string, input: { quote?: string; body?: string; at?: number | null }) => Promise<NoteResult>;
  edit: (noteId: string, body: string) => Promise<NoteResult>;
  remove: (noteId: string) => Promise<NoteResult>;
};

/** 能划线的范围（详情页最外面那一层带着这个属性）；这个组件自己带 data-notes-ui，不算在内 */
const SCOPE = "[data-notes-scope]";
const UI = "[data-notes-ui]";

type Picked = { quote: string; at: number | null };
type Floating = Picked & { x: number; y: number };

/** 现在选中的这段话能不能划：要在能划线的范围里、不在笔记这一块里、至少两个字。带时间的那一行上划的，带上时间。 */
function readSelection(): Floating | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el || !el.closest(SCOPE) || el.closest(UI) || el.closest("textarea, input")) return null;
  const quote = cleanQuote(sel.toString());
  if (Array.from(quote).length < 2) return null;
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const at = Number(start?.closest("[data-at]")?.getAttribute("data-at"));
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  // 按钮放在选区下面居中；贴着屏幕边的时候往里收，下面放不下就放到上面
  const x = Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90);
  const below = rect.bottom + 10;
  const y = below + 44 > window.innerHeight ? Math.max(rect.top - 46, 8) : below;
  return { quote, at: Number.isFinite(at) && at >= 0 ? at : null, x, y };
}

function NoteView({ note, canSeek, busy, onEdit, onRemove }: { note: ItemNote; canSeek: boolean; busy: boolean; onEdit: (body: string) => Promise<boolean>; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const box = useRef<HTMLTextAreaElement>(null);
  // 打开改的框时光标放在最后（接着写），不是开头
  useEffect(() => {
    const el = editing ? box.current : null;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  const save = async () => {
    if (await onEdit(text)) setEditing(false);
  };
  return (
    <li className="flex flex-col gap-2 px-3.5 py-3">
      {note.quote && (
        <blockquote className="border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink-secondary">
          {note.at !== null && <SeekTime at={note.at} label={clock(note.at)} enabled={canSeek} className="mr-2 font-mono text-xs text-ink-faint" />}
          {note.quote}
        </blockquote>
      )}
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea ref={box} value={text} rows={3} maxLength={NOTE_MAX.body} disabled={busy} aria-label="改这条批注" onChange={(e) => setText(e.target.value)} className="field resize-y" />
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary h-8 px-2.5 text-xs" disabled={busy} onClick={() => void save()}>
              保存
            </button>
            <button
              type="button"
              className="btn h-8 px-2.5 text-xs"
              disabled={busy}
              onClick={() => {
                setText(note.body);
                setEditing(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        note.body && <p className="text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>
      )}
      {!editing && (
        <p className="flex items-center gap-3 text-xs text-ink-faint">
          <LocalDate iso={note.createdAt} />
          <button type="button" className="cursor-pointer hover:text-ink disabled:opacity-50" disabled={busy} onClick={() => setEditing(true)}>
            {note.body ? "改" : "写批注"}
          </button>
          <button
            type="button"
            className="cursor-pointer hover:text-danger disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              if (window.confirm("删掉这条笔记？删了不能恢复。")) onRemove();
            }}
          >
            删
          </button>
        </p>
      )}
    </li>
  );
}

export function ItemNotes({ itemId, initial, unavailable, canSeek, api }: { itemId: string; initial: ItemNote[]; /** 表还没建时的那句说明：有它就不让写 */ unavailable: string | null; canSeek: boolean; api: NotesApi }) {
  const [notes, setNotes] = useState(initial);
  const [draft, setDraft] = useState("");
  /** 带进框里、等着写批注的那段划线 */
  const [picked, setPicked] = useState<Picked | null>(null);
  const [floating, setFloating] = useState<Floating | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // 选区变了、页面滚了，重新看一眼要不要浮出按钮、浮在哪
  useEffect(() => {
    if (unavailable) return;
    const update = () => setFloating(readSelection());
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  }, [unavailable]);

  /** 跑一个动作；成了换上新的笔记列表并返回 true，没成显示原因 */
  const run = async (work: () => Promise<NoteResult>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    let res: NoteResult;
    try {
      res = await work();
    } catch {
      res = { error: "没连上服务器，请稍后重试" };
    }
    setBusy(false);
    if ("error" in res) {
      setError(res.error);
      return false;
    }
    setNotes(res.saved.notes);
    setWarning(res.saved.warning);
    return true;
  };

  const highlight = async () => {
    if (!floating) return;
    const { quote, at } = floating;
    if (await run(() => api.add(itemId, { quote, at }))) window.getSelection()?.removeAllRanges();
  };
  const annotate = () => {
    if (!floating) return;
    setPicked({ quote: floating.quote, at: floating.at });
    window.getSelection()?.removeAllRanges();
    input.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    input.current?.focus({ preventScroll: true });
  };
  const save = async () => {
    const body = draft.trim();
    if (!body && !picked) return;
    if (await run(() => api.add(itemId, { quote: picked?.quote, at: picked?.at ?? null, body }))) {
      setDraft("");
      setPicked(null);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd / Ctrl + 回车保存；单按回车是换行（批注常常不止一行）
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <section className="flex flex-col gap-2.5" aria-label="我的划线和批注" data-notes-ui="">
      <h2 className="label">我的划线和批注{notes.length > 0 ? `（${notes.length}）` : ""}</h2>
      {unavailable ? (
        <p role="status" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed break-words text-warning">
          {unavailable}
        </p>
      ) : (
        <>
          {notes.length > 0 && (
            <ul className="panel divide-y divide-edge">
              {notes.map((n) => (
                <NoteView key={n.id} note={n} canSeek={canSeek} busy={busy} onEdit={(body) => run(() => api.edit(n.id, body))} onRemove={() => void run(() => api.remove(n.id))} />
              ))}
            </ul>
          )}
          {warning && (
            <p role="status" className="rounded-md bg-warning-soft px-3.5 py-2.5 text-xs leading-relaxed text-warning">
              {warning}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {picked && (
              <blockquote className="flex items-start gap-2 border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink-secondary">
                <span className="min-w-0 flex-1">
                  {picked.at !== null && <span className="mr-2 font-mono text-xs text-ink-faint">{clock(picked.at)}</span>}
                  {picked.quote}
                </span>
                <button type="button" aria-label="不带这段划线" title="不带这段划线" className="shrink-0 cursor-pointer text-xs text-ink-faint hover:text-ink" onClick={() => setPicked(null)}>
                  ✕
                </button>
              </blockquote>
            )}
            <textarea
              ref={input}
              value={draft}
              rows={2}
              maxLength={NOTE_MAX.body}
              disabled={busy}
              aria-label="写一条批注"
              placeholder={picked ? "对这段话的想法（可以不写，只存划线）" : "写下自己的想法；或者在上面选中一段话，划线"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              className="field resize-y"
            />
            <div className="flex items-center gap-3">
              <button type="button" className="btn" disabled={busy || (!draft.trim() && !picked)} onClick={() => void save()}>
                {busy ? "保存中…" : "存下来"}
              </button>
              <span className="text-xs text-ink-faint">存下来的会进搜索和「问」。</span>
            </div>
          </div>
        </>
      )}

      {floating && !unavailable && (
        <div role="toolbar" aria-label="对选中的这段话" className="fixed z-50 flex -translate-x-1/2 overflow-hidden rounded-md border border-edge-strong bg-surface text-sm shadow-lg" style={{ left: floating.x, top: floating.y }}>
          {/* 按下时不让选区丢掉（默认行为会把焦点移走、选区清空），点到时还读得到选中的话 */}
          <button type="button" disabled={busy} onPointerDown={(e) => e.preventDefault()} onClick={() => void highlight()} className="cursor-pointer px-3 py-2 text-accent hover:bg-accent-soft disabled:opacity-50">
            划线
          </button>
          <button type="button" disabled={busy} onPointerDown={(e) => e.preventDefault()} onClick={annotate} className="cursor-pointer border-l border-edge px-3 py-2 hover:bg-sunken disabled:opacity-50">
            写批注
          </button>
        </div>
      )}
    </section>
  );
}
