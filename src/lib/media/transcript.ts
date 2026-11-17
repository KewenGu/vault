/**
 * 带时间的口播文字 / 字幕（2026-10-05，收藏夹；2026-10-12 搬到看片模块 lib/video/digest，收藏夹和制作台的看片共用）。存进 favorites.transcript 的是一段段文字，每段开头是它开始的时间：
 * `[1:05] ……`。模型据此在拆解里标时间（「1:05 讲第二点」），页面上点时间能跳到视频的那一刻。
 * 之前存的口播文字没有时间：整段当一段读。
 *
 * 2026-10-11 加「锚在词上」：识别结果里有逐字 / 逐词的起止时间时（豆包的 words、本机 whisper 的 --word_timestamps）带着，
 * 抽出来的每一帧就能标上「那一刻正在说到哪个词」（speechAt）——画面和口播对得上，拆解才说得清「说到 X 时画面切到 Y」。
 */

/** 一个词（中文是一个字）和它的起止时间（秒）。 */
export type Word = { at: number; end: number; text: string };
/** 一句话和它开始的时间（秒）；end / words 是识别通道给了才有。 */
export type Cue = { at: number; text: string; end?: number; words?: Word[] };

/** 秒 → `分:秒`（过一小时写 `时:分:秒`）。 */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** 一帧画面给模型的说明：开头几秒是钩子，精确到 0.1 秒（「视频第 1.5 秒」）；后面和口播文字用同一种时间写法（「视频 1:05」）。 */
export const frameCaption = (at: number) => (at < 10 ? `视频第 ${at} 秒` : `视频 ${clock(at)}`);

/** 秒 → `分:秒.十分之一秒`（`0:03.2`）：切点列表、帧格上的时间用，比 clock 多一位——一个镜头常常不到一秒。 */
export const clockTenths = (seconds: number) => `${clock(seconds)}.${Math.floor((Math.max(0, seconds) * 10) % 10)}`;

/**
 * 一帧画面给模型的完整说明：时间 + 是不是刚切的镜头 + 那一刻说的话（words 是 speechLabel 的写法：【】里是正说到的词，｜是停顿的位置）。
 * 「视频 1:05 · 刚切镜 · 说到：…【三个】办法…」
 */
export function frameNote(frame: { at: number; cut?: boolean; words?: string | null }): string {
  const parts = [frameCaption(frame.at)];
  if (frame.cut) parts.push("刚切镜");
  if (frame.words) parts.push(`说到：${frame.words}`);
  return parts.join(" · ");
}

const CLOCK = /(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?!\d)/;

/** 文字里的第一个时间（`1:05`、`0:00–0:20`、`1:02:03`）→ 秒；没有时间（「第 3 张图」、空）是 null。 */
export function parseClock(text: string): number | null {
  const m = CLOCK.exec(text);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// 中日韩文字和全角标点（。，！？「」…）
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;
/** 两段字中间要不要空格：中日韩文字之间不要，其余（英文词之间、英文和中文之间）要一个。 */
export const gapBetween = (a: string, b: string) => (a && b && !(CJK.test(a.slice(-1)) && CJK.test(b[0])) ? " " : "");
/** 两句接起来：中日韩文字之间不加空格，其余加一个。 */
export const joinText = (a: string, b: string) => a + gapBetween(a, b) + b;

const SENTENCE_END = /[.!?。！？…]["'”’)）」]?$/;
/** 一段最多这么久：语音识别出来的中文常常没有标点，等不到句末，就按时间换段 */
const PARAGRAPH_MAX_S = 45;

/**
 * 一句句的字幕 / 识别结果 → 带时间的段落。一段约 300 字或 30 秒、到句末换段；最长 600 字 / 45 秒。
 * 页面上好读，提示词里也省地方（不用每句都带时间）。
 */
export function cuesToText(cues: Cue[], maxChars = Number.POSITIVE_INFINITY): string {
  const paragraphs: string[] = [];
  let cur = "";
  let start = 0;
  const flush = () => {
    if (cur) paragraphs.push(`[${clock(start)}] ${cur}`);
    cur = "";
  };
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (cur && cue.at - start >= PARAGRAPH_MAX_S) flush();
    if (!cur) start = cue.at;
    cur = joinText(cur, text);
    if (cur.length >= 600 || (SENTENCE_END.test(cur) && (cur.length >= 300 || cue.at - start >= 30))) flush();
  }
  flush();
  const all = paragraphs.join("\n");
  return Number.isFinite(maxChars) ? Array.from(all).slice(0, maxChars).join("") : all;
}

/** 第 t 秒正在说的话：前面的几个字、正说到的词（停顿时为空）、后面的几个字。 */
export type SpeechAt = { before: string; now: string; after: string };

/** 一个「说话单位」：中文一个字、英文一个词（标点跟着前一个单位），和它的起止时间。 */
type Unit = Word;

/** 一句没有逐词时间的话拆成单位：中日韩文字一个字一个单位，其余按空白分词；标点跟在前一个单位后面。 */
function splitUnits(text: string): string[] {
  const out: string[] = [];
  let latin = "";
  const flushLatin = () => {
    if (latin) out.push(latin);
    latin = "";
  };
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) {
      flushLatin();
    } else if (/[\p{P}\p{S}]/u.test(ch) && !/[\u3400-\u9fff]/.test(ch)) {
      // 标点跟着前面的单位（没有前面的就自己一个）
      if (latin) latin += ch;
      else if (out.length > 0) out[out.length - 1] += ch;
      else out.push(ch);
    } else if (CJK.test(ch)) {
      flushLatin();
      out.push(ch);
    } else {
      latin += ch;
    }
  }
  flushLatin();
  return out;
}

