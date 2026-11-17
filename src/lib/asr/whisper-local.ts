import "server-only";
import { nativeEnvironment, nativePythonSetupError, spawnNative, stopNativeProcess } from "@/lib/node/native-process";
import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Cue } from "@/lib/media/transcript";
import { assertFfmpegBinary, ffmpegPath, FfmpegMissingError, withTempDir } from "@/lib/media/ffmpeg";

/**
 * 本机的 Whisper（可选）：收藏夹转写口播的备用通道——豆包语音识别没配 / 没开通时，用这台机器上的
 * openai-whisper 命令行（`pip install openai-whisper` 或 `brew install openai-whisper`）转，不花钱、音频不出本机。
 *
 * - 找命令的顺序：env WHISPER_PATH → 系统 PATH → 常见的安装位置（~/.local/bin、Homebrew）。
 * - **只在模型文件已经在本机时才用**：whisper 第一次跑会自己去下模型（turbo 约 1.5 GB），后台任务里不该悄悄下这么大的东西。
 *   模型目录是 env WHISPER_MODEL_DIR，默认 `~/.cache/whisper`；env WHISPER_MODEL 指定用哪个，不指定就用目录里最好的那个。
 * - 部署在 Vercel 上没有这个命令：那边只有豆包语音识别这一条路。
 * - 2026-10-05：命令行参数和输出的 JSON 形状按 openai-whisper 20250625 写的。
 */

const exe = process.platform === "win32" ? "whisper.exe" : "whisper";

/** 模型名 → 模型文件名，按效果从好到差（不指定 WHISPER_MODEL 时按这个顺序找第一个在的） */
const MODELS: [name: string, file: string][] = [
  ["turbo", "large-v3-turbo.pt"],
  ["large-v3", "large-v3.pt"],
  ["large-v2", "large-v2.pt"],
  ["medium", "medium.pt"],
  ["small", "small.pt"],
  ["base", "base.pt"],
  ["tiny", "tiny.pt"],
];

// Official checkpoints, pinned to openai/whisper 86098128c0b4f24f0e2aa2994de830614b474227.
// Whisper's normal name-based loader re-downloads a file whose digest is wrong.
// Verify before starting it so a truncated local model cannot trigger a hidden download.
const MODEL_SHA256: Record<string, string> = {
  turbo: "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a",
  "large-v3": "e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb",
  "large-v2": "81f7c96c852ee8fc832187b0132e569d6c3065a3252ed18e56effd0b6a73e524",
  medium: "345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1",
  small: "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794",
  base: "ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e",
  tiny: "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9",
};

type Env = Record<string, string | undefined>;

export function whisperPath(env: Env = process.env): string | null {
  const fromEnv = env.WHISPER_PATH?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const dirs = [...(env.PATH ?? "").split(path.delimiter), path.join(env.HOME ?? os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  return null;
}

const modelDir = (env: Env) => env.WHISPER_MODEL_DIR?.trim() || path.join(env.XDG_CACHE_HOME?.trim() || path.join(env.HOME ?? os.homedir(), ".cache"), "whisper");

export type LocalWhisper = { bin: string; model: string; modelDir: string };

/** Stream the checkpoint rather than putting a multi-GB model into Node's heap. */
export async function verifyWhisperModel(w: LocalWhisper): Promise<void> {
  const file = MODELS.find(([name]) => name === w.model)?.[1];
  if (!file) throw new Error("whisper 模型不受支持，请选择已核对的官方模型");
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path.join(w.modelDir, file))) hash.update(chunk);
  } catch {
    throw new Error("whisper 模型文件无法读取，请先在终端检查或重新下载模型");
  }
  if (hash.digest("hex") !== MODEL_SHA256[w.model]) {
    throw new Error("whisper 模型文件不完整或校验不符，已停止转写；请先在终端重新下载官方模型");
  }
}

