"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ActionState } from "@/app/(app)/actions";
import type { MapTurnResult } from "@/app/(app)/maps/actions";
import type { Row } from "@/lib/vault/map-edit";
import { MAP_MAX, fixDepths, type MapNode } from "@/lib/vault/map-nodes";
import type { MapDetail, MapEdit, MapSource } from "@/lib/vault/map-service";
import type { ChatMessage } from "@/lib/vault/map-store";
import { ActionForm } from "./action-form";
import { LocalDate } from "./local-date";
import { MindMap } from "./mind-map";
import { OutlineEditor } from "./outline-editor";

/**
 * 导图页：自己建的一张思维导图。三块东西——
 * - 大纲（OutlineEditor）：自己写、自己改，一行一个节点；
 * - 思维导图：跟着大纲实时变，点一个节点跳到大纲里那一行；
 * - 跟 AI 对话：说一句话让它改图 / 补内容 / 回答问题。它会带上这张图挂着的收藏，并按这句话去收藏库里找相关的内容。
 *   它改完直接生效，新出现的节点标出来，最近一次改动能撤销。
 *
 * 自己改的自动保存（停手不到一秒就存）。AI 在想的时候大纲锁住：它回来会把整张图换掉，这期间改的会丢。
 * 动作（保存、对话、起草、撤销）从页面传进来：都是 server action，逻辑在 lib/vault/map-service.ts。
 */

export type MapApi = {
  save: (id: string, edit: MapEdit) => Promise<{ error: string | null }>;
  chat: (id: string, text: string, edit: Pick<MapEdit, "title" | "nodes">) => Promise<MapTurnResult>;
  draft: (id: string, edit: Pick<MapEdit, "title" | "nodes">) => Promise<MapTurnResult>;
  undo: (id: string) => Promise<MapTurnResult>;
  remove: (prev: ActionState, formData: FormData) => Promise<ActionState>;
};

const SAVE_AFTER_MS = 900;
const SUGGESTIONS = ["检查一下结构：有没有漏掉的、重复的、放错层的", "把每个分支再展开一层", "收藏里还有哪些相关的内容没放进来？"];

const toNodes = (rows: Row[]): MapNode[] => rows.map(({ depth, text, item }) => ({ depth, text, item }));

