"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ComponentType, type Ref } from "react";
import type { ForceGraphMethods, ForceGraphProps } from "react-force-graph-2d";
import type { GraphData, GraphLink, GraphNode } from "@/lib/graph/data";
import { ENTITY_TYPES, ENTITY_TYPE_INFO, RELATION_INFO, type EntityType } from "@/lib/vault/taxonomy";

/**
 * 知识图谱：节点 = 实体（大小按有几条内容提到它，颜色按类型），实线 = 内容里明说的关系，细虚线 = 出现在同一条内容里。
 * 点一个节点看它的说明、别名和连着的东西，再跳去看提到它的内容。
 * force-graph 用 canvas + d3-force，只能在浏览器里跑：ssr:false 的 dynamic 只能写在 Client Component 里。
 */

type Node = GraphNode & { x?: number; y?: number };
type Link = Omit<GraphLink, "source" | "target"> & { source: string | Node; target: string | Node };

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false }) as unknown as ComponentType<
  ForceGraphProps<Node, Link> & { ref?: Ref<ForceGraphMethods<Node, Link> | undefined> }
>;

/** 按类型的分类色（亮暗两套底色上都看得清的中等明度），顺序固定：颜色跟着类型走，不跟着筛选变 */
const TYPE_COLOR: Record<EntityType, string> = {
  person: "#c2703d",
  org: "#4f7cac",
  place: "#3f8f6b",
  product: "#8a6fb0",
  work: "#b8893a",
  concept: "#5d8f93",
  event: "#b05a70",
};

const endId = (end: string | Node) => (typeof end === "object" ? end.id : end);
const radius = (n: Node) => 3 + Math.sqrt(n.count) * 2.2;
/** 图小的时候每个节点都标名字；节点多了，缩得很小时只标提到次数多的，放大了才都标 */
const LABEL_ALL_UNDER = 60;
const labelVisible = (n: Node, scale: number, selected: boolean, total: number) => selected || total <= LABEL_ALL_UNDER || n.count * scale >= 2.2;

