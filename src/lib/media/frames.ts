import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { ffmpegPath, probeMedia, runFfmpeg, withTempDir, type MediaProbe } from "@/lib/media/ffmpeg";
import { clockTenths, gapBetween, type SpeechAt } from "./transcript";

/**
 * 看片模块的画面部分（docs/superpowers/specs/2026-10-07-studio-video-directions-design.md 一 ⑥）：测切点、抽帧、拼帧格、抽音轨。
 * 收藏夹拆别人的视频和制作台验自己生成的每一镜共用（2026-10-12 从 lib/favorites/media.ts 搬过来，行为不变）。
 *
 * 2026-10-11 参考 Hypit 拆视频的办法改了抽帧（不用它的代码）：
 * - 先测切点（ffmpeg 的 scene 分数），帧优先抽在每个新镜头的开头，剩下的名额再均匀补——以前固定时间点抽，镜头切了也看不出来；
 * - 几帧拼成「帧格」（contactSheets），每格下面标时间、是不是刚切镜、那一刻正在说的话——模型一眼看全片，画面和口播对得上。
 */

/**
 * 一个视频抽多少帧给模型看：一分钟以内 8 张；越长越多（3 分钟内 12、10 分钟内 16、再长 20）——长视频只看 8 张，
 * 中间讲了什么基本看不到。一张约 800–1400 tokens，20 张也就两三万 tokens。
 */
export function frameBudget(durationS: number): number {
  if (!(durationS > 60)) return 8;
  if (durationS <= 180) return 12;
  return durationS <= 600 ? 16 : 20;
}

/**
 * 抽帧的时间点：开头 3 秒密一点（钩子在这儿：0.2 / 1.5 / 3 秒），后面在全片里均匀取，一共最多 `max` 张
 * （不传就按时长定，见 frameBudget）。短视频（几秒）自然少几张；时间点不超过结尾前 0.2 秒。
 */
export function frameTimes(durationS: number, max = frameBudget(durationS)): number[] {
  if (!(durationS > 0)) return [0];
  const end = Math.max(0, durationS - 0.2);
  const hook = [0.2, 1.5, 3].filter((t) => t <= end);
  const rest = Math.max(0, max - hook.length);
  const from = 3;
  const spread = end > from + 1 ? Array.from({ length: rest }, (_, i) => from + ((end - from) * (i + 1)) / (rest + 0.5)) : [];
  const all = [...hook, ...spread].map((t) => Math.round(Math.min(t, end) * 10) / 10);
  // 去掉挨得太近的（不到 0.8 秒）
  const out: number[] = [];
  for (const t of all) if (out.length === 0 || t - out[out.length - 1] >= 0.8) out.push(t);
  return out.length > 0 ? out : [0];
}

/** 一个切点：画面在第 at 秒换了镜头；score 是 ffmpeg 的 scene 分数（0–1，前后两帧差多少，硬切通常 0.5 以上）。 */
export type Cut = { at: number; score: number };

/** 相邻两帧差到这个分数一定算切镜：0.3 是常用值——硬切基本都过。 */
export const SCENE_THRESHOLD = 0.3;
/**
 * 不到 0.3、但比前后一秒明显跳一下的也算切镜：分数至少这么多、而且是前后一秒中位数的 SCENE_PEAK_RATIO 倍。
 * 2026-10-12 复刻「猫猫骑士」：雾里两个镜头颜色差不多，7.1 / 12.5 / 23.3 秒的硬切只有 0.24 / 0.25 / 0.20，前后是 0.02 上下；
 * 大幅运镜、打斗的抖动是连着一片高分，单独冒出来的尖才是切镜（那条片子里最高的非切点是 0.18，周围也都在 0.1 上下）。
 */
export const SCENE_FLOOR = 0.12;
export const SCENE_PEAK_RATIO = 4;
/** 最多记这么多切点（快剪的长视频可能上千），多了留分数高的。 */
const MAX_CUTS = 300;

