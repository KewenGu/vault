"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { clock } from "@/lib/media/transcript";
import { buildOutlineTree, outlineToText, type OutlineLine, type OutlineTreeNode } from "@/lib/vault/outline";
import { seekPlayer } from "./seek-time";

/**
 * 思维导图：中心主题（标题）在左，分支往右展开。详情页画一条内容的大纲（理解时产出的，lib/vault/outline.ts），
 * 导图页画自己建的那张（lib/vault/map-nodes.ts，节点可以带出处、点了回到大纲里那一行、AI 刚改的标出来）。
 *
 * - 排版交给浏览器：节点是嵌套的列表（读屏软件读到的就是一份大纲），每个节点一行「自己 + 右边一列子节点」，
 *   字多了自己换行。连线是盖在上面的一层 SVG，排好之后量出每个节点的位置再画；大小变了（折叠、换行、字体加载完）重画。
 * - 有下一层的节点右边有个小圆点，点了收起 / 展开。节点多（超过 36 个）时一开始只展开到第二层，免得一上来铺满几屏。
 * - 视频 / 音频的节点带时间，点了跳到那一刻。
 * - 窄屏（手机竖着拿）上中心主题放在上面、分支从它下面往右长，节点也窄一些：一屏里能看到两层，更深的横向滑。
 * - 用鼠标可以按住拖着看（PanBox）；触屏上是原生的滑动。
 * - 页面里只横向滚动（不套一个上下滚的框，手机上会卡住页面的滚动）；「全屏」里两个方向都能滚。
 */

/** 第一层分支的颜色（连线和分支的底色），和知识图谱的类型色是同一组：亮暗两套底色上都看得清的中等明度 */
export const BRANCH_COLORS = ["#3f8f6b", "#4f7cac", "#c2703d", "#8a6fb0", "#b8893a", "#b05a70", "#5d8f93"];
/** 节点超过这么多，一开始只展开到第二层 */
const EXPAND_ALL_UNDER = 36;
const SVG_NS = "http://www.w3.org/2000/svg";
const ROOT = "root";
/** 窄屏上从中心主题往下走的那根线：离它左边多远、拐弯的半径 */
const TRUNK_X = 12;
const ELBOW = 8;

function walk(tree: OutlineTreeNode[], visit: (n: OutlineTreeNode) => void) {
  for (const n of tree) {
    visit(n);
    walk(n.children, visit);
  }
}

/** 有下一层的节点里，层级 ≥ fromDepth 的那些的 key */
function parentsFrom(tree: OutlineTreeNode[], fromDepth: number): Set<string> {
  const keys = new Set<string>();
  walk(tree, (n) => {
    if (n.children.length > 0 && n.depth >= fromDepth) keys.add(n.key);
  });
  return keys;
}

function countDescendants(node: OutlineTreeNode): number {
  let n = 0;
  walk(node.children, () => n++);
  return n;
}

type CanvasProps = {
  title: string;
  tree: OutlineTreeNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** null = 这条内容没有能跳的播放器，时间只是文字 */
  onSeek: ((at: number) => void) | null;
  /** 点了一个节点的字（给的是行号）：导图页用它跳到大纲里那一行 */
  onPick?: (id: number) => void;
  /** 要标出来的节点的行号（AI 刚加 / 刚改的）：虚线框 */
  fresh?: ReadonlySet<number>;
  /** 大纲里光标所在的那一行：实线框 */
  activeId?: number | null;
};

type BranchProps = Omit<CanvasProps, "title" | "tree"> & {
  node: OutlineTreeNode;
  parent: string;
  /** 上一层节点的出处：和它一样的不再标一遍（AI 起草的图常常整支都来自同一条内容，每个节点都挂一个「↗」没法看） */
  parentItem: string | null;
  color: string;
};

