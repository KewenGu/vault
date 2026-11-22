import type { JournalStyle } from "@/lib/vault/journal-doc";

/**
 * 自带的贴纸：自己画的 SVG（64×64 的画布），按风格分成几包；另外有一包表情（用设备自己的表情字体画）。
 * 贴到页面上的是名字（deco.data.name），画的时候到这里找；认不出的名字不画。
 * 改一张贴纸的画法会改到所有贴过它的日记；要换样子就起个新名字。
 */

const HEART = "M32 56S6 40 6 22a13 13 0 0 1 26-4 13 13 0 0 1 26 4c0 18-26 34-26 34z";
const SPARK = "M32 2c3 18 12 27 30 30-18 3-27 12-30 30-3-18-12-27-30-30 18-3 27-12 30-30z";
const pixels = (rows: string[], color: string) =>
  rows.map((row, y) => [...row].map((c, x) => (c === "X" ? `<rect x="${4 + x * 8}" y="${8 + y * 8}" width="8" height="8" fill="${color}"/>` : "")).join("")).join("");

export const STICKERS: Record<string, { label: string; svg: string }> = {
  leaf: { label: "叶子", svg: '<path d="M12 52C10 28 26 10 54 10c0 28-16 44-42 42z" fill="#8fbf9a"/><path d="M14 50C24 38 34 28 48 16" stroke="#5f8f6e" stroke-width="2.5" fill="none" stroke-linecap="round"/>' },
  flower: { label: "小花", svg: '<g fill="#f6b6c4"><circle cx="32" cy="14" r="11"/><circle cx="49" cy="27" r="11"/><circle cx="43" cy="47" r="11"/><circle cx="21" cy="47" r="11"/><circle cx="15" cy="27" r="11"/></g><circle cx="32" cy="32" r="9" fill="#f7d774"/>' },
  cloud: { label: "云", svg: '<path d="M18 48a12 12 0 0 1 1-24 16 16 0 0 1 30-3 13 13 0 0 1-2 27z" fill="#cfe2f1"/>' },
  sun: { label: "太阳", svg: '<circle cx="32" cy="32" r="13" fill="#f5c66b"/><g stroke="#f5c66b" stroke-width="4" stroke-linecap="round"><path d="M32 4v8M32 52v8M4 32h8M52 32h8M12 12l6 6M46 46l6 6M12 52l6-6M46 18l6-6"/></g>' },
  cup: { label: "咖啡", svg: '<path d="M12 22h34v14a17 17 0 0 1-34 0z" fill="#c98d62"/><path d="M46 26h5a7 7 0 0 1 0 14h-6" fill="none" stroke="#c98d62" stroke-width="4"/><path d="M22 14c0-4 4-4 4-8M32 14c0-4 4-4 4-8" stroke="#b9a08c" stroke-width="2.5" fill="none" stroke-linecap="round"/><rect x="8" y="54" width="42" height="4" rx="2" fill="#b9a08c"/>' },
  sprout: { label: "小芽", svg: '<path d="M32 58V30" stroke="#5f8f6e" stroke-width="3.5" stroke-linecap="round"/><path d="M32 34C30 20 18 14 8 16c0 12 10 20 24 18z" fill="#a9d3a2"/><path d="M32 28c2-12 12-18 24-16 0 12-10 20-24 16z" fill="#8fbf9a"/>' },
  spark: { label: "星芒", svg: `<path d="${SPARK}" fill="#ff5fb7"/>` },
  spark2: { label: "紫色星芒", svg: `<path d="${SPARK}" fill="#7a5cff"/>` },
  heart: { label: "爱心", svg: `<path d="${HEART}" fill="#ff5fb7"/><path d="M15 20a8 8 0 0 1 9-6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>` },
  disc: { label: "光盘", svg: '<defs><linearGradient id="jn-cd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9ad5"/><stop offset=".35" stop-color="#c9d6ff"/><stop offset=".65" stop-color="#9af0e0"/><stop offset="1" stop-color="#b39bff"/></linearGradient></defs><circle cx="32" cy="32" r="28" fill="url(#jn-cd)"/><circle cx="32" cy="32" r="9" fill="#fff" opacity=".85"/><circle cx="32" cy="32" r="4" fill="#7a5cff"/>' },
  smile: { label: "笑脸", svg: '<circle cx="32" cy="32" r="26" fill="#ffe14d" stroke="#2a1a5e" stroke-width="3"/><circle cx="23" cy="26" r="3.5" fill="#2a1a5e"/><circle cx="41" cy="26" r="3.5" fill="#2a1a5e"/><path d="M19 38c6 10 20 10 26 0" stroke="#2a1a5e" stroke-width="3" fill="none" stroke-linecap="round"/>' },
  bolt: { label: "闪电", svg: '<path d="M36 4L12 36h16l-4 24 28-34H34z" fill="#ffe14d" stroke="#2a1a5e" stroke-width="3" stroke-linejoin="round"/>' },
  bow: { label: "蝴蝶结", svg: '<path d="M32 32L8 16v32zM32 32l24-16v32z" fill="#ff9eb5"/><circle cx="32" cy="32" r="7" fill="#ff7fa5"/>' },
  cat: { label: "猫", svg: '<path d="M12 28L10 8l14 8M52 28l2-20-14 8" fill="#fff" stroke="#6b4a55" stroke-width="2.5" stroke-linejoin="round"/><ellipse cx="32" cy="36" rx="23" ry="20" fill="#fff" stroke="#6b4a55" stroke-width="2.5"/><circle cx="23" cy="34" r="2.6" fill="#6b4a55"/><circle cx="41" cy="34" r="2.6" fill="#6b4a55"/><path d="M29 41q3 3 6 0" stroke="#6b4a55" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="17" cy="41" r="3.5" fill="#ffc2d1"/><circle cx="47" cy="41" r="3.5" fill="#ffc2d1"/>' },
  starface: { label: "星星", svg: '<path d="M32 4l8 18 20 2-15 13 5 20-18-11-18 11 5-20L4 24l20-2z" fill="#ffe08a" stroke="#e9b949" stroke-width="2" stroke-linejoin="round"/><circle cx="26" cy="30" r="2.2" fill="#6b4a55"/><circle cx="38" cy="30" r="2.2" fill="#6b4a55"/><path d="M29 36q3 3 6 0" stroke="#6b4a55" stroke-width="2" fill="none" stroke-linecap="round"/>' },
  heartp: { label: "粉色爱心", svg: `<path d="${HEART}" fill="#ffb3c6"/>` },
  berry: { label: "草莓", svg: '<path d="M32 58C14 50 8 36 12 24c4-8 36-8 40 0 4 12-2 26-20 34z" fill="#ff7f9a"/><path d="M20 20c4-8 8-10 12-10s8 2 12 10c-6 4-18 4-24 0z" fill="#8fd39a"/><g fill="#fff"><circle cx="24" cy="32" r="1.8"/><circle cx="34" cy="30" r="1.8"/><circle cx="42" cy="36" r="1.8"/><circle cx="28" cy="42" r="1.8"/><circle cx="36" cy="46" r="1.8"/></g>' },
  term: { label: "终端", svg: '<rect x="4" y="12" width="56" height="40" rx="5" fill="#0c120e" stroke="#7cffb2" stroke-width="2.5"/><path d="M14 26l8 6-8 6" stroke="#7cffb2" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 40h14" stroke="#ffb454" stroke-width="3" stroke-linecap="round"/>' },
  pxheart: { label: "像素爱心", svg: pixels([".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."], "#ff6b8b") },
  chipset: { label: "芯片", svg: '<rect x="16" y="16" width="32" height="32" rx="3" fill="#17241b" stroke="#7cffb2" stroke-width="2.5"/><g stroke="#7cffb2" stroke-width="2.5" stroke-linecap="round"><path d="M24 16V8M32 16V8M40 16V8M24 56v-8M32 56v-8M40 56v-8M16 24H8M16 32H8M16 40H8M56 24h-8M56 32h-8M56 40h-8"/></g><rect x="26" y="26" width="12" height="12" fill="#ffb454"/>' },
  braces: { label: "花括号", svg: '<rect x="4" y="12" width="56" height="40" rx="5" fill="#0c120e"/><path d="M24 20c-6 0-6 3-6 6s0 6-5 6c5 0 5 3 5 6s0 6 6 6M40 20c6 0 6 3 6 6s0 6 5 6c-5 0-5 3-5 6s0 6-6 6" stroke="#ffb454" stroke-width="3" fill="none" stroke-linecap="round"/>' },
  bug: { label: "虫子", svg: '<ellipse cx="32" cy="36" rx="14" ry="18" fill="#7cffb2"/><circle cx="32" cy="16" r="8" fill="#17241b"/><g stroke="#17241b" stroke-width="3" stroke-linecap="round"><path d="M18 28L8 22M18 38H6M18 48L8 54M46 28l10-6M46 38h12M46 48l10 6M32 22v30"/></g>' },
  postmark: { label: "邮戳", svg: '<circle cx="32" cy="32" r="27" fill="none" stroke="#b5402f" stroke-width="2.5"/><circle cx="32" cy="32" r="20" fill="none" stroke="#b5402f" stroke-width="1.5"/><path d="M16 32h32M18 26h28M18 38h28" stroke="#b5402f" stroke-width="1.5" stroke-linecap="round"/>' },
  stamp: { label: "邮票", svg: '<rect x="8" y="6" width="48" height="52" fill="#fff" stroke="#c9bfae" stroke-width="1.5" stroke-dasharray="3 3"/><rect x="13" y="11" width="38" height="42" fill="#f2b98a"/><circle cx="41" cy="23" r="5" fill="#fff3d6"/><path d="M13 53l12-22 8 12 6-8 12 18z" fill="#3d4f7a"/>' },
  mountain: { label: "山", svg: '<path d="M4 54L24 18l10 16 6-9 20 29z" fill="#3d4f7a"/><path d="M24 18l6 10-5 3-4-3-3 3z" fill="#fff"/>' },
  plane: { label: "纸飞机", svg: '<path d="M4 30L60 6 44 58 30 38z" fill="#fff" stroke="#3d4f7a" stroke-width="2.5" stroke-linejoin="round"/><path d="M30 38L60 6" stroke="#3d4f7a" stroke-width="2.5"/>' },
  compass: { label: "指南针", svg: '<circle cx="32" cy="32" r="26" fill="#fff" stroke="#3d4f7a" stroke-width="3"/><path d="M32 12l7 20h-14z" fill="#e58f6b"/><path d="M32 52l7-20h-14z" fill="#3d4f7a"/>' },
  moon: { label: "月亮", svg: '<path d="M44 52A24 24 0 0 1 30 8a20 20 0 1 0 22 30 24 24 0 0 1-8 14z" fill="#f6d98a"/>' },
};