function ChatLine({ message, canUndo, onUndo, busy }: { message: ChatMessage; canUndo: boolean; onUndo: () => void; busy: boolean }) {
  if (message.role === "user") {
    return <li className="ml-8 self-end rounded-lg bg-sunken px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">{message.text}</li>;
  }
  return (
    <li className="mr-4 flex flex-col gap-1.5 text-sm leading-relaxed">
      <p className="whitespace-pre-wrap text-ink-secondary">{message.text}</p>
      {(message.changed || message.undone) && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span className={`chip h-6 ${message.undone ? "" : "chip-on"}`}>{message.undone ? "改了导图，已撤销" : "改了导图"}</span>
          {canUndo && (
            <button type="button" disabled={busy} onClick={onUndo} className="cursor-pointer rounded-sm text-accent hover:underline disabled:opacity-50">
              撤销这次修改
            </button>
          )}
        </p>
      )}
      {message.notes.length > 0 && (
        <ul className="flex list-disc flex-col gap-0.5 rounded-md bg-warning-soft py-1.5 pr-3 pl-7 text-xs text-warning">
          {message.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function MapEditor({ initial, api, autoDraft = false }: { initial: MapDetail; api: MapApi; autoDraft?: boolean }) {
  const id = initial.map.id;
  const seq = useRef(0);
  const newKey = () => `r${++seq.current}`;
  const [title, setTitle] = useState(initial.map.title);
  const [rows, setRows] = useState<Row[]>(() => initial.map.nodes.map((n, i) => ({ ...n, key: `i${i}` })));
  const [sources, setSources] = useState<MapSource[]>(initial.sources);
  const [chat, setChat] = useState<ChatMessage[]>(initial.map.chat);
  const [costUsd, setCostUsd] = useState(initial.map.costUsd);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** 整张图被换掉了几次（AI 改图、撤销）：思维导图跟着重新摆正 */
  const [layout, setLayout] = useState(0);
  const [draftText, setDraftText] = useState("");
  const [thinking, setThinking] = useState<"chat" | "draft" | "undo" | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  /** 自己改了多少次 / 存到了第几次：不相等就是有没存上的 */
  const [version, setVersion] = useState(0);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef({ title, rows, sources, version });
  useEffect(() => {
    latest.current = { title, rows, sources, version };
  });
  const chatEnd = useRef<HTMLLIElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);

  const edited = () => setVersion((v) => v + 1);

  // 自动保存：停手一会儿就存；存的过程中又改了，等这次回来再存一次（依赖里的 version 变了，effect 重跑）
  useEffect(() => {
    if (version === savedVersion || thinking) return;
    const timer = setTimeout(async () => {
      const snap = latest.current;
      const res = await api.save(id, { title: snap.title, nodes: toNodes(snap.rows), sources: snap.sources.map((s) => s.id) });
      setSaveError(res.error);
      if (!res.error) setSavedVersion(snap.version);
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [version, savedVersion, thinking, api, id]);

  // 还有没存上的改动时关页面 / 刷新：让浏览器问一句
  useEffect(() => {
    if (version === savedVersion) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [version, savedVersion]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [chat.length, thinking]);

  /** 服务器回来的整张图换上去。prevTexts 给了 = AI 改的：原来没有的节点标出来 */
  const apply = (detail: MapDetail, prevTexts: Set<string> | null) => {
    const next: Row[] = detail.map.nodes.map((n) => ({ ...n, key: newKey() }));
    setRows(next);
    setTitle(detail.map.title);
    setSources(detail.sources);
    setChat(detail.map.chat);
    setCostUsd(detail.map.costUsd);
    // 标出原来没有的节点；整张都是新的（从空白起草）就不标了，全标等于没标
    const added = prevTexts ? next.filter((r) => !prevTexts.has(r.text)) : [];
    setFresh(new Set(added.length < next.length ? added.map((r) => r.key) : []));
    setLayout((n) => n + 1);
    setActiveKey(null);
    // 这次请求带着当时的改动一起存了
    setSavedVersion(latest.current.version);
    setSaveError(null);
  };

  const run = async (kind: "chat" | "draft" | "undo", text = "") => {
    if (thinking) return;
    setThinking(kind);
    setChatError(null);
    const snap = latest.current;
    const edit = { title: snap.title, nodes: toNodes(snap.rows) };
    const prevTexts = new Set(snap.rows.map((r) => r.text));
    let res: MapTurnResult;
    try {
      res = kind === "undo" ? await api.undo(id) : kind === "draft" ? await api.draft(id, edit) : await api.chat(id, text, edit);
    } catch {
      res = { error: "没连上服务器，请稍后重试" };
    }
    setThinking(null);
    if ("error" in res) {
      setChatError(res.error);
      return;
    }
    const last = res.detail.map.chat[res.detail.map.chat.length - 1];
    apply(res.detail, kind !== "undo" && last?.role === "assistant" && last.changed ? prevTexts : null);
    if (kind === "chat") setDraftText("");
  };

  // 新建时选了「让 AI 起草」：进来就起草一次（地址里的 draft=1 用完去掉，刷新不会再来一遍）
  const drafted = useRef(false);
  useEffect(() => {
    if (!autoDraft || drafted.current) return;
    drafted.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    void run("draft");
    // 只在进页面时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = () => {
    const text = draftText.trim();
    if (text) void run("chat", text);
  };
  const onChatKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  };

  // 画图只画有字的行（刚加的空行先不上图）；图上的行号对回大纲里的行
  const visible = useMemo(() => rows.filter((r) => r.text.trim() !== ""), [rows]);
  const mapNodes = useMemo(() => fixDepths(visible.map((r) => ({ depth: r.depth, text: r.text, item: r.item, key: r.key }))), [visible]);
  const freshIds = useMemo(() => new Set(visible.flatMap((r, i) => (fresh.has(r.key) ? [i] : []))), [visible, fresh]);
  const activeId = useMemo(() => {
    const i = activeKey ? visible.findIndex((r) => r.key === activeKey) : -1;
    return i >= 0 ? i : null;
  }, [visible, activeKey]);
  const pick = (i: number) => {
    const key = visible[i]?.key;
    const el = key ? outlineRef.current?.querySelector<HTMLInputElement>(`[data-row="${key}"] input`) : null;
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const undoIndex = chat.findLastIndex((m) => m.role === "assistant" && m.before !== undefined);
  const unsaved = version !== savedVersion;
  const locked = thinking !== null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <Link href="/maps" className="hover:text-ink">
            ← 导图
          </Link>
          <span>
            建于 <LocalDate iso={initial.map.createdAt} />
          </span>
          <span role="status" className={saveError ? "text-danger" : ""}>
            {saveError ? `没保存上：${saveError}` : unsaved ? "有改动，马上保存…" : "已保存"}
          </span>
          {costUsd > 0 && <span className="text-ink-faint">对话花费约 ${costUsd.toFixed(3)}</span>}
        </div>
        <input
          value={title}
          readOnly={locked}
          maxLength={MAP_MAX.title}
          aria-label="导图的标题（中心主题）"
          placeholder="这张图的主题…"
          onChange={(e) => {
            setTitle(e.target.value);
            edited();
          }}
          className="w-full bg-transparent text-2xl leading-tight font-semibold tracking-tight outline-none placeholder:text-ink-faint"
        />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div ref={outlineRef} className="order-2 flex min-w-0 flex-col gap-6 lg:order-1">
          <section className="flex flex-col gap-1">
            <h2 className="label">大纲</h2>
            <OutlineEditor
              rows={rows}
              onChange={(next) => {
                setRows(next);
                edited();
              }}
              newKey={newKey}
              activeKey={activeKey}
              onActive={setActiveKey}
              fresh={fresh}
              locked={locked}
            />
            <p className="text-xs text-ink-faint">回车加一行，Tab / Shift+Tab 缩进和反缩进，Alt+↑↓ 挪动；贴进来好几行会按缩进变成好几个节点。</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="label">挂着的收藏</h2>
            {sources.length === 0 ? (
              <p className="text-sm text-ink-muted">还没有。AI 往图里加了来自哪条收藏的东西，那条就会挂在这里，之后每次对话都带上它。</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {sources.map((s) => (
                  <li key={s.id} className="flex items-baseline gap-2 text-sm">
                    <Link href={`/items/${s.id}`} prefetch={false} className="min-w-0 truncate text-accent hover:underline">
                      {s.title}
                    </Link>
                    {s.origin && <span className="shrink-0 text-xs text-ink-faint">{s.origin}</span>}
                    <button
                      type="button"
                      disabled={locked}
                      title="不再挂在这张图上（图里已有的节点不动）"
                      aria-label={`把「${s.title}」从这张图上拿掉`}
                      onClick={() => {
                        setSources((cur) => cur.filter((x) => x.id !== s.id));
                        edited();
                      }}
                      className="ml-auto shrink-0 cursor-pointer rounded-sm px-1 text-xs text-ink-muted hover:text-danger disabled:opacity-50"
                    >
                      拿掉
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <ActionForm action={api.remove} confirm="删掉这张导图？和 AI 的对话也一起删，不能恢复。（收藏库里的内容不受影响）">
            {(pending) => (
              <>
                <input type="hidden" name="id" value={id} />
                <button className="btn btn-danger" disabled={pending || locked}>
                  {pending ? "删除中…" : "删除这张导图"}
                </button>
              </>
            )}
          </ActionForm>
        </div>

        <div className="order-1 flex min-w-0 flex-col gap-6 lg:sticky lg:top-4 lg:order-2 lg:self-start">
          <MindMap title={title || "没起名的导图"} nodes={mapNodes} boxClassName="max-h-[44dvh] overflow-auto overscroll-contain" onPick={pick} fresh={freshIds} activeId={activeId} recenter={layout} />

          <section className="flex flex-col gap-2.5" aria-label="跟 AI 对话">
            <h2 className="label">跟 AI 对话</h2>
            {chat.length > 0 && (
              <ol className="panel flex max-h-[30dvh] flex-col gap-3 overflow-y-auto overscroll-contain p-3.5">
                {chat.map((m, i) => (
                  <ChatLine key={`${m.at}-${i}`} message={m} canUndo={i === undoIndex} onUndo={() => void run("undo")} busy={locked} />
                ))}
                <li ref={chatEnd} aria-hidden />
              </ol>
            )}
            {thinking && (
              <p role="status" className="rounded-md bg-accent-soft px-3.5 py-2.5 text-sm text-accent">
                {thinking === "undo" ? "正在撤销…" : thinking === "draft" ? "正在从你的收藏里找相关的内容、起草这张图…一般要十几秒到一分钟。" : "AI 在想…一般要十几秒到一分钟。这期间大纲先锁住。"}
              </p>
            )}
            {chatError && (
              <p role="alert" className="rounded-md bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
                {chatError}
              </p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draftText}
                rows={2}
                maxLength={2000}
                disabled={locked}
                aria-label="对 AI 说的话"
                placeholder="想怎么改这张图？比如「把第二个分支展开」「把我存的关于指数基金的内容并进来」"
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={onChatKey}
                className="field min-w-0 flex-1 resize-y"
              />
              <button type="button" className="btn btn-primary" disabled={locked || !draftText.trim()} onClick={send}>
                发送
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="chip cursor-pointer" disabled={locked} onClick={() => void run("draft")} title="按标题去收藏库里找相关的内容，照着起一张图（会改掉现在的图，可以撤销）">
                从我的收藏里起草
              </button>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip cursor-pointer" disabled={locked} onClick={() => void run("chat", s)}>
                  {s}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-faint">AI 会看到现在的图和它挂着的收藏，并按你说的话去收藏库里找相关的内容。它改完直接生效，新出现的节点会标出来，最近一次改动可以撤销。</p>
          </section>
        </div>
      </div>
    </div>
  );
}
