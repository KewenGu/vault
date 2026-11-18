import { publicFetch, DownloadLimitError } from "@/lib/network/public-fetch";
import "server-only";
import sharp from "sharp";
import { explainFetchError } from "@/lib/fetch-error";
import { assertSafeUrl } from "@/lib/network/safe-url";
import { MOBILE_UA } from "@/lib/sources/link";
import type { RemoteFile } from "@/lib/sources/types";

/**
 * 收藏夹的文件处理：把平台 CDN 上的图片 / 视频下载下来（地址几小时就失效，必须转存）、统一图片格式。
 * 从视频里测切点、抽帧、拼帧格、抽音轨在看片模块 lib/video/digest/frames.ts（2026-10-12 搬过去，制作台每镜看片共用）。
 */

/**
 * 单个视频最多存档这么大（200 MB）。存储那边要跟上才存得进去：存储桶 vault 的单文件上限（迁移 20261118000001 设成了 200 MB），
 * 和 Supabase 项目的全局上传上限（控制台 Storage → Settings；免费套餐封顶 50 MB）。存不进去不算失败：
 * 照样读画面和声音，只是不留原片（见 workflows/process-item.ts 的 storeMedia）。
 * 这个数也是各平台读取器「挑哪一档清晰度」的上限：有多档的平台挑不超过它的最好一档。
 */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 图文最多转存 / 分析这么多张（小红书一篇最多 18 张，后面的多是补充） */
export const MAX_IMAGES = 12;

export class TooLargeError extends Error {
  constructor(readonly bytes: number | null) {
    super("文件太大");
    this.name = "TooLargeError";
  }
}

const MAX_HOPS = 5;

/** 凭据只留在完全相同的源；不能用最后两段域名判断公共后缀。 */
const siteOf = (url: string) => new URL(url).origin;

async function fetchOnce(url: string, maxBytes: number, timeoutMs: number, headers: Record<string, string> = {}): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // CDN 会跳去别的节点域名：不限域名，但每一跳都过一遍 SSRF 守卫（不许指向内网）
    if (!assertSafeUrl(current)) throw new Error("文件地址不安全，没有下载");
    // 额外的请求头（cookie、referer）只发给原来那个站；跳去别的站就不带了
    const extra = siteOf(current) === siteOf(url) ? headers : {};
    let res: Response;
    try {
      // timeoutMs 一定要传：publicFetch 自己有一个默认 20 秒的总时限，只给 signal 的话它照样在 20 秒时掐断——
      // 几十上百 MB 的视频 20 秒下不完（Vault 2026-11-18：127 MB 的抖音视频每次都「没下载下来」）。
      res = await publicFetch(current, { maxBytes, timeoutMs, headers: { "user-agent": MOBILE_UA, accept: "*/*", ...extra }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e instanceof DownloadLimitError) throw new TooLargeError(e.bytes);
      throw explainFetchError(e, `下载文件(${new URL(current).hostname})`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error("文件地址跳转到了空地址");
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`下载文件失败（${res.status}）`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new TooLargeError(declared);
    }
    // 边读边数：没报大小（或报小了）的也不会读超
    const reader = res.body?.getReader();
    if (!reader) throw new Error("下载文件失败（没有内容）");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TooLargeError(null);
      }
      chunks.push(value);
    }
    if (size === 0) throw new Error("下载文件失败（空文件）");
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
  throw new Error("文件地址跳转次数太多");
}

/** 下载一个远程文件：主地址不行就按顺序试备用地址。超过上限抛 TooLargeError（不再试别的地址）。 */
export async function downloadRemote(file: RemoteFile, maxBytes: number, timeoutMs = 120_000): Promise<Uint8Array> {
  if (file.bytes && file.bytes > maxBytes) throw new TooLargeError(file.bytes);
  let last: unknown = new Error("没有文件地址");
  for (const url of [file.url, ...(file.backupUrls ?? [])]) {
    try {
      return await fetchOnce(url, maxBytes, timeoutMs, file.headers);
    } catch (e) {
      if (e instanceof TooLargeError) throw e;
      last = e;
    }
  }
  throw last;
}

export type StoredImage = { data: Uint8Array; mime: "image/jpeg"; width: number; height: number };

/**
 * 图片统一成 JPEG（平台给的可能是 webp / heic / 动图封面，取第一帧）：长边最多 `maxEdge`，按 EXIF 摆正。
 * 存档用 2160（够做素材）；给模型看的另外缩（visionImage）。读不出来的抛错。
 */
export async function normalizeImage(data: Uint8Array, maxEdge = 2160, quality = 88): Promise<StoredImage> {
  const { data: out, info } = await sharp(Buffer.from(data))
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(out), mime: "image/jpeg", width: info.width, height: info.height };
}

/** 给模型看的图：长边 1024 的 JPEG（一张约 1000–1400 tokens），读字、看构图够用。 */
export async function visionImage(data: Uint8Array, maxEdge = 1024): Promise<Uint8Array> {
  return (await normalizeImage(data, maxEdge, 80)).data;
}
