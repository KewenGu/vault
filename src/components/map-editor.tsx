"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ActionState } from "@/app/(app)/actions";
import type { MapTurnResult } from "@/app/(app)/maps/actions";
import type { Row } from "@/lib/vault/map-edit";
import { MAP_MAX, fixDepths, type MapNode } from "@/lib/vault/map-nodes";
import type { MapDetail, MapEdit, MapSource } from "@/lib/vault/map-service";
import type { ChatMessage } from "@/lib/vault/map-store";
import { ActionForm } from "./action-form";
import { ChatDock } from "./chat-dock";
import { MindMap } from "./mind-map";
import { OutlineEditor } from "./outline-editor";

/**
 * 导图页：自己建的一张思维导图。排成一个工作区——顶上一行是标题和状态，下面左边一栏大纲、右边一整块画布；
 * 宽屏上正好占满一屏，大纲和画布各滚各的，大纲可以收起来把地方让给图；手机上用「导图 / 大纲」切换，一次看一样。
 * - 大纲（OutlineEditor）：自己写、自己改，一行一个节点；
 * - 思维导图（画布）：跟着大纲实时变，点一个节点跳到大纲里那一行；
 * - 跟 AI 对话：右下角一个圆按钮，点开是浮在页面上的对话面板（ChatDock），开着也能接着改大纲。说一句话让它改图 / 补内容 /
 *   回答问题；它会带上这张图挂着的收藏，并按这句话去收藏库里找相关的内容。它改完直接生效，新出现的节点标出来，最近一次改动能撤销。
 *   面板收着的时候：AI 在想，按钮旁边有一句话；回复来了，按钮上有红点；出错了，面板自己打开。
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
  // 新建时选了「让 AI 起草」：面板一开始就开着，看得到它在干什么
  const [chatOpen, setChatOpen] = useState(autoDraft);
  const [unread, setUnread] = useState(false);
  /** 手机上看哪一样：空白的图先写大纲，有内容的先看图。宽屏上两样并排，这个不起作用 */
  const [tab, setTab] = useState<"map" | "outline">(initial.map.nodes.length === 0 && !autoDraft ? "outline" : "map");
  /** 宽屏上大纲那一栏开着没有 */
  const [outlineOpen, setOutlineOpen] = useState(true);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  /** 自己改了多少次 / 存到了第几次：不相等就是有没存上的 */
  const [version, setVersion] = useState(0);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef({ title, rows, sources, version, chatOpen });
  useEffect(() => {
    latest.current = { title, rows, sources, version, chatOpen };
  });
  const chatEnd = useRef<HTMLLIElement>(null);
  const outlineRef = useRef<HTMLElement>(null);

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

  const openChat = (open: boolean) => {
    setChatOpen(open);
    if (open) setUnread(false);
  };
  // 面板打开：滚到最新的一条，光标放进输入框
  useEffect(() => {
    if (!chatOpen) return;
    chatEnd.current?.scrollIntoView({ block: "nearest" });
    chatInput.current?.focus({ preventScroll: true });
  }, [chatOpen]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [chat.length, thinking, chatError]);

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
      // 面板收着的时候出错：打开它，不然不知道为什么没动静
      setChatError(res.error);
      setChatOpen(true);
      return;
    }
    if (!latest.current.chatOpen && kind !== "undo") setUnread(true);
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
    if (!key) return;
    // 大纲可能收着（宽屏）或在另一个标签里（手机）：先让它出来，等画出来了再把光标放过去
    setOutlineOpen(true);
    setTab("outline");
    requestAnimationFrame(() => {
      const el = outlineRef.current?.querySelector<HTMLInputElement>(`[data-row="${key}"] input`);
      if (!el) return;
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const undoIndex = chat.findLastIndex((m) => m.role === "assistant" && m.before !== undefined);
  const unsaved = version !== savedVersion;
  const locked = thinking !== null;

  return (
    // data-wide：这一页用更宽的版心（见 (app)/layout.tsx）。宽屏上整个工作区正好占满一屏，大纲和画布各滚各的；
    // 手机上是普通的一页（底下留出右下角对话按钮的位置）
    <div data-wide className="flex flex-col gap-3 pb-20 lg:h-[calc(100dvh-6.5rem)] lg:min-h-[32rem] lg:pb-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link href="/maps" className="btn btn-quiet h-8 shrink-0 px-2">
          ← 导图
        </Link>
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
          className="min-w-0 flex-1 basis-56 rounded-md bg-transparent px-1 text-xl leading-tight font-semibold tracking-tight outline-none placeholder:text-ink-faint focus:bg-surface"
        />
        <div className="flex shrink-0 items-center gap-3 text-xs text-ink-muted">
          <span role="status" className={saveError ? "text-danger" : ""}>
            {saveError ? `没保存上：${saveError}` : unsaved ? "有改动，马上保存…" : "已保存"}
          </span>
          {costUsd > 0 && <span className="text-ink-faint">对话约 ${costUsd.toFixed(3)}</span>}
          <ActionForm action={api.remove} confirm="删掉这张导图？和 AI 的对话也一起删，不能恢复。（收藏库里的内容不受影响）">
            {(pending) => (
              <>
                <input type="hidden" name="id" value={id} />
                <button className="btn btn-danger h-8 px-2 text-xs" disabled={pending || locked}>
                  {pending ? "删除中…" : "删除"}
                </button>
              </>
            )}
          </ActionForm>
        </div>
      </header>

      {/* 手机上一次只看一样：导图或大纲 */}
      <div role="tablist" aria-label="看导图还是大纲" className="flex rounded-lg border border-edge bg-sunken p-0.5 lg:hidden">
        {(["map", "outline"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`flex-1 cursor-pointer rounded-md py-1.5 text-sm ${tab === t ? "bg-surface font-medium shadow-sm" : "text-ink-muted"}`}
          >
            {t === "map" ? "导图" : `大纲（${rows.length}）`}
          </button>
        ))}
      </div>

      {/* grid-cols-1 = 一列、最小宽度 0：不然画布里那张比屏幕宽的图会把这一列撑到屏幕外面 */}
      <div className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${outlineOpen ? "lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]" : ""}`}>
        <aside ref={outlineRef} aria-label="大纲" className={`panel min-h-0 flex-col lg:overflow-hidden ${tab === "outline" ? "flex" : "hidden"} ${outlineOpen ? "lg:flex" : "lg:hidden"}`}>
          <div className="hidden shrink-0 items-center justify-between border-b border-edge py-1.5 pr-1.5 pl-3.5 lg:flex">
            <h2 className="label">大纲</h2>
            <button type="button" className="btn btn-quiet size-7 px-0" aria-label="收起大纲" title="收起大纲，把地方让给导图" onClick={() => setOutlineOpen(false)}>
              <PanelLeftClose aria-hidden className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overscroll-contain lg:overflow-y-auto">
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
          </div>
          <details className="shrink-0 border-t border-edge">
            <summary className="cursor-pointer px-3.5 py-2 text-xs text-ink-muted hover:text-ink">挂着的收藏（{sources.length}）</summary>
            <div className="max-h-44 overflow-y-auto px-3.5 pb-3">
              {sources.length === 0 ? (
                <p className="text-xs leading-relaxed text-ink-muted">还没有。AI 往图里加了来自哪条收藏的东西，那条就会挂在这里，之后每次对话都带上它。</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {sources.map((s) => (
                    <li key={s.id} className="flex items-baseline gap-2 text-sm">
                      <Link href={`/items/${s.id}`} prefetch={false} title={s.origin || undefined} className="min-w-0 truncate text-accent hover:underline">
                        {s.title}
                      </Link>
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
            </div>
          </details>
          <p className="hidden shrink-0 border-t border-edge px-3.5 py-1.5 text-[11px] text-ink-faint lg:block">回车加一行 · Tab / Shift+Tab 缩进 · Alt+↑↓ 挪动 · 贴进多行变成节点</p>
        </aside>

        <div className={`relative h-[calc(100dvh-14rem)] min-h-80 lg:block lg:h-auto lg:min-h-0 ${tab === "map" ? "block" : "hidden"}`}>
          <MindMap title={title || "没起名的导图"} nodes={mapNodes} fill onPick={pick} fresh={freshIds} activeId={activeId} recenter={`${layout}-${tab}-${outlineOpen}`} />
          {!outlineOpen && (
            <button type="button" className="btn absolute top-2.5 left-2.5 hidden h-8 gap-1.5 px-2.5 text-xs shadow-sm lg:inline-flex" onClick={() => setOutlineOpen(true)}>
              <PanelLeftOpen aria-hidden className="size-4" />
              大纲
            </button>
          )}
        </div>
      </div>

      <ChatDock
        open={chatOpen}
        onOpenChange={openChat}
        title="跟 AI 对话"
        busy={locked}
        busyText={thinking === "undo" ? "正在撤销…" : thinking === "draft" ? "AI 在起草…" : "AI 在想…"}
        unread={unread}
      >
        <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4">
          {chat.length === 0 && !thinking && (
            <li className="flex flex-col gap-3 text-sm leading-relaxed text-ink-muted">
              <p>说一句话，让 AI 改这张图、补内容，或者回答问题。它看得到现在的图和它挂着的收藏，并按你说的话去收藏库里找相关的内容。</p>
              <p>它改完直接生效，新出现的节点会标出来，最近一次改动可以撤销。</p>
            </li>
          )}
          {chat.map((m, i) => (
            <ChatLine key={`${m.at}-${i}`} message={m} canUndo={i === undoIndex} onUndo={() => void run("undo")} busy={locked} />
          ))}
          {thinking && (
            <li role="status" className="rounded-md bg-accent-soft px-3.5 py-2.5 text-sm text-accent">
              {thinking === "undo" ? "正在撤销…" : thinking === "draft" ? "正在从你的收藏里找相关的内容、起草这张图…一般要十几秒到一分钟。" : "AI 在想…一般要十几秒到一分钟。这期间大纲先锁住。"}
            </li>
          )}
          {chatError && (
            <li role="alert" className="rounded-md bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              {chatError}
            </li>
          )}
          <li ref={chatEnd} aria-hidden />
        </ol>
        <div className="flex shrink-0 flex-col gap-2 border-t border-edge p-3">
          {/* 建议的话排成一行横着滑，不占对话的地方 */}
          <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" className="chip cursor-pointer" disabled={locked} onClick={() => void run("draft")} title="按标题去收藏库里找相关的内容，照着起一张图（会改掉现在的图，可以撤销）">
              从我的收藏里起草
            </button>
            {SUGGESTIONS.map((sug) => (
              <button key={sug} type="button" className="chip cursor-pointer" disabled={locked} onClick={() => void run("chat", sug)}>
                {sug}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={chatInput}
              value={draftText}
              rows={2}
              maxLength={2000}
              disabled={locked}
              aria-label="对 AI 说的话"
              placeholder="想怎么改这张图？比如「把第二个分支展开」"
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={onChatKey}
              className="field max-h-40 min-w-0 flex-1 resize-none"
            />
            <button type="button" className="btn btn-primary" disabled={locked || !draftText.trim()} onClick={send}>
              发送
            </button>
          </div>
        </div>
      </ChatDock>
    </div>
  );
}
