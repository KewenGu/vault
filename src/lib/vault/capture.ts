import { createHash } from "node:crypto";
import { extractShareUrl, platformOfHost } from "@/lib/sources/link";
import type { ItemMedia, PostKind } from "@/lib/sources/types";

/**
 * 「存进来的是什么」的判断（纯函数）：一段粘贴的文字是链接还是文字；一个要上传的文件收不收、算哪一类。
 */

export type Capture = { kind: "link"; url: string } | { kind: "text"; text: string };

/** 不认得的网站：链接之外还带着这么多字以内算「标题 + 链接」；再多就是一篇顺带提到链接的文字 */
const WEB_BLURB_MAX = 300;
/**
 * 认得的平台（抖音、小红书…）：App 里「复制链接」得到的是「口令 + 整段文案 + 链接」，文案可以有上千字
 * （抖音的文案上限是 1000 字），所以放得很宽。2026-11-18：一条带长文案的抖音分享按 300 字的线会被当成文字存。
 */
const PLATFORM_BLURB_MAX = 3000;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/**
 * 粘贴的内容是一条链接（含 App 分享出来的「一段话 + 链接」），还是一段文字。
 * 文字里顺带提到链接的（笔记、聊天记录）按文字存：链接只是内容的一部分。空的返回 null。
 */
export function classifyCapture(input: string): Capture | null {
  const text = input.trim();
  if (!text) return null;
  const url = extractShareUrl(text);
  if (url) {
    const rest = text.replace(/https?:\/\/[\x21-\x7e]+/gi, "").trim();
    const links = text.match(/https?:\/\/[\x21-\x7e]+/gi)?.length ?? 1;
    const max = platformOfHost(hostOf(url)) ? PLATFORM_BLURB_MAX : WEB_BLURB_MAX;
    if (links <= 1 && Array.from(rest).length <= max) return { kind: "link", url };
  }
  return { kind: "text", text };
}

/**
 * 存入框有「内容」和「备注」两格。只填了备注那一格的，把它当内容存（纯函数）：
 * 2026-11-18 第一次真实使用，分享文案就被贴进了备注格，得到一句「没有内容」。
 */
export function captureFields(input: string, note: string): { input: string; note: string } {
  return input.trim() ? { input, note } : { input: note, note: "" };
}

/** 文字内容的去重键：空白差异不算不同（同一段话多贴了个换行还是同一条） */
export function textDedupeKey(text: string): string {
  return `text:${createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex")}`;
}

export const fileDedupeKey = (sha256: string) => `file:${sha256.toLowerCase()}`;

/** 单个上传文件的上限（存储桶单文件上限，也是处理时读进内存的上限） */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export type UploadPlan = { kind: PostKind; ext: string; mime: string };

const EXT_KIND: Record<string, { kind: PostKind; mime: string }> = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  avif: { kind: "image", mime: "image/avif" },
  heic: { kind: "image", mime: "image/heic" },
  heif: { kind: "image", mime: "image/heif" },
  mp4: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  m4v: { kind: "video", mime: "video/x-m4v" },
  webm: { kind: "video", mime: "video/webm" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  wav: { kind: "audio", mime: "audio/wav" },
  aac: { kind: "audio", mime: "audio/aac" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  opus: { kind: "audio", mime: "audio/opus" },
  flac: { kind: "audio", mime: "audio/flac" },
  amr: { kind: "audio", mime: "audio/amr" },
  txt: { kind: "text", mime: "text/plain" },
  md: { kind: "text", mime: "text/markdown" },
};

/**
 * 一个要上传的文件收不收、算哪一类。按扩展名认（浏览器报的 MIME 不可靠，手机上常常是空的），
 * 扩展名认不出时再看 MIME 的大类。不收的返回原因（直接给用户看）。
 */
export function planUpload(file: { name: string; mime: string; size: number }): UploadPlan | { error: string } {
  if (!(file.size > 0)) return { error: "这是个空文件" };
  if (file.size > UPLOAD_MAX_BYTES) return { error: `文件太大（${Math.round(file.size / 1024 / 1024)} MB），单个文件最多 ${UPLOAD_MAX_BYTES / 1024 / 1024} MB` };
  const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const known = EXT_KIND[ext];
  if (known) return { kind: known.kind, ext, mime: known.mime };
  const major = file.mime.split("/")[0];
  if (major === "image" || major === "video" || major === "audio") {
    const sub = file.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 5).toLowerCase() || "bin";
    return { kind: major, ext: sub, mime: file.mime };
  }
  return { error: "暂时只收图片、截图、视频、音频和纯文字文件（PDF 等文档还不支持）" };
}

/** 文件名去掉扩展名，当初始标题（理解完会换成模型起的）。 */
export function titleFromFilename(name: string): string {
  return Array.from(name.replace(/\.[a-z0-9]{1,5}$/i, "").trim()).slice(0, 80).join("");
}

/** 浏览器直传的文件放在内容目录下的这个名字（处理时认它：图片 / 文字会被换成处理后的样子，视频 / 音频原样留着） */
export const uploadPath = (dir: string, ext: string) => `${dir}/upload.${ext}`;

/** 上传的文件登记进 items.media 的形状（建条目时就登记，浏览器传完再开始处理）。 */
export function uploadedMedia(kind: PostKind, path: string, mime: string, bytes: number): ItemMedia {
  const role = kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
  return { role, path, mime, width: null, height: null, bytes, ...(role === "image" ? {} : { durationS: null }) };
}
