import { z } from "zod";
import { parseClock } from "@/lib/media/transcript";

/**
 * 一条内容的大纲：思维导图的数据。理解那一次调用顺带产出（`<outline>` 标签，见 understand.ts），存在 understanding.outline 里。
 *
 * 存成「按原顺序排的一行行节点，每行带层级」而不是嵌套的树：模型写的就是缩进的行，校验和以后的编辑（缩进 / 反缩进一行）
 * 也都按行来；画图时再用 buildOutlineTree 变成树。中心主题不在里面——就是这条内容的标题。
 *
 * 这个文件服务端（解析）和浏览器（画图）都用，不要引只能在服务端跑的东西。
 */

export const OUTLINE_MAX = { nodes: 60, depth: 4, text: 120 } as const;

export const outlineNodeSchema = z.object({
  /** 第几层：1 = 中心主题下面的第一层分支 */
  depth: z.number().int().min(1).max(OUTLINE_MAX.depth),
  /** 视频 / 音频里讲到这一点的时间（秒）；没有是 null */
  at: z.number().nullable(),
  text: z.string().min(1).max(OUTLINE_MAX.text),
});
export type OutlineNode = z.infer<typeof outlineNodeSchema>;

/** 行首的项目符号（模型偶尔不用「-」） */
const BULLET = /^[-*+•·▪◦–—]\s*/;
/** 行首方括号里的时间：`[1:05]`、`［1:02:03］`、`【0:20】` */
const TIME_PREFIX = /^[[［【(（]\s*((?:\d{1,2}:)?\d{1,3}:[0-5]\d)\s*[\]］】)）]\s*/;

/** 缩进的宽度：制表符和全角空格算两格 */
function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t" || ch === "　") width += 2;
    else break;
  }
  return width;
}

export type OutlineLimits = { nodes: number; depth: number; text: number };

/**
 * 缩进的一行行文字 → 节点（一条内容的大纲和自己建的导图都用，上限各给各的）。
 *
 * 层级按缩进算，不要求每层正好两格：比上一行缩得深就是它的下一层，缩回到谁的位置就和谁同层。一次最多深一层
 * （跳着缩进的当成下一层）；超过最深一层的并到那一层。行首方括号里的时间读成 at。字数超了的截断，节点数到了上限就停。
 */
export function parseIndented(raw: string, max: OutlineLimits): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  /** 当前这一行的各级祖先的缩进宽度 */
  const stack: number[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const indent = indentOf(line);
    let text = line.trim().replace(BULLET, "");
    const time = TIME_PREFIX.exec(text);
    if (time) text = text.slice(time[0].length);
    text = Array.from(text.trim()).slice(0, max.text).join("");
    if (!text) continue;
    while (stack.length > 0 && stack[stack.length - 1] >= indent) stack.pop();
    stack.push(indent);
    nodes.push({ depth: Math.min(stack.length, max.depth), at: time ? parseClock(time[1]) : null, text });
    if (nodes.length >= max.nodes) break;
  }
  return nodes;
}

/** 模型把中心主题也写成了一行、其余全挂在它下面：去掉这一行，其余的往上提一层。 */
export function hoistRoot<T extends { depth: number }>(nodes: T[]): T[] {
  return nodes.length > 1 && nodes.filter((n) => n.depth === 1).length === 1 ? nodes.slice(1).map((n) => ({ ...n, depth: n.depth - 1 })) : nodes;
}

/**
 * `<outline>` 标签里的文字 → 一条内容的大纲。规则见 parseIndented，另外：
 * - 多写的中心主题去掉（hoistRoot）。
 * - 不成树的不要（返回空）：不到两个分支、或者一个下一层都没有——那只是一列并列的点，「内容要点」已经有了。
 */
export function parseOutline(raw: string): OutlineNode[] {
  const hoisted = hoistRoot(parseIndented(raw, OUTLINE_MAX));
  const branches = hoisted.filter((n) => n.depth === 1).length;
  return branches >= 2 && hoisted.some((n) => n.depth > 1) ? hoisted : [];
}

/** 画图要的一行：一条内容的大纲带时间（at），自己建的导图带出处（item = 收藏库里那条内容的 id） */
export type OutlineLine = { depth: number; text: string; at?: number | null; item?: string | null; /** 编辑器里这一行的标识：行挪了位置，折叠状态还跟着它 */ key?: string };

export type OutlineTreeNode = {
  /** 这个节点在大纲里是第几行（从 0 数）：页面上当 key 和折叠状态的标识 */
  id: number;
  /** 折叠状态按它记：给了行的 key 用 key，没给就是行号 */
  key: string;
  depth: number;
  at: number | null;
  item: string | null;
  text: string;
  children: OutlineTreeNode[];
};

/** 一行行的节点 → 树（第一层分支的数组）。层级乱了的数据（第一行不是 1、跳层）也接得住：挂到最近的上一层下面。 */
export function buildOutlineTree(nodes: OutlineLine[]): OutlineTreeNode[] {
  const roots: OutlineTreeNode[] = [];
  /** path[d] = 当前路径上第 d + 1 层的节点 */
  const path: OutlineTreeNode[] = [];
  nodes.forEach((n, id) => {
    const depth = Math.max(1, Math.min(n.depth, path.length + 1));
    const node: OutlineTreeNode = { id, key: n.key ?? String(id), depth, at: n.at ?? null, item: n.item ?? null, text: n.text, children: [] };
    path.length = depth - 1;
    const parent = path[depth - 2];
    (parent ? parent.children : roots).push(node);
    path.push(node);
  });
  return roots;
}

/** 大纲写回缩进的文字（复制出去贴进别的大纲 / 导图工具用）：每层两个空格，第一行是中心主题。 */
export function outlineToText(title: string, nodes: OutlineLine[]): string {
  return [`- ${title}`, ...nodes.map((n) => `${"  ".repeat(n.depth)}- ${n.text}`)].join("\n");
}
