import { inflateRawSync } from "node:zlib";

/**
 * 测试用：把一个 zip 读回来（从末尾的结束记录找到目录，再按目录去读每个文件）。和写入器（lib/vault/zip.ts）是分开写的两份逻辑：
 * 目录里的偏移、长度、压缩方式有一处写错，这里就读不出来或者内容对不上。
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error("末尾不是 zip 的结束记录");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`目录的第 ${i + 1} 项不对`);
    const method = view.getUint16(p + 10, true);
    const packed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`${name} 的偏移没有指着文件头`);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const body = bytes.subarray(start, start + packed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    if (data.length !== size) throw new Error(`${name} 解开后的长度不对`);
    files.set(name, data);
    p += 46 + nameLen;
  }
  return files;
}

export const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
};

export const text = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : "");
