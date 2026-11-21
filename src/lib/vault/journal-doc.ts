import { z } from "zod";
import { joinText, parseTranscript } from "@/lib/media/transcript";
import { isUuid } from "./map-nodes";

/**
 * 一页日记的内容（纯函数，服务器和编辑器共用）。一页有两层：
 *
 * - 正文层 blocks：文字、照片、录音，一块接一块往下排。照片和录音按 id 指着 journal_media 表里的一行。
 * - 手帐层 decos / strokes：贴纸、胶带、艺术字 / 手绘的笔画。每一件挂在一块正文上（anchor = 那一块的 id，
 *   位置是相对那一块左上角的坐标），正文改长了跟着走。第一期（2026-11-21）还没有手帐层的界面：格式先定在这里，
 *   保存时原样留着，等第二期接上。
 *
 * 页面固定 SHEET_WIDTH 宽、按屏幕等比缩放，所以坐标和字号都按这个宽度算，手机和电脑上排出来一样。
 * 传进来的东西（页面保存的、接口来的）先过 cleanDoc：不合格的块丢掉，超长的截断。
 */

/** 一页的逻辑宽度（CSS 像素）。360 = 常见手机里最窄的一档：整页铺满屏幕时不用缩小，输入框的字不会小于 16px（iOS 上小于 16px 的输入框一点就自动放大）。 */
export const SHEET_WIDTH = 360;

export const JOURNAL_STYLES = [
  { id: "fresh", label: "小清新" },
  { id: "y2k", label: "Y2K" },
  { id: "kawaii", label: "卡哇伊" },
  { id: "geek", label: "极客" },
  { id: "scenery", label: "风景" },
] as const;
export type JournalStyle = (typeof JOURNAL_STYLES)[number]["id"];
export const DEFAULT_STYLE: JournalStyle = "fresh";
export const cleanStyle = (raw: unknown): JournalStyle => JOURNAL_STYLES.find((s) => s.id === raw)?.id ?? DEFAULT_STYLE;
export const styleLabel = (style: JournalStyle) => JOURNAL_STYLES.find((s) => s.id === style)?.label ?? "";

export const MOODS = ["开心", "平静", "充实", "累", "低落", "烦躁"] as const;
export const WEATHERS = ["晴", "多云", "阴", "雨", "雪", "大风"] as const;
export const cleanMood = (raw: unknown): string => MOODS.find((m) => m === raw) ?? "";
export const cleanWeather = (raw: unknown): string => WEATHERS.find((w) => w === raw) ?? "";

export const JOURNAL_MAX = {
  title: 120,
  /** 一页最多这么多块 */
  blocks: 200,
  /** 一块文字最多这么多字 */
  text: 20_000,
  caption: 200,
  /** 一篇日记最多放这么多个文件（照片 + 录音） */
  media: 60,
  decos: 300,
  strokes: 600,
  /** 一笔最多这么多个点 */
  points: 4000,
} as const;

const cap = (t: string, n: number) => (t.length > n ? Array.from(t).slice(0, n).join("") : t);
const blockId = z.string().regex(/^[\w-]{1,40}$/);
const uuid = z.string().refine(isUuid);
const num = z.number().finite();

const textBlockSchema = z.object({ id: blockId, type: z.literal("text"), text: z.string() });
const photoBlockSchema = z.object({ id: blockId, type: z.literal("photo"), media: uuid, caption: z.string().default("") });
const audioBlockSchema = z.object({ id: blockId, type: z.literal("audio"), media: uuid });
const blockSchema = z.discriminatedUnion("type", [textBlockSchema, photoBlockSchema, audioBlockSchema]);
export type TextBlock = z.infer<typeof textBlockSchema>;
export type PhotoBlock = z.infer<typeof photoBlockSchema>;
export type AudioBlock = z.infer<typeof audioBlockSchema>;
export type Block = z.infer<typeof blockSchema>;