/**
 * 解析 ffmpeg `metadata=print:key=lavfi.scene_score` 写出的文件（纯函数）：每帧两行——
 * `frame:0 pts:25600 pts_time:2` 和 `lavfi.scene_score=0.694200`。时间取到 0.1 秒（一镜常常不到一秒，再细没意义）；
 * 同一个 0.1 秒里多个只留分数最高的；开头 0.1 秒内的不算（第一帧）；分数是 0 的不要；按时间排。是每 0.1 秒的分数，不是切点（见 pickCuts）。
 */
export function parseSceneScores(text: string): Cut[] {
  const byTime = new Map<number, number>();
  for (const m of text.matchAll(/pts_time:\s*(-?\d+(?:\.\d+)?)[^\n]*\n\s*lavfi\.scene_score=(\d+(?:\.\d+)?)/g)) {
    const at = Math.round(Number(m[1]) * 10) / 10;
    const score = Math.round(Number(m[2]) * 1000) / 1000;
    if (!(at > 0.1) || !(score > 0)) continue;
    byTime.set(at, Math.max(byTime.get(at) ?? 0, score));
  }
  return Array.from(byTime, ([at, score]) => ({ at, score })).sort((a, b) => a.at - b.at);
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 每 0.1 秒的分数 → 切点（纯函数）：过 SCENE_THRESHOLD 的，加上过 SCENE_FLOOR 且是前后一秒中位数 SCENE_PEAK_RATIO 倍的尖；
 * 0.5 秒内的几个只留分最高的（一次切镜常常连着两三帧都高）；超过 MAX_CUTS 留分高的；按时间排。
 */
export function pickCuts(scores: Cut[]): Cut[] {
  const sorted = [...scores].sort((a, b) => a.at - b.at);
  const candidates = sorted.filter((s, i) => {
    if (s.score >= SCENE_THRESHOLD) return true;
    if (s.score < SCENE_FLOOR) return false;
    const around: number[] = [];
    for (let j = i - 1; j >= 0 && s.at - sorted[j].at <= 1; j--) around.push(sorted[j].score);
    for (let j = i + 1; j < sorted.length && sorted[j].at - s.at <= 1; j++) around.push(sorted[j].score);
    return s.score >= SCENE_PEAK_RATIO * median(around);
  });
  const merged: Cut[] = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && c.at - last.at < 0.5) {
      if (c.score > last.score) merged[merged.length - 1] = c;
    } else merged.push(c);
  }
  const kept = merged.length > MAX_CUTS ? [...merged].sort((a, b) => b.score - a.score).slice(0, MAX_CUTS) : merged;
  return kept.sort((a, b) => a.at - b.at);
}

/** 测一个视频的切点：缩到 160 宽再比（只看大的变化，快十几倍），每帧的分数写进临时文件，解析后挑切点（pickCuts）；每 0.1 秒的分数也带回去（找动作快的段用）。 */
export async function detectCuts(input: string, dir: string): Promise<{ cuts: Cut[]; scores: Cut[] }> {
  const file = path.join(dir, "scenes.txt");
  await runFfmpeg(
    ["-hide_banner", "-loglevel", "error", "-i", input, "-an", "-vf", `scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=${file}`, "-f", "null", "-"],
    { timeoutMs: 180_000 }
  );
  const scores = parseSceneScores(await readFile(file, "utf8").catch(() => ""));
  return { cuts: pickCuts(scores), scores };
}

/**
 * 动作最快的几段（2026-10-13，查身体部位变形用）：复刻「猫猫骑士」时龙头 0.25 秒里糊成一只爪子，每秒 4 帧的帧格里前后两格都拍到了，
 * Claude 一次看二十几格还是漏了；把那 0.7 秒按 0.1 秒一张单独给它、让它逐张跟着每个角色的头和四肢看，一次就指出来了，动作快但没变形的一段（翻滚）也没误报。
 * 这种错只出在动作快的地方——画面变化快 = 每 0.1 秒的 scene 分数加起来大。挑法（纯函数）：每个 0.7 秒的窗口把里面没到切镜线的分数加起来，
 * 窗口里或前后 0.15 秒内有切点的不要（切镜不是变形），太平静的（< MOTION_FLOOR）不要，按加起来的分从大到小挑互不重叠的 n 段，按时间排。
 * 那条片子 6 镜实测（160 宽）：变形那段 1.9–2.6 秒 0.096 是那一镜最高的；静的特写镜最高 0.07，打斗镜 0.4–1.2。
 */
