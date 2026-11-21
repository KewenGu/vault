import type { Block } from "./journal-doc";

/**
 * 编辑器里对正文层的操作（纯函数）：放进一块、拿掉一块、上下挪。
 * 两条规矩每次操作完都成立（tidy）：挨着的两块文字并成一块；最后一块一定是文字——页尾永远有地方接着写。
 */

export const newBlockId = () => `b${Math.random().toString(36).slice(2, 10)}`;

const isBlank = (b: Block | undefined) => b?.type === "text" && b.text.trim() === "";

export function tidy(blocks: Block[], makeId: () => string = newBlockId): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === "text" && last?.type === "text") out[out.length - 1] = { ...last, text: [last.text, b.text].filter((t) => t.trim() !== "").join("\n") };
    else out.push(b);
  }
  if (out[out.length - 1]?.type !== "text") out.push({ id: makeId(), type: "text", text: "" });
  return out;
}

/**
 * 把一块放到 afterId 那一块的后面；afterId 是 null（或找不到）= 放到页尾。
 * 落脚的地方是一块空白的文字（刚开的一页、页尾留着的那一块）时放在它前面：新的一块顶上去，空白的那块留在下面接着写。
 */
export function insertAfter(blocks: Block[], afterId: string | null, block: Block, makeId: () => string = newBlockId): Block[] {
  const found = afterId === null ? -1 : blocks.findIndex((b) => b.id === afterId);
  const at = found >= 0 ? found : blocks.length - 1;
  const before = at >= 0 && isBlank(blocks[at]);
  const index = at < 0 ? 0 : before ? at : at + 1;
  return tidy([...blocks.slice(0, index), block, ...blocks.slice(index)], makeId);
}

export function removeBlock(blocks: Block[], id: string, makeId: () => string = newBlockId): Block[] {
  return tidy(
    blocks.filter((b) => b.id !== id),
    makeId
  );
}

/** 往上（-1）或往下（1）挪一格：和旁边那一块换位置。到头了不动。 */
export function moveBlock(blocks: Block[], id: string, dir: -1 | 1, makeId: () => string = newBlockId): Block[] {
  const from = blocks.findIndex((b) => b.id === id);
  let to = from + dir;
  // 页尾留着的那块空白文字不算位置：往下挪不越过它
  if (from < 0 || to < 0 || to >= blocks.length || (to === blocks.length - 1 && isBlank(blocks[to]))) return blocks;
  // 旁边是一块空白的文字：跳过它，不然看起来没动
  if (isBlank(blocks[to]) && to + dir >= 0 && to + dir < blocks.length) to += dir;
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return tidy(next, makeId);
}

/** 能不能往这个方向挪（按钮要不要灰掉）。 */
export const canMove = (blocks: Block[], id: string, dir: -1 | 1) => moveBlock(blocks, id, dir, () => "tail") !== blocks;

export const patchBlock = (blocks: Block[], id: string, patch: { text?: string; caption?: string }): Block[] =>
  blocks.map((b) => (b.id !== id ? b : b.type === "text" && patch.text !== undefined ? { ...b, text: patch.text } : b.type === "photo" && patch.caption !== undefined ? { ...b, caption: patch.caption } : b));
