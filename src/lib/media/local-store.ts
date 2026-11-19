import "server-only";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * 留在这台服务器磁盘上的原片（2026-11-19）：超过存档上限、存储桶存不下的视频，读完画面和声音之后不删，搬到这里，
 * 页面直接从磁盘播放。等 Supabase 换了付费套餐、存档上限调高之后，再从这里搬去存储桶。
 *
 * - 放在 `VAULT_LOCAL_MEDIA_DIR`（Docker 里是卷上的 /data/media；没设就是运行目录下的 .vault-media）。
 * - 目录结构和存储桶一样：`<用户>/<内容 id>/video.mp4`。items.media 里那一项的 path 还是这个相对路径，另带 `local: true`。
 * - 不限总量、不自动清理。磁盘满了，新的大视频会下载失败（页面上写原因），到时候手动删或者搬走。
 * - 只在这一台机器上：换机器、卷丢了就没了，页面上播不出来；读出来的画面和口播在数据库和存储桶里，不受影响。
 */
export function localMediaRoot(env: Record<string, string | undefined> = process.env): string {
  // turbopackIgnore：这是运行时才知道的数据目录，不是要打进包里的项目文件（不加的话构建会把整个项目都算进产物）
  return path.resolve(/* turbopackIgnore: true */ env.VAULT_LOCAL_MEDIA_DIR?.trim() || ".vault-media");
}

/** 相对路径（和存储桶里的一样）→ 磁盘上的绝对路径。每一段只许字母数字、下划线、连字符和点，不许点开头（挡掉 `..`）；不合规返回 null。 */
export function localMediaPath(storagePath: string): string | null {
  const parts = storagePath.split("/");
  if (parts.length < 2 || parts.some((p) => !/^[\w-][\w.-]*$/.test(p))) return null;
  return path.join(/* turbopackIgnore: true */ localMediaRoot(), ...parts);
}

/** 把一个文件（刚下载到临时目录的）搬进来，返回它的新位置。同一个盘是改名；跨盘（容器里 /tmp 和卷不是一个盘）是复制再删。 */
export async function keepLocalFile(from: string, storagePath: string): Promise<string> {
  const dest = localMediaPath(storagePath);
  if (!dest) throw new Error("文件路径不合规");
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await rename(from, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    try {
      await copyFile(from, dest);
    } catch (copyError) {
      // 多半是磁盘满了：别留半个文件
      await rm(dest, { force: true }).catch(() => {});
      throw copyError;
    }
    await rm(from, { force: true }).catch(() => {});
  }
  return dest;
}

/** 这个文件在磁盘上有多大；不在（清过磁盘、换了机器）返回 null。 */
export async function localFileSize(storagePath: string): Promise<number | null> {
  const file = localMediaPath(storagePath);
  if (!file) return null;
  try {
    const s = await stat(/* turbopackIgnore: true */ file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** 删掉一条内容留在磁盘上的文件（整个目录）。best-effort：删不掉只留痕。 */
export async function removeLocalItemFiles(userId: string, id: string): Promise<void> {
  const dir = localMediaPath(`${userId}/${id}`);
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch((e) => console.error(`删除本机原片失败 ${userId}/${id}: ${e instanceof Error ? e.message : String(e)}`));
}

export type LocalMediaUsage = { dir: string; files: number; bytes: number; freeBytes: number | null };

/** 磁盘上留了多少原片、这个盘还剩多少（状态页用）。目录还没建过就是 0 个文件。 */
export async function localMediaUsage(): Promise<LocalMediaUsage> {
  const root = localMediaRoot();
  let files = 0;
  let bytes = 0;
  const names = (dir: string) => readdir(dir).catch(() => [] as string[]);
  for (const user of await names(root)) {
    for (const item of await names(path.join(root, user))) {
      for (const name of await names(path.join(root, user, item))) {
        const s = await stat(path.join(root, user, item, name)).catch(() => null);
        if (s?.isFile()) {
          files++;
          bytes += s.size;
        }
      }
    }
  }
  // 目录还没建时，看它上面最近一层已有的目录在哪个盘上
  let freeBytes: number | null = null;
  for (let dir = root; ; dir = path.dirname(dir)) {
    try {
      const fs = await statfs(dir);
      freeBytes = fs.bavail * fs.bsize;
      break;
    } catch {
      if (path.dirname(dir) === dir) break;
    }
  }
  return { dir: root, files, bytes, freeBytes };
}

/**
 * 解析 Range 请求头（纯函数）。浏览器播视频、拖进度条全靠它（Safari 没有分段响应干脆不播）。
 * 返回要给的那一段；null = 没有 / 看不懂（多段的也算），给整个文件；"unsatisfiable" = 起点超出了文件。
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    // bytes=-N：最后 N 个字节
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : "unsatisfiable";
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return end < start ? null : { start, end };
}

/** 把磁盘上的一个文件发给浏览器，支持分段请求。文件不在返回 null（调用方回 404）。归属由调用方先确认。 */
export async function localFileResponse(request: Request, storagePath: string, mime: string): Promise<Response | null> {
  const file = localMediaPath(storagePath);
  const size = await localFileSize(storagePath);
  if (!file || size === null) return null;
  const headers = { "content-type": mime, "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  // 空文件没有可读的范围
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(/* turbopackIgnore: true */ file, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { ...headers, "content-length": String(size === 0 ? 0 : end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
  });
}