/** 这台机器能不能用 whisper 转写：命令在、模型文件也在才算。 */
export function localWhisper(env: Env = process.env): LocalWhisper | null {
  const bin = whisperPath(env);
  if (!bin) return null;
  const dir = modelDir(env);
  const wanted = env.WHISPER_MODEL?.trim();
  const found = MODELS.filter(([name]) => !wanted || name === wanted).find(([, file]) => existsSync(path.join(dir, file)));
  return found ? { bin, model: found[0], modelDir: dir } : null;
}

/** 命令装了、模型文件不在：告诉用户差哪一步（没装命令返回 null——那是没打算用）。 */
export function whisperSetupHint(env: Env = process.env): string | null {
  if (!whisperPath(env) || localWhisper(env)) return null;
  const model = env.WHISPER_MODEL?.trim() || "turbo";
  const home = env.HOME ?? os.homedir();
  const dir = modelDir(env);
  const shown = home && dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
  // 模型目录是自己指定的：下的时候也要指到那儿，不然 whisper 下到它默认的目录，这边还是找不到
  const command = `whisper --model ${model}${env.WHISPER_MODEL_DIR?.trim() ? ` --model_dir ${dir}` : ""} 一段音频`;
  return `本机装了 whisper 但没有模型文件（在终端跑一次 \`${command}\`，它会把模型下到 ${shown}${model === "turbo" ? "，约 1.5 GB" : ""}；之后重新分析就用它转写）`;
}

/** Whisper 在没人说话的片段（片头音乐、静音）上常编出来的话：整句丢掉。 */
const HALLUCINATION = /字幕由|字幕志愿者|字幕组|字幕提供|Amara\.org|请不吝点赞|明镜与点点|谢谢观看|感谢观看|thanks? for watching|subtitles by|subscribe to (my|our) channel/i;

/**
 * 没人说话的片段上，whisper 还会把开场提示（ZH_PROMPT）原样或拆碎了吐回来（2026-10-12 复刻「猫猫骑士」：没台词、只有吼声风声的镜听出
 * 「用简体中文，带标点符号。」「并且使用简体中文，的符号。」，看片的帧格把它当台词标在画面下面，Claude 报了「画面里有字幕」）。
 * 去掉标点后六成以上的字落在「提示里也连着出现的两个字」上，就当是吐回来的提示，整段丢掉。纯函数。
 */
export function echoesPrompt(text: string, prompt: string = ZH_PROMPT): boolean {
  const strip = (s: string) => s.replace(/[\p{P}\s]/gu, "");
  const chars = Array.from(strip(text));
  const source = strip(prompt);
  if (chars.length === 0) return false;
  const covered = new Array<boolean>(chars.length).fill(false);
  for (let i = 0; i + 1 < chars.length; i++) {
    if (source.includes(chars[i] + chars[i + 1])) covered[i] = covered[i + 1] = true;
  }
  return covered.filter(Boolean).length / chars.length >= 0.6;
}

export type WhisperResult = { cues: Cue[]; language: string | null };

type WhisperWord = { word?: unknown; start?: unknown; end?: unknown };

/** 一段里的逐词（`--word_timestamps True` 才有：`words[].word / start / end`）：都带时间的才算。 */
function wordsOf(seg: { words?: unknown }): Cue["words"] {
  const words = (Array.isArray(seg.words) ? (seg.words as WhisperWord[]) : []).filter((w) => typeof w?.word === "string" && w.word.trim());
  if (words.length === 0) return undefined;
  if (!words.every((w) => typeof w.start === "number" && typeof w.end === "number" && w.end >= w.start)) return undefined;
  return words.map((w) => ({ at: w.start as number, end: w.end as number, text: (w.word as string).trim() }));
}

/**
 * 解析 whisper `--output_format json` 的输出：`segments[].start / .end / .text`，带逐词时间的段多一个 words
 * （OpenAI whisper-1 的 verbose_json 也是这个形状）。编出来的套话、吐回来的开场提示丢掉。认不出来的形状抛错，不悄悄给空。
 */