export const MOTION_WINDOWS = 2;
export const MOTION_SPAN_S = 0.7;
export const MOTION_STEP_S = 0.1;
export const MOTION_FLOOR = 0.03;
export type MotionWindow = { from: number; to: number; energy: number };

export function motionWindows(scores: Cut[], cuts: Cut[], durationS: number, n = MOTION_WINDOWS): MotionWindow[] {
  const tenth = (x: number) => Math.round(x * 10) / 10;
  const all: MotionWindow[] = [];
  for (let from = 0; tenth(from + MOTION_SPAN_S) <= durationS - 0.05; from = tenth(from + MOTION_STEP_S)) {
    const to = tenth(from + MOTION_SPAN_S);
    if (cuts.some((c) => c.at >= from - 0.15 && c.at <= to + 0.15)) continue;
    const energy = Math.round(scores.filter((s) => s.at > from && s.at <= to && s.score < SCENE_THRESHOLD).reduce((a, s) => a + s.score, 0) * 1000) / 1000;
    if (energy >= MOTION_FLOOR) all.push({ from, to, energy });
  }
  const picked: MotionWindow[] = [];
  for (const w of [...all].sort((a, b) => b.energy - a.energy || a.from - b.from)) {
    if (picked.length >= n) break;
    if (picked.every((p) => w.to <= p.from || w.from >= p.to)) picked.push(w);
  }
  return picked.sort((a, b) => a.from - b.from);
}

export type PlannedFrame = { at: number; cut: boolean };

/** 补空档时，两帧之间的空档短于这么多秒就不再往里补 */
const FILL_MIN_GAP = 4;
/** 两帧至少隔这么久 */
const MIN_SPACING = 0.8;

/**
 * 有切点时的抽帧计划：开头 3 秒的三张照旧（钩子），切点附近的时间点换成切后的那一帧（cut = true）；然后每个切点后 0.3 秒
 * 一张（镜头短于 0.6 秒取它的中点），名额不够时留分数高的；还有名额就反复把最长的空档从中间劈开补一张，空档都短于
 * 4 秒为止——没有切点的长镜头（口播）照样看得到中间。没有切点就是原来的 frameTimes。张数不超过 max，相邻至少隔 0.8 秒。
 */
export function planFrames(durationS: number, cuts: Cut[], max = frameBudget(durationS)): PlannedFrame[] {
  if (!(durationS > 0)) return [{ at: 0, cut: false }];
  if (cuts.length === 0) return frameTimes(durationS, max).map((at) => ({ at, cut: false }));
  const end = Math.max(0, durationS - 0.2);
  const round = (t: number) => Math.round(t * 10) / 10;
  const sorted = cuts.filter((c) => c.at > 0.1 && c.at <= end).sort((a, b) => a.at - b.at);
  const reps = sorted.map((c, i) => {
    const next = sorted[i + 1]?.at ?? end;
    return { at: round(Math.min(c.at + Math.min(0.3, (next - c.at) / 2), end)), score: c.score };
  });
  const picks: PlannedFrame[] = [];
  // 间隔按 0.1 秒的整数比（2.3 - 1.5 在浮点里是 0.7999…，直接比会把隔了 0.8 秒的当成太近）
  const tenths = (t: number) => Math.round(t * 10);
  const apart = (a: number, b: number) => Math.abs(tenths(a) - tenths(b)) >= tenths(MIN_SPACING);
  const far = (t: number) => picks.every((p) => apart(p.at, t));
  const used = new Set<number>();
  for (const hook of [0.2, 1.5, 3].filter((t) => t <= end)) {
    // 这个时间点附近刚好有切点（不到 0.8 秒）：就取切后那一帧（差不多的位置，但知道它是新镜头的开头）
    const near = reps.find((r) => !used.has(r.at) && !apart(r.at, hook));
    const at = near ? near.at : hook;
    if (!far(at) || picks.length >= max) continue;
    picks.push({ at, cut: near !== undefined });
    if (near) used.add(near.at);
  }
  for (const r of [...reps].sort((a, b) => b.score - a.score)) {
    if (picks.length >= max) break;
    if (used.has(r.at) || !far(r.at)) continue;
    picks.push({ at: r.at, cut: true });
    used.add(r.at);
  }
  while (picks.length < max) {
    const bounds = [...picks.map((p) => p.at).sort((a, b) => a - b), end];
    let best = -1;
    let bestGap = FILL_MIN_GAP;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const gap = bounds[i + 1] - bounds[i];
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best === -1) break;
    const mid = round((bounds[best] + bounds[best + 1]) / 2);
    if (!far(mid)) break;
    picks.push({ at: mid, cut: false });
  }
  return picks.sort((a, b) => a.at - b.at);
}

