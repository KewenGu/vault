import { JOURNAL_MAX, type Deco, type Stroke } from "./journal-doc";

/**
 * 手帐层的操作（纯函数）：贴纸、胶带、艺术字（decos）和手绘的笔画（strokes）。
 *
 * 每一件东西挂在一块正文上（anchor = 那一块的 id，页眉是 HEAD），坐标相对那一块的左上角、按 360 宽的页面算：
 * deco 的 x / y 是它中心的位置，stroke 的 points 是 x、y 交替的一串。正文改长了，下面的块往下走，挂着的东西跟着走。
 * 数组的顺序就是叠放的顺序：后面的盖在前面的上面。
 *
 * deco.kind 和各自的 data：
 *   sticker  { name }（自带的贴纸，见 components/journal/stickers.ts）或 { emoji }
 *   mine     { sticker }（自己传的贴纸，journal_stickers 的 id）
 *   tape     { look }（哪一种胶带）
 *   word     { text, look }（艺术字）
 */

/** 页眉当一块正文用时的 id */
export const HEAD = "head";
export const DECO_SCALE = { min: 0.3, max: 5 } as const;
export const WORD_MAX = 40;

export const newDecoId = () => `d${Math.random().toString(36).slice(2, 10)}`;

const round = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
/** 角度收到 (-180, 180] */
export const normalizeAngle = (deg: number) => {
  const r = ((deg % 360) + 360) % 360;
  return round(r > 180 ? r - 360 : r) + 0;
};

/** 贴一件上去（叠在最上面）。满了返回原来的数组（调用方据此提示）。 */
export function addDeco(decos: Deco[], deco: Deco): Deco[] {
  if (decos.length >= JOURNAL_MAX.decos) return decos;
  return [...decos, { ...deco, x: round(deco.x), y: round(deco.y), r: normalizeAngle(deco.r), s: clamp(deco.s, DECO_SCALE.min, DECO_SCALE.max) }];
}

export type DecoPatch = Partial<Pick<Deco, "anchor" | "x" | "y" | "r" | "s">> & { data?: Deco["data"] };

/** 挪、转、放大缩小、换字。大小和角度收在范围里；data 是并进去，不是整个换掉。 */
export function patchDeco(decos: Deco[], id: string, patch: DecoPatch): Deco[] {
  return decos.map((d) =>
    d.id !== id
      ? d
      : {
          ...d,
          ...(patch.anchor !== undefined ? { anchor: patch.anchor } : {}),
          ...(patch.x !== undefined ? { x: round(patch.x) } : {}),
          ...(patch.y !== undefined ? { y: round(patch.y) } : {}),
          ...(patch.r !== undefined ? { r: normalizeAngle(patch.r) } : {}),
          ...(patch.s !== undefined ? { s: Math.round(clamp(patch.s, DECO_SCALE.min, DECO_SCALE.max) * 100) / 100 } : {}),
          ...(patch.data !== undefined ? { data: { ...d.data, ...patch.data } } : {}),
        }
  );
}

export const removeDeco = (decos: Deco[], id: string): Deco[] => decos.filter((d) => d.id !== id);

/** 拿到最上面。已经在最上面返回原数组。 */
export function raiseDeco(decos: Deco[], id: string): Deco[] {
  const at = decos.findIndex((d) => d.id === id);
  return at < 0 || at === decos.length - 1 ? decos : [...decos.slice(0, at), ...decos.slice(at + 1), decos[at]];
}

// ---------------------------------------------------------------- 挂在哪一块上

/** 每一块（含页眉）在页面里的位置：顶边和高度，从上到下排好（页面的逻辑像素）。编辑器从 DOM 上量出来。 */
export type Tops = { id: string; top: number; height: number }[];

/** 页面上这个高度落在哪一块里：顶边不超过它的最后一块；比第一块还高就是第一块。 */
export function anchorAt(tops: Tops, pageY: number): string {
  let found = tops[0]?.id ?? HEAD;
  for (const t of tops) if (t.top <= pageY) found = t.id;
  return found;
}

/** 页面坐标 → 挂在哪一块、相对那一块的坐标。 */
export function toAnchored(tops: Tops, pageX: number, pageY: number): { anchor: string; x: number; y: number } {
  const anchor = anchorAt(tops, pageY);
  return { anchor, x: round(pageX), y: round(pageY - (tops.find((t) => t.id === anchor)?.top ?? 0)) };
}