export function parseWhisperJson(raw: unknown): WhisperResult {
  const o = (raw && typeof raw === "object" ? raw : null) as { segments?: unknown; language?: unknown } | null;
  if (!o || !Array.isArray(o.segments)) throw new Error("whisper 输出的内容认不出来（没有 segments）");
  const cues: WhisperResult["cues"] = [];
  for (const seg of o.segments as { start?: unknown; end?: unknown; text?: unknown; words?: unknown }[]) {
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text || HALLUCINATION.test(text) || echoesPrompt(text)) continue;
    // 同一句连着重复（whisper 卡住时的样子）只留一句
    if (cues.length > 0 && cues[cues.length - 1].text === text) continue;
    const at = typeof seg.start === "number" && seg.start >= 0 ? seg.start : (cues.at(-1)?.at ?? 0);
    const cue: Cue = { at, text };
    if (typeof seg.end === "number" && seg.end >= at) cue.end = seg.end;
    const words = wordsOf(seg);
    if (words) cue.words = words;
    cues.push(cue);
  }
  return { cues, language: typeof o.language === "string" ? o.language : null };
}

/** 中文口播给 whisper 的开场提示：带标点的简体中文（不给的话常出繁体、整段没有标点）。 */
export const ZH_PROMPT = "以下是普通话的句子，使用简体中文，带标点符号。";

/** whisper 的命令行参数（纯函数，单测断言）。language 给了就不让它自己猜语言。 */
export function whisperArgs(w: LocalWhisper, audioPath: string, outDir: string, language: "zh" | null): string[] {
  return [
    audioPath,
    "--model",
    w.model,
    "--model_dir",
    w.modelDir,
    "--output_format",
    "json",
    "--output_dir",
    outDir,
    "--task",
    "transcribe",
    "--verbose",
    "False",
    // 在 CPU 上跑（Mac 没有 CUDA）：半精度不支持，明说省得每次打警告
    "--fp16",
    "False",
    // 逐词的时间（帧格标词用）：多花一点时间，输出里每段多一个 words
    "--word_timestamps",
    "True",
    ...(language === "zh" ? ["--language", "zh", "--initial_prompt", ZH_PROMPT] : []),
  ];
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnNative(bin, args, env);
    child.stdout.resume();
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopNativeProcess(child); }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4096);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      stopNativeProcess(child);
      reject(new Error(`whisper 启动失败：${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      stopNativeProcess(child);
      if (timedOut || signal) return reject(new Error(timedOut ? "whisper 跑太久被停掉了" : "whisper 被意外停止"));
      const setupError = code !== 0 ? nativePythonSetupError("whisper", stderr) : null;
      if (setupError) return reject(setupError);
      resolve({ code, stderr });
    });
  });
}

/**
 * 用本机的 whisper 转写一段音频（mp3）。seconds 是音频时长，用来定超时（在 CPU 上跑，给到时长的 4 倍，至少 5 分钟）。
 * language：知道是中文就传 "zh"（出简体、带标点）；不知道传 null，让 whisper 听前 30 秒自己判断。
 */
export async function transcribeLocally(w: LocalWhisper, audio: Uint8Array, seconds: number, language: "zh" | null): Promise<WhisperResult> {
  await verifyWhisperModel(w);
  return withTempDir(async (dir) => {
    const input = path.join(dir, "audio.mp3");
    await writeFile(input, audio);
    // whisper 自己要调 ffmpeg 解码：把我们找到的那个 ffmpeg 所在目录放到 PATH 最前面
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) throw new FfmpegMissingError();
    await assertFfmpegBinary(ffmpeg);
    const env = { ...nativeEnvironment(), PATH: [ffmpeg ? path.dirname(ffmpeg) : "", process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
    const { code, stderr } = await run(w.bin, whisperArgs(w, input, dir, language), env, Math.max(300_000, Math.ceil(seconds) * 4000));
    const out = path.join(dir, "audio.json");
    if (code !== 0 || !existsSync(out)) {
      const last = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
      throw new Error(`whisper 没转出来（退出码 ${code}）${last ? `：${last.slice(0, 160)}` : ""}`);
    }
    return parseWhisperJson(JSON.parse(await readFile(out, "utf8")));
  });
}