/**
 * 均匀抽帧：每秒 perSecond 帧，取每一小段的中点（每秒一帧是第 0.5、1.5、2.5…秒），不超过结尾前 0.1 秒；
 * 上一帧到这一帧之间切过镜的标「切」。
 * - 每镜看片（spec 一 ⑥）：试做的教训是三秒一帧的缩略图漏过人类婴儿；2026-10-12 复刻「猫猫骑士」，龙头在 0.25 秒里变成爪子，
 *   每秒一帧取到的前后两帧单看都合理——看片改成每秒 4 帧（一镜 4–15 秒，16–60 张）。
 * - 收藏夹的全片一览：短视频每秒一帧，长的放稀（见 overviewStep）。
 */
export function everyStep(durationS: number, cuts: Cut[], perSecond = 1): PlannedFrame[] {
  const step = 1 / perSecond;
  if (!(durationS > step / 2)) return [{ at: 0, cut: false }];
  const out: PlannedFrame[] = [];
  for (let k = 0; (k + 0.5) * step <= durationS - 0.1; k++) {
    const at = Math.round((k + 0.5) * step * 1000) / 1000;
    out.push({ at, cut: cuts.some((c) => c.at > at - step && c.at <= at) });
  }
  return out;
}

/** 每镜看片每秒几帧 */
export const REVIEW_FPS = 4;

/** 全片一览隔几秒一帧：一分钟以内每秒一帧，再长的放稀到一共不超过 60 格。 */
export function overviewStep(durationS: number): number {
  return durationS <= 60 ? 1 : Math.ceil(durationS / 60);
}

export type VideoDigest = {
  probe: MediaProbe;
  /** 切点（按时间排）；测不出来（ffmpeg 出错 / 超时）是空——那就按固定时间点抽 */
  cuts: Cut[];
  /** 抽出来的帧（JPEG，长边 ≤ 1024）；cut = 这一帧是一个新镜头的开头 */
  frames: { at: number; cut: boolean; data: Uint8Array; width: number; height: number }[];
  /** 全片一览（opts.overview）：均匀铺满全片的小图（长边 ≤ 480，拼帧格用），隔 overviewStep 秒一张；没要是空 */
  overview: { at: number; cut: boolean; data: Uint8Array }[];
  /** 动作最快的几段（opts.motion，见 motionWindows）：每段隔 0.1 秒一张（长边 ≤ 640）；没要 / 没测出切点分数 / 太平静是空 */
  motion: { from: number; to: number; frames: { at: number; data: Uint8Array }[] }[];
  /** 音轨（单声道 16 kHz mp3，最多前 `audioMaxSeconds` 秒）；没有音轨为 null */
  audio: { data: Uint8Array; seconds: number } | null;
};

/** 这台机器能不能抽帧（要 ffmpeg；部署在 Vercel 上没有）。 */
export const canDigestVideo = () => ffmpegPath() !== null;

