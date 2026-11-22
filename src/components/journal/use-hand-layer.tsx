"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { DECO_SCALE, HEAD, addDeco, addPoint, addStroke, anchorAt, hitsStroke, newDecoId, patchDeco, raiseDeco, rehomeDecos, rehomeStrokes, removeDeco, strokePath, toAnchored, type DecoPatch, type Tops } from "@/lib/vault/journal-deco";
import { JOURNAL_MAX, SHEET_WIDTH, type Block, type Deco, type JournalStyle, type Stroke } from "@/lib/vault/journal-doc";
import type { Pen } from "./deco-panel";
import { Hung } from "./deco-layer";
import { ERASER_REACH, MARKER, PENS, PEN_WIDTHS } from "./stickers";

/**
 * 手帐层在编辑器里的那一半：贴纸（贴、拖、转、放大缩小、拿掉）和手绘（画、擦、撤销）的状态和手势。
 *
 * 页面有三种模式，免得手势打架：
 *   write  写字（默认）：贴纸和笔画只是画在那里，碰不到；
 *   deco   贴纸：正文碰不到，贴纸能选、能拖；点空白处取消选中；
 *   draw   画笔：整页盖着一层接手势的透明层。一根手指 / 鼠标 / 手写笔画；两根手指是翻页；
 *          用过手写笔之后，手指只翻页（手掌搭在屏幕上不会画出东西）。
 *
 * 坐标：页面被 transform 缩放过，屏幕上挪了多少要除以缩放倍数（zoom）才是页面上的距离。
 * 拖和转的时候直接改那个元素的样式，松手才写回状态：整页一秒重画几十次太费。
 */

export type Mode = "write" | "deco" | "draw";