/** 手帐层的一件东西：kind = 是什么（sticker / tape / word…），data = 这一种自己的设定（哪张贴纸、什么字）。x / y 相对挂着的那一块的左上角，r 是转了多少度，s 是放大了多少倍。 */
const decoSchema = z.object({
  id: blockId,
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
  anchor: blockId,
  x: num,
  y: num,
  r: num.default(0),
  s: num.default(1),
  data: z.record(z.string().max(40), z.union([z.string().max(500), num, z.boolean()])).default({}),
});
/** 手绘的一笔：points 是 x、y 交替的一串坐标（相对挂着的那一块的左上角）。 */
const strokeSchema = z.object({
  id: blockId,
  anchor: blockId,
  color: z.string().regex(/^#[0-9a-f]{3,8}$/i),
  width: num.min(0.5).max(60),
  opacity: num.min(0.05).max(1).default(1),
  points: z.array(num).min(2).max(JOURNAL_MAX.points * 2),
});
export type Deco = z.infer<typeof decoSchema>;
export type Stroke = z.infer<typeof strokeSchema>;

export type JournalDoc = { v: 1; blocks: Block[]; decos: Deco[]; strokes: Stroke[] };

export const emptyDoc = (): JournalDoc => ({ v: 1, blocks: [], decos: [], strokes: [] });

function cleanList<T extends { id: string }>(raw: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const one of raw) {
    const r = schema.safeParse(one);
    if (!r.success || seen.has(r.data.id) || out.length >= max) continue;
    seen.add(r.data.id);
    out.push(r.data);
  }
  return out;
}

/** 把一份不知道哪来的内容收成合格的一页：认不出的块丢掉、id 重复的只留第一个、超长的截断；同一个文件只留在一块里。 */
export function cleanDoc(raw: unknown): JournalDoc {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const used = new Set<string>();
  const blocks = cleanList<Block>(o.blocks, blockSchema, JOURNAL_MAX.blocks).flatMap((b): Block[] => {
    if (b.type === "text") return [{ ...b, text: cap(b.text.replace(/\r\n?/g, "\n"), JOURNAL_MAX.text) }];
    if (used.has(b.media)) return [];
    used.add(b.media);
    return [b.type === "photo" ? { ...b, caption: cap(b.caption.replace(/\s+/g, " ").trim(), JOURNAL_MAX.caption) } : b];
  });
  return { v: 1, blocks, decos: cleanList<Deco>(o.decos, decoSchema, JOURNAL_MAX.decos), strokes: cleanList<Stroke>(o.strokes, strokeSchema, JOURNAL_MAX.strokes) };
}

export const cleanJournalTitle = (raw: unknown) => (typeof raw === "string" ? cap(raw.replace(/\s+/g, " ").trim(), JOURNAL_MAX.title) : "");

/** 这一页用到的文件（journal_media 的 id），按出现的顺序。 */
export const docMediaIds = (doc: JournalDoc): string[] => doc.blocks.flatMap((b) => (b.type === "text" ? [] : [b.media]));

/** 正文里的字（文字块和照片说明），一块一段。 */
export function docText(doc: JournalDoc): string {
  return doc.blocks
    .map((b) => (b.type === "text" ? b.text.trim() : b.type === "photo" ? b.caption : ""))
    .filter(Boolean)
    .join("\n");
}

/** 一个字都没写、一个文件都没放、手帐层也是空的。 */
export const isBlankDoc = (doc: JournalDoc) => docText(doc) === "" && docMediaIds(doc).length === 0 && doc.decos.length === 0 && doc.strokes.length === 0;

/** 列表上的一句摘要：正文开头的 n 个字。 */
export function excerpt(doc: JournalDoc, n = 90): string {
  const text = docText(doc).replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : text;
}

// ---------------------------------------------------------------- 日期

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 合格的日期（YYYY-MM-DD、真有这一天、1970–2199 年）原样返回；不是的返回 null。 */
export function cleanDay(raw: unknown): string | null {
  const m = typeof raw === "string" ? DAY.exec(raw) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1970 || y > 2199 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return raw as string;
}

export type DayParts = { year: number; month: number; date: number; weekday: number };

/** 拆开一个日期。weekday：0 = 周日。只按日历算，不涉及时区。 */
export function dayParts(day: string): DayParts {
  const m = DAY.exec(day);
  const [year, month, date] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1970, 1, 1];
  return { year, month, date, weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay() };
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEK_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTH_EN = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const pad = (n: number) => String(n).padStart(2, "0");

export const weekdayLabel = (day: string) => `周${WEEK_ZH[dayParts(day).weekday]}`;