/**
 * 把一个视频拆成「切点 + 几帧画面（张数按时长定，见 frameBudget；位置见 planFrames；perSecond = 每秒均匀抽几帧，见 everyStep）
 * + 全片一览（overview）+ 一条音轨（audio: false 不要）」。要 ffmpeg（没有就别调，见 canDigestVideo）。
 * 切点测不出来不算失败（按固定时间点抽）；单帧抽不出来（时间点超了结尾）跳过；一帧都没有 / 文件读不出抛错。
 */
export async function digestVideo(
  video: Uint8Array,
  ext: string,
  opts: { maxFrames?: number; audioMaxSeconds?: number; detectCuts?: boolean; perSecond?: number; overview?: boolean; motion?: boolean; audio?: boolean } = {}
): Promise<VideoDigest> {
  const audioMax = opts.audioMaxSeconds ?? 600;
  return withTempDir(async (dir) => {
    const input = path.join(dir, `in.${ext.replace(/[^\w]/g, "") || "mp4"}`);
    await writeFile(input, video);
    const probe = await probeMedia(input);
    let cuts: Cut[] = [];
    let scores: Cut[] = [];
    if (opts.detectCuts !== false) {
      try {
        ({ cuts, scores } = await detectCuts(input, dir));
      } catch (e) {
        console.warn(`看片：切点没测出来，按固定时间点抽帧（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    // -ss 放 -i 前面：先跳到附近关键帧再解到那一刻；缩到长边 edge（保持比例，宽高取偶数）。取不到（时间点超了结尾）返回 null
    const grab = async (at: number, name: string, edge: number): Promise<Uint8Array | null> => {
      const out = path.join(dir, name);
      try {
        await runFfmpeg(
          ["-hide_banner", "-loglevel", "error", "-ss", at.toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale='if(gt(iw,ih),min(${edge},iw),-2)':'if(gt(iw,ih),-2,min(${edge},ih))'`, "-q:v", "4", "-y", out],
          { timeoutMs: 60_000 }
        );
        return new Uint8Array(await readFile(out));
      } catch {
        return null;
      }
    };
    const frames: VideoDigest["frames"] = [];
    const plan = opts.perSecond ? everyStep(probe.duration, cuts, opts.perSecond) : planFrames(probe.duration, cuts, opts.maxFrames);
    for (const [i, { at, cut }] of plan.entries()) {
      const data = await grab(at, `f${i}.jpg`, 1024);
      if (!data) continue;
      const meta = await sharp(Buffer.from(data)).metadata().catch(() => null);
      if (meta) frames.push({ at, cut, data, width: meta.width ?? 0, height: meta.height ?? 0 });
    }
    if (frames.length === 0) throw new Error("视频里一帧画面都取不出来（文件可能坏了）");
    const overview: VideoDigest["overview"] = [];
    if (opts.overview) {
      for (const [i, { at, cut }] of everyStep(probe.duration, cuts, 1 / overviewStep(probe.duration)).entries()) {
        const data = await grab(at, `o${i}.jpg`, 480);
        if (data) overview.push({ at, cut, data });
      }
    }
    const motion: VideoDigest["motion"] = [];
    if (opts.motion) {
      for (const [w, { from, to }] of motionWindows(scores, cuts, probe.duration).entries()) {
        const frames: VideoDigest["motion"][number]["frames"] = [];
        for (let k = 0; Math.round((from + k * MOTION_STEP_S) * 10) / 10 <= to; k++) {
          const at = Math.round((from + k * MOTION_STEP_S) * 10) / 10;
          const data = await grab(at, `m${w}-${k}.jpg`, 640);
          if (data) frames.push({ at, data });
        }
        if (frames.length >= 2) motion.push({ from, to, frames });
      }
    }
    let audio: VideoDigest["audio"] = null;
    if (probe.hasAudio && opts.audio !== false) {
      const out = path.join(dir, "a.mp3");
      try {
        await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", input, "-t", String(audioMax), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", out], { timeoutMs: 120_000 });
        audio = { data: new Uint8Array(await readFile(out)), seconds: Math.min(probe.duration, audioMax) };
      } catch {
        // 音轨导不出来：当没有
      }
    }
    return { probe, cuts, frames, overview, motion, audio };
  });
}

