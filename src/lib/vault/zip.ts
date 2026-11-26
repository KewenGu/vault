import { deflateRawSync } from "node:zlib";

/**
 * 最小的 zip 写入器（整库导出用，见 export.ts）：一个文件一个文件地加，每加一个就吐出它那一段字节，最后吐出目录。
 * 可以边生成边发给浏览器，内存里只留当前这一个文件和目录。自己写而不是引一个库：要的只是 zip 里最基本的那部分。
 *
 * 只做了这些：deflate 压缩（压了反而变大的原样存）、UTF-8 文件名、文件夹靠路径里的「/」。
 * 没做 zip64：整个包不能超过 4 GB、文件不能超过 65,535 个——导出的只有文字，到不了；超了直接报错，不生成一个坏的包。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32（zip 用的那一种）。自己算，不依赖 node:zlib 的 crc32（Node 22.2 才有）。 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
/** 文件名是 UTF-8（通用标志位的第 11 位） */
const FLAG_UTF8 = 0x0800;
const STORE = 0;
const DEFLATE = 8;

/** zip 里的时间是 MS-DOS 的格式：没有时区（按 UTC 写），精确到 2 秒，最早 1980 年 */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

type Entry = { name: Uint8Array; method: number; time: number; date: number; crc: number; packed: number; size: number; offset: number };

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private readonly seen = new Set<string>();

  /** 已经加了几个文件 */
  get count(): number {
    return this.entries.length;
  }

  /** 加一个文件，返回要写出去的那一段（文件头 + 内容）。同一个路径加两次、超过 zip 的上限会抛错。 */
  add(path: string, content: string | Uint8Array, at: Date = new Date()): Uint8Array {
    if (this.seen.has(path)) throw new Error(`zip 里已经有这个文件了: ${path}`);
    if (this.entries.length >= MAX_ENTRIES) throw new Error("文件太多，超过了 zip 的上限（65,535 个）");
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const deflated = deflateRawSync(data);
    const method = deflated.length < data.length ? DEFLATE : STORE;
    const body = method === DEFLATE ? deflated : data;
    const name = new TextEncoder().encode(path);
    const { time, date } = dosDateTime(at);
    const crc = crc32(data);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // 解开需要的版本：2.0
    header.setUint16(6, FLAG_UTF8, true);
    header.setUint16(8, method, true);
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, body.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);

    const out = new Uint8Array(30 + name.length + body.length);
    if (this.offset + out.length > MAX_BYTES) throw new Error("导出的包超过了 4 GB，zip 装不下");
    out.set(new Uint8Array(header.buffer), 0);
    out.set(name, 30);
    out.set(body, 30 + name.length);
    this.entries.push({ name, method, time, date, crc, packed: body.length, size: data.length, offset: this.offset });
    this.seen.add(path);
    this.offset += out.length;
    return out;
  }

  /** 收尾：返回目录和结束记录。之后不能再加文件。 */
  end(): Uint8Array {
    const size = this.entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const out = new Uint8Array(size + 22);
    const view = new DataView(out.buffer);
    let p = 0;
    for (const e of this.entries) {
      view.setUint32(p, 0x02014b50, true);
      // 由什么写的：2.0，Unix。写成 MS-DOS（0）的话，macOS / Linux 自带的 unzip 会把文件名当成旧的 DOS 编码再转一遍，
      // 中文文件名变成乱码、解不出来（2026-11-26 实测；Python 和访达不受影响）
      view.setUint16(p + 4, (3 << 8) | 20, true);
      view.setUint16(p + 6, 20, true);
      view.setUint16(p + 8, FLAG_UTF8, true);
      view.setUint16(p + 10, e.method, true);
      view.setUint16(p + 12, e.time, true);
      view.setUint16(p + 14, e.date, true);
      view.setUint32(p + 16, e.crc, true);
      view.setUint32(p + 20, e.packed, true);
      view.setUint32(p + 24, e.size, true);
      view.setUint16(p + 28, e.name.length, true);
      // 30 额外字段长、32 注释长、34 起始分卷、36 内部属性：都是 0。38 外部属性的高 16 位是 Unix 的文件类型和权限：普通文件，644
      view.setUint32(p + 38, (0o100644 << 16) >>> 0, true);
      view.setUint32(p + 42, e.offset, true);
      out.set(e.name, p + 46);
      p += 46 + e.name.length;
    }
    if (this.offset + size > MAX_BYTES) throw new Error("导出的包超过了 4 GB，zip 装不下");
    view.setUint32(p, 0x06054b50, true);
    view.setUint16(p + 8, this.entries.length, true);
    view.setUint16(p + 10, this.entries.length, true);
    view.setUint32(p + 12, size, true);
    view.setUint32(p + 16, this.offset, true);
    return out;
  }
}