/** 页眉上的日期，每个风格一种写法。 */
export function dayLabel(day: string, style: JournalStyle): string {
  const p = dayParts(day);
  switch (style) {
    case "y2k":
      return `${p.year}.${pad(p.month)}.${pad(p.date)} ✦ ${WEEK_EN[p.weekday]}`;
    case "kawaii":
      return `${p.month}月${p.date}日 星期${WEEK_ZH[p.weekday]} ♡`;
    case "geek":
      return `$ date +%F # ${p.year}-${pad(p.month)}-${pad(p.date)} ${WEEK_EN[p.weekday][0]}${WEEK_EN[p.weekday].slice(1).toLowerCase()}`;
    case "scenery":
      return `${MONTH_EN[p.month - 1]} ${p.date} · ${p.year}`;
    default:
      return `${p.month}月${p.date}日 · 周${WEEK_ZH[p.weekday]}`;
  }
}

/** 这个时刻在看的人当地是哪一天（浏览器里调；服务器上是服务器的时区，不要用它当「今天」）。 */
export const localDay = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

// ---------------------------------------------------------------- 录音转出来的文字

export type Cue = { at: number | null; text: string };

/** 存着的带时间的文字 → 一句句。 */
export const transcriptCues = (transcript: string | null): Cue[] => (transcript ? parseTranscript(transcript) : []);

/** 一句句连成一段能放进正文的字（中文之间不加空格，英文词之间加）。 */
export const cuesText = (cues: Cue[]): string => cues.reduce((all, c) => joinText(all, c.text.trim()), "");

// ---------------------------------------------------------------- 搜索

/** 搜索用的全部文字：标题、心情、天气、正文、照片说明、录音转出来的文字。 */
export function buildJournalSearchText(entry: { title: string; mood: string; weather: string; doc: JournalDoc }, transcripts: (string | null)[]): string {
  const said = transcripts.map((t) => cuesText(transcriptCues(t))).filter(Boolean);
  return [entry.title, entry.mood, entry.weather, docText(entry.doc), ...said].filter(Boolean).join("\n").slice(0, 400_000);
}

/** 搜索框里的一句话 → 要找的词（按空白拆，最多 6 个；都要出现才算找到）。 */
export function searchTerms(q: string): string[] {
  return [...new Set(q.trim().split(/\s+/).filter(Boolean))].slice(0, 6).map((t) => t.slice(0, 60));
}

/** 从全文里摘出第一个词出现的那一段（前后各带一点），列表上给人看「在哪儿找到的」。没出现过返回 null。 */
export function snippet(text: string, terms: string[], around = 36): string | null {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  if (hits.length === 0) return null;
  const at = Math.min(...hits);
  const from = Math.max(0, at - around);
  const to = Math.min(flat.length, at + around * 2);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
}

// ---------------------------------------------------------------- 要传的文件

export type JournalUploadPlan = { kind: "image" | "audio"; ext: string; mime: string };

const AUDIO_MIME_EXT: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/amr": "amr" };
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"]);
const AUDIO_EXT: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/opus", flac: "audio/flac", amr: "audio/amr", weba: "audio/webm" };

/**
 * 日记里收不收这个文件、算照片还是录音（只收这两样）。浏览器里录的音报的类型是 `audio/webm;codecs=opus` / `audio/mp4`，
 * 文件名是页面自己起的，所以先看类型；类型认不出（手机上常常是空的）再看扩展名。不收的返回原因（直接给用户看）。
 */
export function planJournalUpload(file: { name: string; mime: string; size: number }, maxBytes: number): JournalUploadPlan | { error: string } {
  if (!(file.size > 0)) return { error: "这是个空文件" };
  if (file.size > maxBytes) return { error: `文件太大（${Math.round(file.size / 1024 / 1024)} MB），单个文件最多 ${Math.round(maxBytes / 1024 / 1024)} MB` };
  const mime = file.mime.split(";")[0].trim().toLowerCase();
  const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  if (mime.startsWith("audio/")) return { kind: "audio", ext: AUDIO_MIME_EXT[mime] ?? (AUDIO_EXT[ext] ? ext : mime.slice(6).replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin"), mime };
  if (mime.startsWith("image/")) return { kind: "image", ext: IMAGE_EXT.has(ext) ? ext : mime.slice(6).replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin", mime };
  if (IMAGE_EXT.has(ext)) return { kind: "image", ext, mime: `image/${ext === "jpg" ? "jpeg" : ext}` };
  if (AUDIO_EXT[ext]) return { kind: "audio", ext, mime: AUDIO_EXT[ext] };
  return { error: "日记里只能放照片和录音" };
}