/** 帧格里的一格：一帧画面 + 它的时间、是不是刚切镜、那一刻说的话（speechAt 的结果；没有口播是 null）。 */
export type SheetTile = { at: number; cut?: boolean; data: Uint8Array; speech?: SpeechAt | null };
export type ContactSheet = { data: Uint8Array; width: number; height: number; tiles: number; from: number; to: number };

/** 帧格的版式：竖版视频 4 列 × 2 行（9:16 的格），横版 3 列 × 3 行（16:9 的格）；整张约 1040 宽，模型按原样看得清。 */
export function sheetLayout(portrait: boolean) {
  return portrait ? { cols: 4, rows: 2, tileW: 250, tileH: 444, span: 14 } : { cols: 3, rows: 3, tileW: 336, tileH: 189, span: 20 };
}
const SHEET_GAP = 8;
const LABEL_H = 52;
const FONT = "PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Noto Sans SC, Microsoft YaHei, sans-serif";
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 几帧拼成帧格（JPEG）：每格是一帧（按比例放进格子，不裁），下面两行字——时间（刚切镜的带「切」）、那一刻说的话
 * （正说到的词用亮色）。一张装不下就分几张，每张一行说明里写它盖的时间范围。字用系统字体画（sharp 的 SVG 渲染，
 * Mac 上有苹方；没有中文字体的机器上会是方块——那一行字同时也写在给模型的说明里，不影响拆解）。
 */
export async function contactSheets(tiles: SheetTile[], portrait: boolean): Promise<ContactSheet[]> {
  const { cols, rows, tileW, tileH } = sheetLayout(portrait);
  const per = cols * rows;
  const out: ContactSheet[] = [];
  for (let start = 0; start < tiles.length; start += per) {
    const page = tiles.slice(start, start + per);
    const pageRows = Math.ceil(page.length / cols);
    const width = cols * tileW + (cols + 1) * SHEET_GAP;
    const height = pageRows * (tileH + LABEL_H) + (pageRows + 1) * SHEET_GAP;
    const layers: OverlayOptions[] = [];
    const labels: string[] = [];
    for (const [i, tile] of page.entries()) {
      const x = SHEET_GAP + (i % cols) * (tileW + SHEET_GAP);
      const y = SHEET_GAP + Math.floor(i / cols) * (tileH + LABEL_H + SHEET_GAP);
      const img = await sharp(Buffer.from(tile.data)).resize(tileW, tileH, { fit: "contain", background: "#1a1a1e" }).jpeg({ quality: 85 }).toBuffer();
      layers.push({ input: img, left: x, top: y });
      const time = `${clockTenths(tile.at)}${tile.cut ? "  ·  切" : ""}`;
      const s = tile.speech;
      const now = s?.now || "｜";
      const speech = s ? `${esc(s.before)}${gapBetween(s.before, now)}<tspan fill="#C99A4E" font-weight="600">${esc(now)}</tspan>${gapBetween(now, s.after)}${esc(s.after)}` : "";
      // 每格的字放在自己的 <svg> 里：超出格子宽度的部分裁掉
      labels.push(
        `<svg x="${x}" y="${y + tileH}" width="${tileW}" height="${LABEL_H}"><text x="6" y="19" font-family="${FONT}" font-size="14" fill="${tile.cut ? "#7BA7C9" : "#85858E"}">${esc(time)}</text>` +
          (speech ? `<text x="6" y="41" font-family="${FONT}" font-size="15" fill="#E4E4E7">${speech}</text>` : "") +
          `</svg>`
      );
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels.join("")}</svg>`;
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
    const data = await sharp({ create: { width, height, channels: 3, background: "#131316" } })
      .composite(layers)
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    out.push({ data: new Uint8Array(data), width, height, tiles: page.length, from: page[0].at, to: page[page.length - 1].at });
  }
  return out;
}