/**
 * 一件东西挂着的块没了：改挂到它上面最近的那块还在的块上，接在那一块的内容后面（y 加上那一块的高度）。
 * 两段字并成一段时，下面那段的字就是接在上面那段后面的，贴在它旁边的东西跟着字走；
 * 删掉一张照片时，贴在照片上的东西落在照片原来的位置附近。返回新的块和 y 要加多少。
 */
function newHome(anchor: string, alive: ReadonlySet<string>, tops: Tops): { anchor: string; dy: number } | null {
  if (alive.has(anchor)) return null;
  const at = tops.findIndex((t) => t.id === anchor);
  let above = at - 1;
  while (above >= 0 && !alive.has(tops[above].id)) above--;
  // 量不到原来那块在哪（数据里指着一块早就不在的）、或者它上面没有还在的块：挂到页眉上，坐标不动
  if (at < 0 || above < 0) return { anchor: HEAD, dy: 0 };
  return { anchor: tops[above].id, dy: tops[above].height };
}

/**
 * 正文里有块要没了（删了一张照片、两段字并成了一段）：挂在那些块上的贴纸改挂到还在的块上（见 newHome）。
 * alive = 改完之后还在的块；tops = 改之前量的各块的位置。要在改正文之前调。
 */
export function rehomeDecos(decos: Deco[], alive: ReadonlySet<string>, tops: Tops): Deco[] {
  let changed = false;
  const out = decos.map((d) => {
    const home = newHome(d.anchor, alive, tops);
    if (!home) return d;
    changed = true;
    return { ...d, anchor: home.anchor, y: round(d.y + home.dy) };
  });
  return changed ? out : decos;
}

export function rehomeStrokes(strokes: Stroke[], alive: ReadonlySet<string>, tops: Tops): Stroke[] {
  let changed = false;
  const out = strokes.map((s) => {
    const home = newHome(s.anchor, alive, tops);
    if (!home) return s;
    changed = true;
    return { ...s, anchor: home.anchor, points: home.dy === 0 ? s.points : s.points.map((p, i) => (i % 2 === 1 ? round(p + home.dy) : p)) };
  });
  return changed ? out : strokes;
}

// ---------------------------------------------------------------- 手绘

/** 相邻两个点至少隔这么远才记（手指停着不动不会攒一堆点） */
const MIN_STEP = 1.2;

/** 往正在画的这一笔里加一个点。离上一个点太近、或这一笔已经到上限，不加（返回 false）。 */
export function addPoint(points: number[], x: number, y: number): boolean {
  const n = points.length;
  if (n >= JOURNAL_MAX.points * 2) return false;
  if (n >= 2 && Math.hypot(x - points[n - 2], y - points[n - 1]) < MIN_STEP) return false;
  points.push(round(x), round(y));
  return true;
}

/** 一笔画成 SVG 的路径：相邻两点的中点之间用二次曲线连起来，转弯是圆的。只有一个点的画成一个小点。 */
export function strokePath(points: number[]): string {
  if (points.length < 2) return "";
  if (points.length < 4) return `M${points[0]} ${points[1]}l0.1 0`;
  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length - 2; i += 2) d += `Q${points[i]} ${points[i + 1]} ${round((points[i] + points[i + 2]) / 2)} ${round((points[i + 1] + points[i + 3]) / 2)}`;
  return `${d}L${points[points.length - 2]} ${points[points.length - 1]}`;
}

/** 点到线段的距离 */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 橡皮碰没碰到这一笔：(x, y) 是相对这一笔挂着的那一块的坐标，reach 是橡皮的半径。 */
export function hitsStroke(stroke: Stroke, x: number, y: number, reach: number): boolean {
  const p = stroke.points;
  const within = reach + stroke.width / 2;
  if (p.length < 4) return Math.hypot(x - p[0], y - p[1]) <= within;
  for (let i = 0; i < p.length - 2; i += 2) if (segmentDistance(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= within) return true;
  return false;
}

export function addStroke(strokes: Stroke[], stroke: Stroke): Stroke[] {
  return strokes.length >= JOURNAL_MAX.strokes || stroke.points.length < 2 ? strokes : [...strokes, stroke];
}

/** 艺术字的字：一行，最多 WORD_MAX 个字。 */
export const cleanWord = (raw: string) => Array.from(raw.replace(/\s+/g, " ")).slice(0, WORD_MAX).join("");