export function GraphView({ graph }: { graph: GraphData }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<Node, Link> | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 560 });
  const [types, setTypes] = useState<Set<EntityType>>(() => new Set(ENTITY_TYPES));
  const [minCount, setMinCount] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const fitted = useRef(false);
  const [ink, setInk] = useState({ text: "#1c1d1a", line: "#bdb8ab", halo: "#f4f2ed" });

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setSize({ width: box.clientWidth, height: Math.max(420, Math.min(760, window.innerHeight - 260)) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // 画布上的字和线用页面的颜色变量（亮暗模式切换时跟着换）
  useEffect(() => {
    const read = () => {
      const css = getComputedStyle(document.documentElement);
      setInk({ text: css.getPropertyValue("--color-ink").trim(), line: css.getPropertyValue("--color-edge-strong").trim(), halo: css.getPropertyValue("--color-canvas").trim() });
    };
    read();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => media.removeEventListener("change", read);
  }, []);

  const counts = useMemo(() => {
    const c = Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0])) as Record<EntityType, number>;
    for (const n of graph.nodes) c[n.type]++;
    return c;
  }, [graph.nodes]);
  const maxCount = useMemo(() => Math.max(1, ...graph.nodes.map((n) => n.count)), [graph.nodes]);

  const data = useMemo(() => {
    const nodes: Node[] = graph.nodes.filter((n) => types.has(n.type) && n.count >= minCount).map((n) => ({ ...n }));
    const keep = new Set(nodes.map((n) => n.id));
    const links: Link[] = graph.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ ...l }));
    return { nodes, links };
  }, [graph, types, minCount]);

  // 默认的力太紧（同一条内容的几个节点挤成一团，名字互相压住）：把连线拉长、近处的斥力加大。
  // 图是动态加载的，ref 要等它挂上才有，所以等到有了再设一次。
  useEffect(() => {
    if (size.width === 0) return;
    let frame = 0;
    let tries = 0;
    const apply = () => {
      const fg = fgRef.current;
      if (!fg) {
        if (tries++ < 120) frame = requestAnimationFrame(apply);
        return;
      }
      // 斥力只在近处起作用：互不相连的几团不会被推到天边（那样放进画面后每一团都缩成一个点）
      fg.d3Force("charge")?.strength(-320).distanceMax(240);
      fg.d3Force("link")?.distance(72);
      fg.d3ReheatSimulation();
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [size.width, data]);

  const selected = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null;
  const neighbors = useMemo(() => {
    if (!selectedId) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.links
      .filter((l) => l.source === selectedId || l.target === selectedId)
      .map((l) => ({ link: l, other: byId.get(l.source === selectedId ? l.target : l.source), outgoing: l.source === selectedId }))
      .filter((x): x is { link: GraphLink; other: GraphNode; outgoing: boolean } => !!x.other)
      .sort((a, b) => Number(a.link.relation === "cooccur") - Number(b.link.relation === "cooccur") || b.link.weight - a.link.weight);
  }, [graph, selectedId]);
  const near = useMemo(() => new Set([selectedId, ...neighbors.map((n) => n.other.id)]), [selectedId, neighbors]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? graph.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.aliases.some((a) => a.toLowerCase().includes(q))).slice(0, 8) : [];
  }, [graph.nodes, query]);

  function focus(id: string) {
    setSelectedId(id);
    setQuery("");
    const node = data.nodes.find((n) => n.id === id);
    if (node?.x !== undefined && node.y !== undefined) {
      fgRef.current?.centerAt(node.x, node.y, 500);
      fgRef.current?.zoom(3, 500);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按类型筛选">
          {ENTITY_TYPES.filter((t) => counts[t] > 0).map((t) => {
            const on = types.has(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => setTypes((prev) => {
                  const next = new Set(prev);
                  if (on) next.delete(t);
                  else next.add(t);
                  return next;
                })}
                className={`chip cursor-pointer ${on ? "" : "opacity-45"}`}
              >
                <span aria-hidden className="size-2 rounded-full" style={{ background: TYPE_COLOR[t] }} />
                {ENTITY_TYPE_INFO[t].label}
                <span className="text-ink-faint">{counts[t]}</span>
              </button>
            );
          })}
          {maxCount > 1 && (
            <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
              至少被 {minCount} 条内容提到
              <input type="range" min={1} max={Math.min(maxCount, 10)} value={minCount} onChange={(e) => setMinCount(Number(e.target.value))} />
            </label>
          )}
        </div>
        <div ref={boxRef} className="panel relative overflow-hidden">
          {size.width > 0 && (
            <ForceGraph2D
              ref={fgRef}
              width={size.width}
              height={size.height}
              graphData={data}
              backgroundColor="rgba(0,0,0,0)"
              nodeVal={(n) => radius(n) ** 2 / 16}
              nodeLabel={(n) => `${n.name}（${ENTITY_TYPE_INFO[n.type].label} · ${n.count} 条）`}
              linkColor={() => ink.line}
              linkWidth={(l) => (l.relation === "cooccur" ? 0.6 : Math.min(4, 0.8 + l.weight * 0.6))}
              linkLineDash={(l) => (l.relation === "cooccur" ? [2, 3] : null)}
              linkDirectionalArrowLength={(l) => (l.relation === "cooccur" || l.relation === "related" ? 0 : 3.5)}
              linkDirectionalArrowRelPos={1}
              linkVisibility={(l) => !selectedId || endId(l.source) === selectedId || endId(l.target) === selectedId}
              onNodeClick={(n) => setSelectedId(n.id === selectedId ? null : n.id)}
              onBackgroundClick={() => setSelectedId(null)}
              cooldownTicks={120}
              onEngineStop={() => {
                // 第一次排好位置后把整张图放进画面；之后用户自己缩放平移，不再动
                if (fitted.current) return;
                fitted.current = true;
                fgRef.current?.zoomToFit(400, 48);
              }}
              nodeCanvasObject={(n, ctx, scale) => {
                if (n.x === undefined || n.y === undefined) return;
                const r = radius(n);
                const dim = !!selectedId && !near.has(n.id);
                ctx.globalAlpha = dim ? 0.18 : 1;
                ctx.beginPath();
                ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = TYPE_COLOR[n.type];
                ctx.fill();
                if (n.id === selectedId) {
                  ctx.lineWidth = 2 / scale;
                  ctx.strokeStyle = ink.text;
                  ctx.stroke();
                }
                if (labelVisible(n, scale, n.id === selectedId || (!!selectedId && near.has(n.id)), data.nodes.length)) {
                  const fontSize = 12 / scale;
                  ctx.font = `${fontSize}px system-ui, "PingFang SC", sans-serif`;
                  ctx.textAlign = "center";
                  ctx.textBaseline = "top";
                  const label = n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name;
                  // 字下面垫一圈底色：压在连线上也读得清
                  ctx.lineWidth = 3 / scale;
                  ctx.strokeStyle = ink.halo;
                  ctx.strokeText(label, n.x, n.y + r + 2 / scale);
                  ctx.fillStyle = ink.text;
                  ctx.fillText(label, n.x, n.y + r + 2 / scale);
                }
                ctx.globalAlpha = 1;
              }}
              nodePointerAreaPaint={(n, color, ctx) => {
                if (n.x === undefined || n.y === undefined) return;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(n.x, n.y, radius(n) + 2, 0, 2 * Math.PI);
                ctx.fill();
              }}
            />
          )}
          <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-ink-faint">实线 = 内容里明说的关系 · 虚线 = 出现在同一条内容里 · 滚轮缩放，拖动平移</p>
        </div>
      </div>

      <aside className="flex flex-col gap-4" aria-label="节点详情">
        <div className="relative">
          <label htmlFor="graph-find" className="sr-only">
            找节点
          </label>
          <input id="graph-find" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`在 ${graph.nodes.length} 个节点里找…`} className="field" />
          {matches.length > 0 && (
            <ul className="panel absolute z-10 mt-1 w-full overflow-hidden text-sm shadow-lg">
              {matches.map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => focus(n.id)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-sunken">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: TYPE_COLOR[n.type] }} />
                    <span className="min-w-0 flex-1 truncate">{n.name}</span>
                    <span className="text-xs text-ink-faint">{n.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected ? (
          <div className="panel flex flex-col gap-3 p-4">
            <p className="flex items-center gap-2 text-xs text-ink-muted">
              <span aria-hidden className="size-2 rounded-full" style={{ background: TYPE_COLOR[selected.type] }} />
              {ENTITY_TYPE_INFO[selected.type].label}
            </p>
            <h2 className="text-lg leading-snug font-semibold">{selected.name}</h2>
            {selected.aliases.length > 0 && <p className="text-xs text-ink-muted">也叫：{selected.aliases.join("、")}</p>}
            {selected.summary && <p className="text-sm leading-relaxed text-ink-secondary">{selected.summary}</p>}
            <Link href={`/entities/${selected.id}`} prefetch={false} className="btn btn-primary">
              打开它的那一页（{selected.count} 条内容）
            </Link>
            {neighbors.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="label">连着的</p>
                <ul className="flex flex-col text-sm">
                  {neighbors.slice(0, 30).map(({ link, other, outgoing }) => (
                    <li key={`${link.source}|${link.target}|${link.relation}`}>
                      <button type="button" onClick={() => focus(other.id)} className="flex w-full cursor-pointer items-baseline gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-sunken">
                        <span className="w-14 shrink-0 text-xs text-ink-faint">
                          {link.relation === "cooccur" ? "同时出现" : link.relation === "related" ? "相关" : outgoing ? RELATION_INFO[link.relation].label : `被${RELATION_INFO[link.relation].label}`}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{other.name}</span>
                        {link.weight > 1 && <span className="text-xs text-ink-faint">×{link.weight}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="label">提到最多的</p>
            <ul className="flex flex-col text-sm">
              {graph.nodes.slice(0, 20).map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => focus(n.id)} className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-sunken">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: TYPE_COLOR[n.type] }} />
                    <span className="min-w-0 flex-1 truncate">{n.name}</span>
                    <span className="text-xs text-ink-faint">{n.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
