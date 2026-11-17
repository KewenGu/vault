import { withPublicProxy } from "@/lib/network/public-proxy";
import { publicHttpUrl } from "@/lib/network/public-ip";
import "server-only";
import { nativeEnvironment, nativePythonSetupError, spawnNative, stopNativeProcess } from "@/lib/node/native-process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertFfmpegBinary, ffmpegPath, withTempDir } from "@/lib/media/ffmpeg";
import { TooLargeError } from "@/lib/media/files";
import { emptyStats, hashtagsIn, toCount, type SourcePlatform, type FetchedPost } from "./types";

/**
 * 本机的 yt-dlp（可选）：收藏夹用它认「别的视频站」的链接（B 站、Vimeo、微博视频…上千个站），读视频信息、把视频下下来。
 * 找的顺序：env YTDLP_PATH → 系统 PATH → 常见的安装位置（~/.local/bin、Homebrew）。没有 = 这类链接只按网页读文字
 * （部署在 Vercel 上就是这样）；小红书、抖音、TikTok、Instagram、X、YouTube 都不靠它。
 *
 * 只用认得的站点解析器（`--use-extractors default,-generic`）：普通网页约 1 秒就报「不认识」，不会去乱抓页面里的视频。
 */

const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

export function ytdlpPath(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env.YTDLP_PATH?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const dirs = [...(env.PATH ?? "").split(path.delimiter), path.join(env.HOME ?? os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  return null;
}

type RunResult = { code: number | null; stdout: string; stderr: string };

/** 跑一次 yt-dlp：stdout 最多留 32 MB（-J 的 JSON 可能有几百 KB），stderr 留末尾 8 KB；超时就杀掉。 */
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  publicHttpUrl(args.at(-1)!);
  return withPublicProxy((proxy) => new Promise((resolve, reject) => {
    const child = spawnNative(bin, ["--proxy", proxy, "--downloader", "native", "--downloader-args", "ffmpeg_i:-protocol_whitelist file,pipe,crypto,data", ...args], { ...nativeEnvironment(), NO_PROXY: "", no_proxy: "" });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopNativeProcess(child); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      size += d.byteLength;
      if (size <= 32 * 1024 * 1024) out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-8192);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      stopNativeProcess(child);
      reject(new Error(`yt-dlp 启动失败：${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      stopNativeProcess(child);
      if (timedOut || signal) return reject(new Error(timedOut ? "yt-dlp 跑太久被停掉了" : "yt-dlp 被意外停止"));
      const setupError = code !== 0 ? nativePythonSetupError("yt-dlp", stderr) : null;
      if (setupError) return reject(setupError);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr });
    });
  }));
}

const COMMON = ["--ignore-config", "--no-plugin-dirs", "--no-warnings", "--no-playlist", "--playlist-items", "1", "--use-extractors", "default,-generic", "--socket-timeout", "15"];

export type YtdlpInfo = {
  id: string;
  title: string;
  description: string;
  uploader: string;
  uploaderId: string | null;
  durationS: number | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  thumbnail: string | null;
  width: number | null;
  height: number | null;
  tags: string[];
  /** 哪个站点解析器认出来的（如 BiliBili、Vimeo） */
  extractor: string;
  isLive: boolean;
};

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const pos = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** `yt-dlp -J` 的输出 → 视频信息。不是一个视频（没有 id、合集里是空的）返回 null。 */
export function parseYtdlpInfo(raw: unknown): YtdlpInfo | null {
  let o = (raw && typeof raw === "object" ? raw : {}) as Obj;
  // 合集（一个链接下好几个视频）：取第一个
  if (o._type === "playlist") o = (Array.isArray(o.entries) && o.entries[0] && typeof o.entries[0] === "object" ? o.entries[0] : {}) as Obj;
  const id = str(o.id) || (typeof o.id === "number" ? String(o.id) : "");
  if (!id || (o._type !== undefined && o._type !== "video")) return null;
  const ts = pos(o.timestamp) ?? pos(o.release_timestamp);
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(str(o.upload_date));
  return {
    id,
    title: str(o.title).trim(),
    description: str(o.description).trim(),
    uploader: str(o.uploader) || str(o.channel) || str(o.creator),
    uploaderId: str(o.uploader_id) || str(o.channel_id) || null,
    durationS: pos(o.duration),
    publishedAt: ts ? new Date(ts * 1000).toISOString() : day ? `${day[1]}-${day[2]}-${day[3]}T00:00:00.000Z` : null,
    views: toCount(o.view_count),
    likes: toCount(o.like_count),
    comments: toCount(o.comment_count),
    shares: toCount(o.repost_count),
    thumbnail: str(o.thumbnail).startsWith("http") ? str(o.thumbnail) : null,
    width: pos(o.width),
    height: pos(o.height),
    tags: (Array.isArray(o.tags) ? o.tags : []).filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim()),
    extractor: str(o.extractor_key) || str(o.extractor),
    isLive: o.is_live === true || o.live_status === "is_live" || o.live_status === "is_upcoming",
  };
}

/** 视频信息 → 帖子：视频本体留给 yt-dlp 下（video.via = "ytdlp"，url 是页面地址）。 */
export function mapYtdlpInfo(info: YtdlpInfo, ref: { platform: SourcePlatform; externalId: string; url: string }): FetchedPost {
  const notes: string[] = ["读不到评论内容"];
  if (info.isLive) notes.push("这是一场直播，没有下载视频");
  return {
    platform: ref.platform,
    externalId: ref.externalId,
    kind: "video",
    title: info.title,
    text: Array.from(info.description).slice(0, 30_000).join(""),
    author: { id: info.uploaderId, name: info.uploader },
    publishedAt: info.publishedAt,
    stats: { ...emptyStats(), views: info.views, likes: info.likes, comments: info.comments, shares: info.shares },
    hashtags: [...new Set([...hashtagsIn(`${info.title}\n${info.description}`), ...info.tags])].slice(0, 15),
    topComments: [],
    images: info.thumbnail ? [{ url: info.thumbnail }] : [],
    video: info.isLive ? null : { url: ref.url, via: "ytdlp", width: info.width, height: info.height, bytes: null, durationS: info.durationS },
    music: null,
    notes,
  };
}

/**
 * 问 yt-dlp 这个链接是不是它认得的视频页。认得返回视频信息；不认得（普通网页）、视频读不到、本机没装都返回 null——
 * 调用方接着按网页读。
 */
export async function ytdlpInfo(url: string, timeoutMs = 45_000): Promise<YtdlpInfo | null> {
  const bin = ytdlpPath();
  if (!bin) return null;
  const { code, stdout } = await run(bin, ["-J", ...COMMON, "--", url], timeoutMs);
  if (code !== 0) return null;
  try {
    return parseYtdlpInfo(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/**
 * 挑哪一档下：不超过上限的最好画质（≤ 1080p）。有 ffmpeg 时可以把分开的画面 + 声音合成一个 mp4（画面留 72% 的额度，
 * 剩下给声音）；没有 ffmpeg 只能下本来就是一个文件的 mp4。大小未知的档放最后，由 --max-filesize 兜着。
 */
export const YTDLP_PROTOCOL_FILTER = '[protocol~="^(https?|http_dash_segments|m3u8_native)$"]';
const publicFormats = (formats: string[]) => formats.map((format) => format.split("+").map((part) => `${part}${YTDLP_PROTOCOL_FILTER}`).join("+")).join("/");

export function formatSelector(maxBytes: number, canMerge: boolean): string {
  const whole = `${Math.floor(maxBytes / 1e6)}M`;
  const part = `${Math.floor((maxBytes * 0.72) / 1e6)}M`;
  const single = [`b[ext=mp4][height<=1080][filesize<${whole}]`, `b[ext=mp4][height<=1080][filesize_approx<${whole}]`];
  if (!canMerge) return publicFormats([...single, "b[ext=mp4][height<=720]"]);
  return publicFormats([
    `bv*[vcodec^=avc1][height<=1080][filesize<${part}]+ba[ext=m4a]`,
    `bv*[vcodec^=avc1][height<=1080][filesize_approx<${part}]+ba[ext=m4a]`,
    ...single,
    `bv*[height<=1080][filesize<${part}]+ba`,
    `bv*[height<=1080][filesize_approx<${part}]+ba`,
    "b[height<=720]",
    "bv*[height<=720]+ba",
  ]);
}

/** 用 yt-dlp 把视频下下来（mp4）。超过上限抛 TooLargeError；本机没装 / 下不了抛普通错误。 */
export async function ytdlpDownload(url: string, maxBytes: number, timeoutMs = 240_000): Promise<Uint8Array> {
  const bin = ytdlpPath();
  if (!bin) throw new Error("这台机器没有 yt-dlp");
  const ffmpeg = ffmpegPath();
  if (ffmpeg) await assertFfmpegBinary(ffmpeg);
  return withTempDir(async (dir) => {
    const args = [
      ...COMMON,
      "-q",
      "--no-progress",
      "-f",
      formatSelector(maxBytes, ffmpeg !== null),
      "--max-filesize",
      String(maxBytes),
      ...(ffmpeg ? ["--ffmpeg-location", ffmpeg, "--merge-output-format", "mp4", "--remux-video", "mp4"] : []),
      "-o",
      path.join(dir, "dl.%(ext)s"),
      "--",
      url,
    ];
    const { code, stderr } = await run(bin, args, timeoutMs);
    const file = (await readdir(dir)).find((f) => f === "dl.mp4");
    if (!file) {
      if (/max-filesize|larger than/i.test(stderr)) throw new TooLargeError(null);
      // --max-filesize 拦下时 yt-dlp 不报错也不留文件
      if (code === 0) throw new TooLargeError(null);
      throw new Error(`yt-dlp 没下到视频：${stderr.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? `退出码 ${code}`}`);
    }
    const full = path.join(dir, file);
    const { size } = await stat(full);
    if (size > maxBytes) throw new TooLargeError(size);
    return new Uint8Array(await readFile(full));
  });
}
