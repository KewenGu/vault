"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { clock } from "@/lib/media/transcript";
import { buildOutlineTree, outlineToText, type OutlineNode, type OutlineTreeNode } from "@/lib/vault/outline";
import { seekPlayer } from "./seek-time";

/**
 * 详情页的思维导图：中心主题（标题）在左，分支往右展开。数据是理解时产出的大纲（lib/vault/outline.ts）。
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
const BRANCH_COLORS = ["#3f8f6b", "#4f7cac", "#c2703d", "#8a6fb0", "#b8893a", "#b05a70", "#5d8f93"];
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

/** 有下一层的节点里，层级 ≥ fromDepth 的那些的 id */
function parentsFrom(tree: OutlineTreeNode[], fromDepth: number): Set<number> {
  const ids = new Set<number>();
  walk(tree, (n) => {
    if (n.children.length > 0 && n.depth >= fromDepth) ids.add(n.id);
  });
  return ids;
}

function countDescendants(node: OutlineTreeNode): number {
  let n = 0;
  walk(node.children, () => n++);
  return n;
}

type CanvasProps = {
  title: string;
  tree: OutlineTreeNode[];
  collapsed: ReadonlySet<number>;
  onToggle: (id: number) => void;
  /** null = 这条内容没有能跳的播放器，时间只是文字 */
  onSeek: ((at: number) => void) | null;
};

function Branch({ node, parent, color, collapsed, onToggle, onSeek }: Omit<CanvasProps, "title" | "tree"> & { node: OutlineTreeNode; parent: string; color: string }) {
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !collapsed.has(node.id);
  const top = node.depth === 1;
  return (
    <li className="flex items-center">
      <div data-node={node.id} data-parent={parent} data-color={color} className="flex shrink-0 items-center gap-0.5">
        <div
          className={
            top
              ? "max-w-[8.5em] rounded-md border px-2.5 py-1.5 text-[13px] leading-snug font-medium sm:max-w-[13em]"
              : "max-w-[11em] px-1.5 py-0.5 text-[13px] leading-snug text-ink-secondary sm:max-w-[17em]"
          }
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
        </div>
        {hasChildren && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `收起「${node.text}」下面的 ${node.children.length} 项` : `展开「${node.text}」下面的 ${node.children.length} 项`}
            onClick={() => onToggle(node.id)}
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
            <Branch key={c.id} node={c} parent={String(node.id)} color={color} collapsed={collapsed} onToggle={onToggle} onSeek={onSeek} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Canvas({ title, tree, collapsed, onToggle, onSeek }: CanvasProps) {
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
            <Branch key={n.id} node={n} parent={ROOT} color={BRANCH_COLORS[i % BRANCH_COLORS.length]} collapsed={collapsed} onToggle={onToggle} onSeek={onSeek} />
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
 * 只管鼠标：触屏上手指滑动本来就是滚动。按在按钮上（时间、收起 / 展开）不算拖。
 * 有鼠标的设备上框里的字不能拖选了（拖是用来挪图的），要字用「复制大纲」。
 */
function PanBox({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moving: boolean } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = ref.current;
    if (!box || e.pointerType !== "mouse" || e.button !== 0 || (e.target as Element).closest("button")) return;
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

export function MindMap({ title, nodes, canSeek }: { title: string; nodes: OutlineNode[]; canSeek: boolean }) {
  const tree = useMemo(() => buildOutlineTree(nodes), [nodes]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => (nodes.length > EXPAND_ALL_UNDER ? parentsFrom(tree, 2) : new Set()));
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (full && !dialog.open) dialog.showModal();
    if (!full && dialog.open) dialog.close();
  }, [full]);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
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
  const canvas = <Canvas title={title} tree={tree} collapsed={collapsed} onToggle={toggle} onSeek={seek} />;
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
        <h2 className="label">思维导图</h2>
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
      <PanBox className="panel overflow-x-auto overscroll-x-contain">{canvas}</PanBox>
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
