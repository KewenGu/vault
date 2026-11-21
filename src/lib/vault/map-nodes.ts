import { z } from "zod";
import { hoistRoot, parseIndented } from "./outline";

/**
 * 自己建的思维导图（maps 表）的节点。和一条内容的大纲（outline.ts）是同一种形状——按顺序排的一行行、每行带层级，
 * 中心主题是导图的标题——只是没有时间，多一个出处：item = 这个节点是从收藏库里哪条内容来的（没有是 null）。
 *
 * 这个文件服务端和浏览器（编辑器）都用，不要引只能在服务端跑的东西。
 */

export const MAP_MAX = { nodes: 300, depth: 6, text: 200, title: 120, sources: 40 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const mapNodeSchema = z.object({
  depth: z.number().int().min(1).max(MAP_MAX.depth),
  text: z.string().min(1).max(MAP_MAX.text),
  item: z.string().regex(UUID).nullable(),
});
export type MapNode = z.infer<typeof mapNodeSchema>;

const cap = (t: string, n: number) => Array.from(t).slice(0, n).join("");

/** 层级理顺：第一行是第 1 层，每行最多比上一行深一层，不超过最深的一层。 */
export function fixDepths<T extends { depth: number }>(nodes: T[]): T[] {
  let prev = 0;
  return nodes.map((n) => {
    const depth = Math.max(1, Math.min(Math.round(n.depth) || 1, prev + 1, MAP_MAX.depth));
    prev = depth;
    return depth === n.depth ? n : { ...n, depth };
  });
}

/**
 * 外面来的节点（浏览器的编辑器、接口、库里读出来的）→ 干净的：不是这个形状的行和没有字的行丢掉，字数截到上限，
 * 出处不是 id 的当没有，层级理顺，最多留 MAP_MAX.nodes 行。
 */
export function cleanMapNodes(raw: unknown): MapNode[] {
  if (!Array.isArray(raw)) return [];
  const nodes: MapNode[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { depth, text, item } = r as Record<string, unknown>;
    const clean = typeof text === "string" ? cap(text.replace(/\s+/g, " ").trim(), MAP_MAX.text) : "";
    if (!clean) continue;
    nodes.push({ depth: typeof depth === "number" && Number.isFinite(depth) ? depth : 1, text: clean, item: isUuid(item) ? item : null });
    if (nodes.length >= MAP_MAX.nodes) break;
  }
  return fixDepths(nodes);
}

/** 标题：压成一行，截到上限 */
export const cleanMapTitle = (raw: unknown) => (typeof raw === "string" ? cap(raw.replace(/\s+/g, " ").trim(), MAP_MAX.title) : "");

/** 出处的 id 列表：只留是 id 的，去重，最多 MAP_MAX.sources 个 */
export function cleanSources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isUuid))].slice(0, MAP_MAX.sources);
}

// ---------------------------------------------------------------- 和模型之间的写法

/** 行尾的出处标记：`[S3]`（模型偶尔写成全角括号）；一行写了几个的只认第一个 */
const REF_SUFFIX = /\s*[[［【]\s*S(\d+)\s*[\]］】]\s*$/i;

/**
 * 导图写成给模型看的缩进文字：每层两个空格，有出处的行尾带 `[S编号]`（编号是这次对话里材料的编号，labelOf 给；
 * 这次没带上的材料没有编号，不标）。
 */
export function mapOutlineText(nodes: MapNode[], labelOf: (item: string) => string | null): string {
  return nodes
    .map((n) => {
      const label = n.item ? labelOf(n.item) : null;
      return `${"  ".repeat(n.depth - 1)}- ${n.text}${label ? ` [${label}]` : ""}`;
    })
    .join("\n");
}

/**
 * 模型写回来的缩进文字 → 节点。行尾的 `[S3]` 读成出处（itemOf 把编号换回内容 id，认不出的编号当没有）。
 * 模型把中心主题也写成了一行（唯一的第一层、字和标题一样）：去掉，其余往上提一层。
 */
export function parseMapOutline(raw: string, title: string, itemOf: (label: string) => string | null): MapNode[] {
  // 先多留一点字数：出处标记在行尾，按上限截断会把它截掉
  const lines = parseIndented(raw, { ...MAP_MAX, text: MAP_MAX.text + 40 });
  const nodes: MapNode[] = [];
  for (const line of lines) {
    let text = line.text;
    let item: string | null = null;
    for (let m = REF_SUFFIX.exec(text); m; m = REF_SUFFIX.exec(text)) {
      item = itemOf(`S${Number(m[1])}`) ?? item;
      text = text.slice(0, m.index);
    }
    text = cap(text.trim(), MAP_MAX.text);
    if (text) nodes.push({ depth: line.depth, text, item });
  }
  const single = nodes.filter((n) => n.depth === 1);
  const rooted = single.length === 1 && nodes[0].text.trim() === title.trim() ? hoistRoot(nodes) : nodes;
  return fixDepths(rooted);
}