function Branch({ node, parent, parentItem, color, collapsed, onToggle, onSeek, onPick, fresh, activeId }: BranchProps) {
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !collapsed.has(node.key);
  const top = node.depth === 1;
  const isFresh = fresh?.has(node.id) ?? false;
  return (
    <li className="flex items-center">
      <div data-node={node.id} data-parent={parent} data-color={color} className="flex shrink-0 items-center gap-0.5">
        <div
          // 不做成按钮：按住节点的字要能拖着挪图（PanBox 不把按钮当拖的起点）；键盘上直接用大纲
          onClick={onPick ? () => onPick(node.id) : undefined}
          title={onPick ? "在大纲里找到这一行" : undefined}
          className={`${
            top
              ? "max-w-[8.5em] rounded-md border px-2.5 py-1.5 text-[13px] leading-snug font-medium sm:max-w-[13em]"
              : "max-w-[11em] rounded-sm px-1.5 py-0.5 text-[13px] leading-snug text-ink-secondary sm:max-w-[17em]"
          } ${node.id === activeId ? "outline-2 outline-offset-1 outline-accent" : isFresh ? "outline-2 outline-offset-1 outline-accent/60 outline-dashed" : ""}`}
          style={top ? { borderColor: color, background: `color-mix(in srgb, ${color} 13%, transparent)` } : undefined}
        >
          {node.at !== null &&
            (onSeek ? (
              <button type="button" title="跳到这一刻" onClick={() => onSeek(node.at!)} className="mr-1.5 cursor-pointer rounded-sm font-mono text-[11px] text-accent hover:underline">
                {clock(node.at)}
              </button>
            ) : (
              <span className="mr-1.5 font-mono text-[11px] text-ink-faint">{clock(node.at)}</span>
            ))}
          {node.text}
          {node.item && node.item !== parentItem && (
            <Link href={`/items/${node.item}`} prefetch={false} title="看出处：收藏库里的那条内容" aria-label={`「${node.text}」的出处`} className="ml-1 text-accent hover:underline">
              ↗
            </Link>
          )}
        </div>
        {hasChildren && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `收起「${node.text}」下面的 ${node.children.length} 项` : `展开「${node.text}」下面的 ${node.children.length} 项`}
            onClick={() => onToggle(node.key)}
            // 看得见的只是一个小圆点；before 把能点的范围撑大到手指点得中
            className="relative flex h-5 min-w-5 cursor-pointer items-center justify-center before:absolute before:-inset-1.5"
          >
            {open ? (
              <span className="size-2 rounded-full border bg-surface" style={{ borderColor: color }} />
            ) : (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white" style={{ background: color }}>
                {countDescendants(node)}
              </span>
            )}
          </button>
        )}
      </div>
      {open && (
        <ul className="flex flex-col gap-1.5 pl-6 sm:pl-9">
          {node.children.map((c) => (
            <Branch key={c.key} node={c} parent={String(node.id)} parentItem={node.item} color={color} collapsed={collapsed} onToggle={onToggle} onSeek={onSeek} onPick={onPick} fresh={fresh} activeId={activeId} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Canvas({ title, tree, collapsed, onToggle, onSeek, onPick, fresh, activeId }: CanvasProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // 连线：每个节点从上一层的右边中点，弯到自己的左边中点；窄屏上第一层在中心主题的下面，从它的左下角往下再拐过去。
  // 直接改 SVG，不走状态（量位置本来就得等排版完）
  useLayoutEffect(() => {
    const box = boxRef.current;
    const svg = svgRef.current;
    if (!box || !svg) return;
    const draw = () => {
      const base = box.getBoundingClientRect();
      const byId = new Map<string, HTMLElement>();
      box.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => byId.set(el.dataset.node ?? "", el));
      const paths: SVGPathElement[] = [];
      for (const el of byId.values()) {
        const from = el.dataset.parent ? byId.get(el.dataset.parent) : undefined;
        if (!from) continue;
        const a = from.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        // 排在上一层的下面（窄屏的第一层），而不是右边
        const below = b.left < a.right;
        const x1 = (below ? a.left + TRUNK_X : a.right) - base.left;
        const y1 = (below ? a.bottom : a.top + a.height / 2) - base.top;
        const x2 = b.left - base.left;
        const y2 = b.top + b.height / 2 - base.top;
        const mid = (x1 + x2) / 2;
        const f = (n: number) => n.toFixed(1);
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", below ? `M${f(x1)},${f(y1)} L${f(x1)},${f(y2 - ELBOW)} Q${f(x1)},${f(y2)} ${f(x1 + ELBOW)},${f(y2)} L${f(x2)},${f(y2)}` : `M${f(x1)},${f(y1)} C${f(mid)},${f(y1)} ${f(mid)},${f(y2)} ${f(x2)},${f(y2)}`);
        path.setAttribute("stroke", el.dataset.color ?? "currentColor");
        paths.push(path);
      }
      svg.replaceChildren(...paths);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(box);
    return () => observer.disconnect();
  }, [tree, collapsed]);

  return (
    <div ref={boxRef} className="relative w-max min-w-full p-4 sm:p-5">
      <svg ref={svgRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" fill="none" strokeWidth={1.5} strokeLinecap="round" />
      <div className="relative flex flex-col items-start sm:flex-row sm:items-center">
        <div data-node={ROOT} className="max-w-[20em] shrink-0 rounded-lg bg-accent px-3 py-2 text-sm leading-snug font-semibold text-on-accent sm:max-w-[13em]">
          {title}
        </div>
        <ul className="flex flex-col gap-3 pt-3 pl-7 sm:pt-0 sm:pl-10">
          {tree.map((n, i) => (
            <Branch key={n.key} node={n} parent={ROOT} parentItem={null} color={BRANCH_COLORS[i % BRANCH_COLORS.length]} collapsed={collapsed} onToggle={onToggle} onSeek={onSeek} onPick={onPick} fresh={fresh} activeId={activeId} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 按住之后移动超过这么多像素才算拖（不然点一下也会被当成拖） */
const DRAG_START_PX = 4;

/**
 * 装导图的那个能滚动的框：用鼠标按住空白处或节点的字拖动，就是滚动它（页面里只有横向，全屏里两个方向）。
 * 只管鼠标：触屏上手指滑动本来就是滚动。按在按钮和链接上（时间、收起 / 展开、出处）不算拖。
 * 有鼠标的设备上框里的字不能拖选了（拖是用来挪图的），要字用「复制大纲」。
 */
function PanBox({ className, children, boxRef }: { className: string; children: ReactNode; boxRef?: RefObject<HTMLDivElement | null> }) {
  const own = useRef<HTMLDivElement>(null);
  const ref = boxRef ?? own;
  const drag = useRef<{ x: number; y: number; left: number; top: number; moving: boolean } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = ref.current;
    if (!box || e.pointerType !== "mouse" || e.button !== 0 || (e.target as Element).closest("button, a")) return;
    drag.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop, moving: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = ref.current;
    const d = drag.current;
    if (!box || !d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moving) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      d.moving = true;
      // 拖出框外也接着收到移动和松开
      box.setPointerCapture(e.pointerId);
      box.style.cursor = "grabbing";
    }
    box.scrollLeft = d.left - dx;
    box.scrollTop = d.top - dy;
  };
  const end = () => {
    drag.current = null;
    if (ref.current) ref.current.style.cursor = "";
  };

  return (
    <div ref={ref} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} className={`${className} pointer-fine:cursor-grab pointer-fine:select-none`}>
      {children}
    </div>
  );
}

const ACTION = "cursor-pointer rounded-sm text-xs text-ink-muted hover:text-ink";

type MindMapProps = {
  title: string;
  nodes: OutlineLine[];
  /** 这条内容有能跳的播放器：带时间的节点点了跳过去 */
  canSeek?: boolean;
  heading?: string;
  /** 页面里装图的那个框怎么滚：默认只横向（见顶注）；导图页限高、两个方向都滚 */
  boxClassName?: string;
  onPick?: (id: number) => void;
  fresh?: ReadonlySet<number>;
  activeId?: number | null;
  /** 变了就把图重新摆正（中心主题回到框的中间）：整张图被换掉之后用 */
  recenter?: unknown;
};

export function MindMap({ title, nodes, canSeek = false, heading = "思维导图", boxClassName = "overflow-x-auto overscroll-x-contain", onPick, fresh, activeId = null, recenter }: MindMapProps) {
  const tree = useMemo(() => buildOutlineTree(nodes), [nodes]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => (nodes.length > EXPAND_ALL_UNDER ? parentsFrom(tree, 2) : new Set()));
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // 限了高的框（导图页）里图比框高：中心主题竖着居中在整张图的中间，一开始会在框外面——把它滚到框的中间。
  // 不限高的框（详情页）没有可滚的，这里什么也不会发生
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.scrollTop = Math.max(0, (box.scrollHeight - box.clientHeight) / 2);
    box.scrollLeft = 0;
  }, [recenter]);

  // 大纲里光标到了哪一行，图上那个节点不在框里就滚过去（只滚这个框，不动页面）
  useEffect(() => {
    const box = boxRef.current;
    const el = activeId === null ? null : box?.querySelector<HTMLElement>(`[data-node="${activeId}"]`);
    if (!box || !el) return;
    const frame = box.getBoundingClientRect();
    const node = el.getBoundingClientRect();
    if (node.top < frame.top + 8 || node.bottom > frame.bottom - 8) box.scrollTop += node.top + node.height / 2 - (frame.top + frame.height / 2);
    if (node.left < frame.left + 8 || node.right > frame.right - 8) box.scrollLeft += node.left + node.width / 2 - (frame.left + frame.width / 2);
  }, [activeId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (full && !dialog.open) dialog.showModal();
    if (!full && dialog.open) dialog.close();
  }, [full]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // 全屏时播放器被盖住了：先退出全屏再跳
  const seek = canSeek
    ? (at: number) => {
        setFull(false);
        seekPlayer(at);
      }
    : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outlineToText(title, nodes));
      setCopied("done");
    } catch {
      // 剪贴板接口只在 https 和 localhost 下有
      setCopied("failed");
    }
  };

  // 页面里的和全屏里的是同一张图的两份（折叠状态共用）；全屏那份只在打开时才画
  const pick = onPick
    ? (id: number) => {
        setFull(false);
        onPick(id);
      }
    : undefined;
  const canvas = <Canvas title={title} tree={tree} collapsed={collapsed} onToggle={toggle} onSeek={seek} onPick={pick} fresh={fresh} activeId={activeId} />;
  const foldAction =
    collapsed.size > 0 ? (
      <button type="button" className={ACTION} onClick={() => setCollapsed(new Set())}>
        全部展开
      </button>
    ) : (
      <button type="button" className={ACTION} onClick={() => setCollapsed(parentsFrom(tree, 1))}>
        只看主干
      </button>
    );

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="label">{heading}</h2>
        <div className="flex items-center gap-3.5">
          {foldAction}
          <button type="button" className={ACTION} onClick={() => void copy()} title="复制成缩进的大纲，可以贴进别的大纲 / 导图工具">
            {copied === "done" ? "已复制" : copied === "failed" ? "没复制成" : "复制大纲"}
          </button>
          <button type="button" className={ACTION} onClick={() => setFull(true)}>
            全屏
          </button>
        </div>
      </div>
      <PanBox boxRef={boxRef} className={`panel ${boxClassName}`}>
        {canvas}
      </PanBox>
      <dialog ref={dialogRef} onClose={() => setFull(false)} aria-label={`思维导图：${title}`} className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none bg-canvas p-0 text-ink backdrop:bg-black/40">
        {full && (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
              <p className="min-w-0 truncate text-sm font-medium">{title}</p>
              <div className="flex shrink-0 items-center gap-3.5">
                {foldAction}
                <button type="button" className="btn h-8" onClick={() => setFull(false)}>
                  退出全屏
                </button>
              </div>
            </div>
            <PanBox className="min-h-0 flex-1 overflow-auto overscroll-contain">{canvas}</PanBox>
          </div>
        )}
      </dialog>
    </section>
  );
}