/** 估一个单位说多久：中文一个字约 0.25 秒，英文一个词约 0.35 秒（没有逐词时间时按这个把一句话均摊到它的时长上）。 */
const unitSeconds = (u: string) => (CJK.test(u[0]) ? 0.25 : 0.35);

/**
 * 一句句的识别结果 → 带起止时间的说话单位。有逐词时间的直接用；没有的把这句均摊到 [开始, 结束) 上——
 * 结束时间：识别给的 end，没有就下一句的开始，最后一句按字数估。
 */
export function speechUnits(cues: Cue[]): Unit[] {
  const out: Unit[] = [];
  const sorted = [...cues].filter((c) => c.text.trim()).sort((a, b) => a.at - b.at);
  for (const [i, cue] of sorted.entries()) {
    const timed = (cue.words ?? []).filter((w) => w.text.trim() && w.end >= w.at);
    if (timed.length > 0) {
      out.push(...timed.map((w) => ({ at: w.at, end: w.end, text: w.text.trim() })));
      continue;
    }
    const units = splitUnits(cue.text);
    if (units.length === 0) continue;
    const weights = units.map(unitSeconds);
    const estimated = weights.reduce((a, b) => a + b, 0);
    const next = sorted[i + 1]?.at;
    const end = cue.end !== undefined && cue.end > cue.at ? cue.end : next !== undefined && next > cue.at ? Math.min(next, cue.at + estimated * 2) : cue.at + estimated;
    const scale = (end - cue.at) / estimated;
    let t = cue.at;
    for (const [j, u] of units.entries()) {
      const d = weights[j] * scale;
      out.push({ at: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100, text: u });
      t += d;
    }
  }
  return out;
}

/** 几个单位接成一句：中日韩文字之间不加空格，其余加一个（和 joinText 一致）。 */
const joinUnits = (units: string[]) => units.reduce((all, u) => joinText(all, u), "");
const chars = (s: string) => Array.from(s).length;

/** 前后文只取离这一刻 5 秒以内说的话：再远的（下一句隔了半分钟）放进来是误导 */
const CONTEXT_WINDOW_S = 5;

/**
 * 第 t 秒正在说的话：正说到的词（now）和它前后各几个字，一共约 span 个字，只取 5 秒以内的；两头还有话没放下的加 …。
 * 离最近的话超过 1 秒（还没开口、说完了、长停顿）是 null；1 秒内的停顿 now 是空的，before / after 是停顿两边的话。
 * 帧格上的字标、每帧给模型的说明都用它：画面和口播对上，拆解才能写「说到 X 时画面是 Y」。
 */
export function speechAt(cues: Cue[], t: number, span = 14): SpeechAt | null {
  const units = speechUnits(cues);
  if (units.length === 0) return null;
  const GAP = 1;
  let i = units.findIndex((u) => u.end > t);
  let now = "";
  if (i === -1) {
    if (t - units[units.length - 1].end > GAP) return null;
    i = units.length;
  } else if (units[i].at <= t) {
    now = units[i].text;
  } else if (units[i].at - t > GAP && (i === 0 || t - units[i - 1].end > GAP)) {
    return null;
  }
  const after: string[] = [];
  const before: string[] = [];
  const room = Math.max(0, span - chars(now));
  let a = i + (now ? 1 : 0);
  let b = i - 1;
  const canAfter = () => a < units.length && units[a].at - t <= CONTEXT_WINDOW_S;
  const canBefore = () => b >= 0 && t - units[b].end <= CONTEXT_WINDOW_S;
  let used = 0;
  // 前后各分一半；一边没有了（开头 / 结尾 / 太远）让给另一边
  while (used < room && (canAfter() || canBefore())) {
    if ((after.length <= before.length && canAfter()) || !canBefore()) after.push(units[a++].text);
    else before.unshift(units[b--].text);
    used = chars(joinUnits(before)) + chars(joinUnits(after));
  }
  return { before: `${canBefore() ? "…" : ""}${joinUnits(before)}`, now, after: `${joinUnits(after)}${canAfter() ? "…" : ""}` };
}

/** speechAt 的结果写成一行字（存进帧的 words、给模型看）：【】里是正说到的词；停顿时用 ｜ 标停顿的位置。英文词之间留空格。 */
export const speechLabel = (s: SpeechAt) => joinText(joinText(s.before, s.now ? `【${s.now}】` : "｜"), s.after);

/** 存着的口播文字 → 一段段（at = 这段开始的秒数；没有时间的旧数据 at 是 null）。 */
export function parseTranscript(text: string): { at: number | null; text: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/.exec(line);
      return m ? { at: parseClock(m[1]), text: m[2] } : { at: null, text: line };
    });
}

/**
 * 口播大概率是不是中文（本机 whisper 用：知道是中文就指定语言，出简体、带标点；不知道让它自己听）。
 * 国内平台直接算；别的平台看标题和文案——汉字（一个字算一个）占了「汉字 + 其他语言的词」的三成以上、又没有假名（日文）才算。
 * 按词算不按字母算：中文标题里夹几个英文词（「我的 morning routine 分享」）还是中文。
 */
export function likelyChinese(platform: string, text: string): boolean {
  if (platform === "xiaohongshu" || platform === "douyin") return true;
  const clean = text.replace(/https?:\/\/\S+/g, "");
  if (/[\u3040-\u30ff]/.test(clean)) return false;
  const han = clean.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const words = clean.replace(/[\u3400-\u9fff]/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return han >= 2 && han / (han + words) >= 0.3;
}