const round = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function useHandLayer(opts: {
  sheet: RefObject<HTMLElement | null>;
  /** 页面现在放大了多少倍 */
  zoom: RefObject<number>;
  /** 底下那一栏：新贴纸贴在它上面看得见的那部分页面的中间 */
  bar: RefObject<HTMLElement | null>;
  initial: { decos: Deco[]; strokes: Stroke[]; blocks: Block[] };
  style: JournalStyle;
  edited: (soon?: boolean) => void;
  notify: (text: string) => void;
}) {
  const { sheet, zoom, bar, edited, notify } = opts;
  // 数据里指着已经不在的块的（别处删过正文）：挂到页眉上，不丢
  const [decos, setDecos] = useState<Deco[]>(() => rehomeDecos(opts.initial.decos, new Set([HEAD, ...opts.initial.blocks.map((b) => b.id)]), []));
  const [strokes, setStrokes] = useState<Stroke[]>(() => rehomeStrokes(opts.initial.strokes, new Set([HEAD, ...opts.initial.blocks.map((b) => b.id)]), []));
  const [mode, setModeState] = useState<Mode>("write");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pen, setPen] = useState<Pen>({ tool: "pen", color: PENS[opts.style][0], width: "mid" });
  const now = useRef({ decos, strokes, pen });
  useEffect(() => {
    now.current = { decos, strokes, pen };
  });

  const setMode = (next: Mode) => {
    setModeState(next);
    if (next !== "deco") setSelectedId(null);
  };

  /** 每一块（含页眉）在页面里的位置。left = 正文左边离页面左边多远（坐标的 x 从正文左边算起）。 */
  const measure = (): { tops: Tops; left: number } => {
    const els = Array.from(sheet.current?.querySelectorAll<HTMLElement>("[data-block]") ?? []);
    return { tops: els.map((el) => ({ id: el.dataset.block ?? "", top: el.offsetTop, height: el.offsetHeight })), left: els[0]?.offsetLeft ?? 0 };
  };

  /** 屏幕上的一个点 → 页面上的坐标 */
  const toPage = (clientX: number, clientY: number, left: number) => {
    const r = sheet.current?.getBoundingClientRect();
    const z = zoom.current || 1;
    return r ? { x: (clientX - r.left) / z - left, y: (clientY - r.top) / z } : { x: 0, y: 0 };
  };

  /** 正文的块要变了（有的块会没）：挂在要没的块上的东西先改挂到还在的块上。在改正文之前调。 */
  const rehome = (next: Block[]) => {
    const alive = new Set([HEAD, ...next.map((b) => b.id)]);
    const { tops } = measure();
    setDecos((prev) => rehomeDecos(prev, alive, tops));
    setStrokes((prev) => rehomeStrokes(prev, alive, tops));
  };

  // ---------------------------------------------------------------- 贴纸

  /** 贴一件新的：放在页面上现在看得见的那部分的中间（稍微错开一点，连着贴几张不会叠成一摞）。 */
  const place = (kind: Deco["kind"], data: Deco["data"]) => {
    const sh = sheet.current;
    if (!sh) return;
    if (now.current.decos.length >= JOURNAL_MAX.decos) return notify(`一页最多贴 ${JOURNAL_MAX.decos} 件：这一页贴满了`);
    const r = sh.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, bar.current?.getBoundingClientRect().top ?? window.innerHeight);
    const { tops, left } = measure();
    const p = toPage(r.left + r.width / 2, bottom > top ? (top + bottom) / 2 : r.top + 80 * (zoom.current || 1), left);
    const jitter = () => (Math.random() - 0.5) * 40;
    const at = toAnchored(tops, clamp(p.x + jitter(), 30, SHEET_WIDTH - 2 * left - 30), Math.max(20, p.y + jitter()));
    const deco: Deco = { id: newDecoId(), kind, ...at, r: kind === "tape" ? -4 : 0, s: 1, data };
    setDecos((prev) => addDeco(prev, deco));
    setSelectedId(deco.id);
    edited();
  };

  const change = (id: string, patch: DecoPatch) => {
    setDecos((prev) => patchDeco(prev, id, patch));
    edited();
  };

  /** 拖：跟着手指走，松手时看它落在哪一块上，改挂过去。 */
  const grab = (e: PointerEvent<HTMLDivElement>, deco: Deco) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(deco.id);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY };
    let x = deco.x;
    let y = deco.y;
    let moved = false;
    const move = (ev: globalThis.PointerEvent) => {
      const z = zoom.current || 1;
      x = deco.x + (ev.clientX - from.x) / z;
      y = deco.y + (ev.clientY - from.y) / z;
      moved = moved || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) > 2;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (!moved) {
        el.style.left = `${deco.x}px`;
        el.style.top = `${deco.y}px`;
        return;
      }
      const { tops } = measure();
      change(deco.id, toAnchored(tops, x, (tops.find((t) => t.id === deco.anchor)?.top ?? 0) + y));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  /** 右下角的把手：绕着中心拖是转，离中心远近是放大缩小。 */
  const turn = (e: PointerEvent<HTMLSpanElement>, deco: Deco) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const el = handle.parentElement;
    if (!el) return;
    handle.setPointerCapture(e.pointerId);
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const angle0 = Math.atan2(e.clientY - cy, e.clientX - cx);
    const reach0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    let r = deco.r;
    let s = deco.s;
    const move = (ev: globalThis.PointerEvent) => {
      r = deco.r + ((Math.atan2(ev.clientY - cy, ev.clientX - cx) - angle0) * 180) / Math.PI;
      s = clamp((deco.s * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / reach0, DECO_SCALE.min, DECO_SCALE.max);
      el.style.setProperty("--r", `${r}deg`);
      el.style.setProperty("--s", String(s));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      change(deco.id, { r, s });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const remove = (id: string) => {
    setDecos((prev) => removeDeco(prev, id));
    setSelectedId(null);
    edited();
  };

  const key = (e: KeyboardEvent<HTMLDivElement>, deco: Deco) => {
    const step = e.shiftKey ? 10 : 2;
    const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (by) {
      e.preventDefault();
      setSelectedId(deco.id);
      change(deco.id, { x: deco.x + by[0], y: deco.y + by[1] });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(deco.id);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelectedId(deco.id);
    } else if (e.key === "Escape") setSelectedId(null);
  };

  const selected = decos.find((d) => d.id === selectedId) ?? null;

  // ---------------------------------------------------------------- 手绘

  const liveLayer = useRef<SVGSVGElement>(null);
  const livePath = useRef<SVGPathElement>(null);
  const ink = useRef<{ pointers: Map<number, number>; penSeen: boolean; pan: boolean; erasing: boolean; points: number[] | null; tops: Tops; left: number }>({ pointers: new Map(), penSeen: false, pan: false, erasing: false, points: null, tops: [], left: 0 });

  const showLive = (points: number[] | null) => {
    const path = livePath.current;
    if (!path) return;
    const p = now.current.pen;
    const base = PEN_WIDTHS.find((w) => w.id === p.width)?.width ?? 2.8;
    path.setAttribute("d", points ? strokePath(points) : "");
    path.setAttribute("stroke", p.color);
    path.setAttribute("stroke-width", String(p.tool === "marker" ? base * MARKER.scale : base));
    path.setAttribute("stroke-opacity", String(p.tool === "marker" ? MARKER.opacity : 1));
    if (liveLayer.current) liveLayer.current.style.left = `${ink.current.left}px`;
  };

  /** 橡皮：碰到的笔画整笔擦掉。 */
  const erase = (x: number, y: number) => {
    const { tops } = ink.current;
    const topOf = (anchor: string) => tops.find((t) => t.id === anchor)?.top ?? 0;
    const hit = now.current.strokes.filter((s) => hitsStroke(s, x, y - topOf(s.anchor), ERASER_REACH));
    if (hit.length === 0) return;
    const gone = new Set(hit.map((s) => s.id));
    setStrokes((prev) => prev.filter((s) => !gone.has(s.id)));
    edited();
  };

  const inkDown = (e: PointerEvent<HTMLDivElement>) => {
    const st = ink.current;
    if (e.pointerType === "pen") st.penSeen = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    st.pointers.set(e.pointerId, e.clientY);
    // 第二根手指落下，或者用过手写笔之后的手指：翻页，不画（画到一半的那一笔不要了）
    if (st.pointers.size > 1 || (e.pointerType === "touch" && st.penSeen)) {
      st.pan = true;
      st.points = null;
      st.erasing = false;
      showLive(null);
      return;
    }
    e.preventDefault();
    Object.assign(st, measure());
    const p = toPage(e.clientX, e.clientY, st.left);
    if (now.current.pen.tool === "eraser") {
      st.erasing = true;
      erase(p.x, p.y);
      return;
    }
    if (now.current.strokes.length >= JOURNAL_MAX.strokes) return notify(`一页最多画 ${JOURNAL_MAX.strokes} 笔：这一页画满了`);
    st.points = [round(p.x), round(p.y)];
    showLive(st.points);
  };

  const inkMove = (e: PointerEvent<HTMLDivElement>) => {
    const st = ink.current;
    const lastY = st.pointers.get(e.pointerId);
    if (lastY === undefined) return;
    if (st.pan) {
      window.scrollBy(0, (lastY - e.clientY) / st.pointers.size);
      st.pointers.set(e.pointerId, e.clientY);
      return;
    }
    // 两次画面刷新之间系统攒下的点都要，线才顺
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of events.length > 0 ? events : [e.nativeEvent]) {
      const p = toPage(ev.clientX, ev.clientY, st.left);
      if (st.erasing) erase(p.x, p.y);
      else if (st.points) addPoint(st.points, p.x, p.y);
    }
    if (st.points) showLive(st.points);
  };

  const inkUp = (e: PointerEvent<HTMLDivElement>) => {
    const st = ink.current;
    st.pointers.delete(e.pointerId);
    const points = st.points;
    st.points = null;
    st.erasing = false;
    if (st.pointers.size === 0) st.pan = false;
    showLive(null);
    if (!points || e.type === "pointercancel") return;
    // 这一笔挂在起笔处的那一块上
    const anchor = anchorAt(st.tops, points[1]);
    const top = st.tops.find((t) => t.id === anchor)?.top ?? 0;
    const p = now.current.pen;
    const base = PEN_WIDTHS.find((w) => w.id === p.width)?.width ?? 2.8;
    const stroke: Stroke = { id: newDecoId(), anchor, color: p.color, width: p.tool === "marker" ? base * MARKER.scale : base, opacity: p.tool === "marker" ? MARKER.opacity : 1, points: points.map((v, i) => (i % 2 === 1 ? round(v - top) : v)) };
    setStrokes((prev) => addStroke(prev, stroke));
    edited();
  };

  const undo = () => {
    setStrokes((prev) => prev.slice(0, -1));
    edited();
  };

  /** 挂在一块正文上的东西（放进那一块里画）。 */
  const hung = (anchor: string): ReactNode => <Hung anchor={anchor} decos={decos} strokes={strokes} active={mode === "deco"} selected={selectedId} onGrab={grab} onHandle={turn} onKey={key} />;

  /** 画笔模式下盖在整页上的那一层，和正在画的这一笔。放在页面的最后。 */
  const inkLayer: ReactNode = (
    <>
      <svg ref={liveLayer} className="jn-live" aria-hidden>
        <path ref={livePath} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {mode === "draw" && <div className="jn-ink" data-tool={pen.tool} onPointerDown={inkDown} onPointerMove={inkMove} onPointerUp={inkUp} onPointerCancel={inkUp} />}
    </>
  );

  return {
    decos,
    strokes,
    mode,
    setMode,
    selected,
    deselect: () => setSelectedId(null),
    place,
    patchSelected: (patch: DecoPatch) => selected && change(selected.id, patch),
    removeSelected: () => selected && remove(selected.id),
    raiseSelected: () => {
      if (!selected) return;
      setDecos((prev) => raiseDeco(prev, selected.id));
      edited();
    },
    pen,
    setPen,
    undo,
    rehome,
    hung,
    inkLayer,
  };
}
