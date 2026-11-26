import { clock } from "@/lib/media/transcript";

/**
 * 划线和批注（item_notes 表）：用户在一条收藏的内容上自己留下的东西。一条笔记 = 划下来的一段原话（quote）和 / 或
 * 他自己写的话（body），可以带着那段话在视频 / 音频里的时间（at）。
 *
 * 这是他自己的话，不是外部内容——但拼进提示词时照样放在标签里、按资料对待（见 ask.ts）。
 * 这个文件服务端和浏览器都用，不要引只能在服务端跑的东西。
 */

export const NOTE_MAX = { quote: 2000, body: 4000, perItem: 200 } as const;

export type ItemNote = {
  id: string;
  itemId: string;
  /** 划下来的那段原话；只写了想法、没划线的是空 */
  quote: string;
  /** 自己写的话；只划线、没写的是空 */
  body: string;
  /** 那段话在视频 / 音频里的时间（秒）；不是从带时间的地方划的是 null */
  at: number | null;
  createdAt: string;
  updatedAt: string;
};

const cap = (t: string, n: number) => Array.from(t).slice(0, n).join("");

/** 划下来的话：浏览器选中的文字常常带着排版留下的换行和多余的空白，压成一行 */
export const cleanQuote = (raw: unknown) => (typeof raw === "string" ? cap(raw.replace(/\s+/g, " ").trim(), NOTE_MAX.quote) : "");
/** 自己写的话：换行留着（三行以上的空行压成一行），前后的空白去掉 */
export const cleanBody = (raw: unknown) => (typeof raw === "string" ? cap(raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), NOTE_MAX.body) : "");
/** 时间：要是个不小于 0 的数（秒），不然当没有 */
export const cleanAt = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw < 360_000 ? Math.round(raw * 100) / 100 : null);

/** 一条笔记写成一行给模型 / 导出看的文字：「划线（1:05）：「……」——批注：……」 */
export function noteLine(note: Pick<ItemNote, "quote" | "body" | "at">): string {
  const at = note.at === null ? "" : `（${clock(note.at)}）`;
  const body = note.body.replace(/\s*\n\s*/g, " ");
  if (note.quote && body) return `划线${at}：「${note.quote}」——他写的：${body}`;
  return note.quote ? `划线${at}：「${note.quote}」` : `他写的${at}：${body}`;
}

/** 一条内容上的所有笔记拼成搜索 / 向量用的文字（划的话和写的话都算） */
export const notesIndexText = (notes: Pick<ItemNote, "quote" | "body">[]): string =>
  notes
    .flatMap((n) => [n.quote, n.body])
    .filter(Boolean)
    .join("\n");
