import { MAP_MAX, fixDepths, type MapNode } from "./map-nodes";

/**
 * 大纲编辑器的操作（纯函数）：缩进、反缩进、加一行、删、上下挪。一行 = 一个节点；「它下面的」= 紧跟在后面、比它深的那些行。
 * 每个操作返回新的行，做不了的（已经到头了、会超过最深一层）返回 null。
 */

/** 编辑器里的一行：key 是页面上认这一行用的（不存库） */
export type Row = MapNode & { key: string };

/** 第 i 行连同它下面的，到哪一行为止（不含） */
export function subtreeEnd(rows: readonly { depth: number }[], i: number): number {
  let j = i + 1;
  while (j < rows.length && rows[j].depth > rows[i].depth) j++;
  return j;
}

const shift = (rows: Row[], from: number, to: number, by: number): Row[] => rows.map((r, k) => (k >= from && k < to ? { ...r, depth: r.depth + by } : r));

/** 缩进：变成上一行的下一层，它下面的跟着走。第一行、已经比上一行深、会超过最深一层的不动。 */
export function indentRow(rows: Row[], i: number): Row[] | null {
  if (i <= 0 || i >= rows.length || rows[i].depth > rows[i - 1].depth) return null;
  const end = subtreeEnd(rows, i);
  if (rows.slice(i, end).some((r) => r.depth + 1 > MAP_MAX.depth)) return null;
  return shift(rows, i, end, 1);
}

/**
 * 反缩进：往上提一层，它下面的跟着走。排在它后面的兄弟留在原来的上级下面（它挪到那些兄弟的后面，成为原上级的下一个兄弟）
 * ——不然后面的兄弟会悄悄变成它下面的，图上就是一串节点换了上级。
 */
export function outdentRow(rows: Row[], i: number): Row[] | null {
  if (i < 0 || i >= rows.length || rows[i].depth <= 1) return null;
  const depth = rows[i].depth;
  const end = subtreeEnd(rows, i);
  // 后面还属于原上级的那些行（它的兄弟和兄弟下面的）
  let rest = end;
  while (rest < rows.length && rows[rest].depth >= depth) rest++;
  return [...rows.slice(0, i), ...rows.slice(end, rest), ...shift(rows.slice(i, end), 0, end - i, -1), ...rows.slice(rest)];
}

/**
 * 在第 i 行后面加一行。这一行下面有东西时，新行是它的第一个下一层（不然新行会把那些「抢」过去）；没有时和它同层。
 * i = -1：加在最前面。到了行数上限返回 null。
 */
export function insertAfter(rows: Row[], i: number, row: { key: string; text: string }): { rows: Row[]; index: number } | null {
  if (rows.length >= MAP_MAX.nodes) return null;
  const cur = rows[i];
  const hasChildren = cur && i + 1 < rows.length && rows[i + 1].depth > cur.depth;
  const depth = !cur ? 1 : hasChildren ? Math.min(cur.depth + 1, MAP_MAX.depth) : cur.depth;
  const next = [...rows.slice(0, i + 1), { key: row.key, depth, text: row.text, item: null }, ...rows.slice(i + 1)];
  return { rows: next, index: i + 1 };
}

/** 删掉第 i 行，连同它下面的。 */
export function removeSubtree(rows: Row[], i: number): Row[] | null {
  if (i < 0 || i >= rows.length) return null;
  return fixDepths([...rows.slice(0, i), ...rows.slice(subtreeEnd(rows, i))]);
}

/** 第 i 行连同它下面的，和上一个（dir = -1）/ 下一个（dir = 1）同层的兄弟换位置。没有兄弟可换返回 null。 */
export function moveSubtree(rows: Row[], i: number, dir: -1 | 1): { rows: Row[]; index: number } | null {
  if (i < 0 || i >= rows.length) return null;
  const depth = rows[i].depth;
  const end = subtreeEnd(rows, i);
  if (dir === 1) {
    if (end >= rows.length || rows[end].depth !== depth) return null;
    const nextEnd = subtreeEnd(rows, end);
    return { rows: [...rows.slice(0, i), ...rows.slice(end, nextEnd), ...rows.slice(i, end), ...rows.slice(nextEnd)], index: i + (nextEnd - end) };
  }
  // 往上找同一个上级下面的前一个兄弟：遇到更浅的行就是到头了
  let prev = i - 1;
  while (prev >= 0 && rows[prev].depth > depth) prev--;
  if (prev < 0 || rows[prev].depth !== depth) return null;
  return { rows: [...rows.slice(0, prev), ...rows.slice(i, end), ...rows.slice(prev, i), ...rows.slice(end)], index: prev };
}

/**
 * 贴进来的几行（已经解析成节点，层级从 1 起）插到第 i 行后面：整体挪到第 i 行的层级上（i = -1 时从第 1 层起）。
 * 超过行数上限的部分不要，返回实际插了几行。
 */
export function insertLines(rows: Row[], i: number, lines: { depth: number; text: string }[], keyOf: () => string): { rows: Row[]; index: number; inserted: number } {
  const base = (rows[i]?.depth ?? 1) - 1;
  const room = Math.max(0, MAP_MAX.nodes - rows.length);
  const added: Row[] = lines.slice(0, room).map((l) => ({ key: keyOf(), depth: Math.min(l.depth + base, MAP_MAX.depth), text: l.text, item: null }));
  const at = i < 0 ? 0 : subtreeEnd(rows, i);
  return { rows: fixDepths([...rows.slice(0, at), ...added, ...rows.slice(at)]), index: at + added.length - 1, inserted: added.length };
}