export type Pack = { id: JournalStyle; label: string; names: string[] };

/** 一个风格一包，贴纸盘先开当前风格的那一包。 */
export const PACKS: Pack[] = [
  { id: "fresh", label: "小清新", names: ["leaf", "flower", "cloud", "sun", "cup", "sprout"] },
  { id: "y2k", label: "Y2K", names: ["spark", "heart", "disc", "smile", "spark2", "bolt"] },
  { id: "kawaii", label: "卡哇伊", names: ["cat", "bow", "starface", "heartp", "berry", "cloud"] },
  { id: "geek", label: "极客", names: ["term", "pxheart", "chipset", "braces", "bug"] },
  { id: "scenery", label: "风景", names: ["postmark", "stamp", "mountain", "plane", "compass", "moon"] },
];

/** 表情那一包里先摆出来的；别的可以自己输 */
export const EMOJI = ["😊", "🥰", "😴", "😭", "😤", "🎉", "✨", "🔥", "🌧️", "🌈", "🍜", "🍰", "☕", "🍺", "🐱", "🐶", "🌸", "🍂", "📚", "🎬", "🎧", "🏃", "✈️", "🏠"];

/** 画笔的颜色：当前风格的三种在前，后面是哪个风格都有的几种 */
export const PENS: Record<JournalStyle, string[]> = {
  fresh: ["#5f8f6e", "#d98f6a", "#6f8fb0"],
  y2k: ["#ff4fa3", "#7a5cff", "#12b5b0"],
  kawaii: ["#ff7fa5", "#6cc5b0", "#f2b84b"],
  geek: ["#7cffb2", "#ffb454", "#6cb6ff"],
  scenery: ["#ffffff", "#f6c992", "#26304a"],
};
export const COMMON_PENS = ["#26282b", "#e5484d", "#f5d90a"];

/** 笔的粗细（钢笔；荧光笔是它的四倍多） */
export const PEN_WIDTHS = [
  { id: "thin", label: "细", width: 1.6 },
  { id: "mid", label: "中", width: 2.8 },
  { id: "thick", label: "粗", width: 5 },
] as const;
export const MARKER = { scale: 4.5, opacity: 0.4 } as const;
/** 橡皮的半径（页面的逻辑像素） */
export const ERASER_REACH = 7;

/** 自己传的贴纸的地址（确认是这个人的之后跳到签名地址） */
export const myStickerUrl = (id: string) => `/media/journal/sticker/${id}`;
