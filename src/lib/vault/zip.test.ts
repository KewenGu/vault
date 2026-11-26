import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concat, readZip, text } from "@/test/read-zip";
import { ZipWriter, crc32 } from "./zip";

const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** 压不小的内容：固定种子的伪随机字节 */
function noise(n: number): Uint8Array {
  let x = 123456789;
  return Uint8Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 0xff;
  });
}

function build(): Uint8Array {
  const zip = new ZipWriter();
  const at = new Date("2026-11-26T08:30:10Z");
  return concat([
    zip.add("vault/README.md", "# 导出\n", at),
    zip.add("vault/items/2026-11/三亚 亲子酒店 (aaaaaaaa).md", "正文".repeat(2000), at),
    zip.add("vault/data/empty.json", "", at),
    // 压不小的（随机字节）原样存
    zip.add("vault/data/random.bin", noise(300), at),
    zip.end(),
  ]);
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("ZipWriter", () => {
  it("writes an archive that reads back file for file, with UTF-8 names", () => {
    const files = readZip(build());
    expect([...files.keys()]).toEqual(["vault/README.md", "vault/items/2026-11/三亚 亲子酒店 (aaaaaaaa).md", "vault/data/empty.json", "vault/data/random.bin"]);
    expect(text(files.get("vault/README.md"))).toBe("# 导出\n");
    expect(text(files.get("vault/items/2026-11/三亚 亲子酒店 (aaaaaaaa).md"))).toBe("正文".repeat(2000));
    expect(files.get("vault/data/empty.json")).toHaveLength(0);
    expect(files.get("vault/data/random.bin")).toEqual(noise(300));
  });

  it("compresses text, and stores what does not get smaller", () => {
    const bytes = build();
    expect(bytes.length).toBeLessThan(2000);
    const zip = new ZipWriter();
    const stored = zip.add("a.bin", noise(300));
    expect(stored.length).toBe(30 + 5 + 300);
  });

  it("refuses the same path twice instead of writing an archive with two files of one name", () => {
    const zip = new ZipWriter();
    zip.add("a.md", "1");
    expect(() => zip.add("a.md", "2")).toThrow(/已经有/);
    expect(zip.count).toBe(1);
  });

  it.skipIf(!hasUnzip)("passes the system unzip's integrity test and extracts with the right names", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-zip-"));
    try {
      writeFileSync(join(dir, "out.zip"), build());
      expect(execFileSync("unzip", ["-t", join(dir, "out.zip")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 })).toContain("No errors detected");
      // stdin 关掉：解不出来时 unzip 会停下来问「继续吗」，没人回答就一直等
      execFileSync("unzip", ["-q", join(dir, "out.zip"), "-d", join(dir, "x")], { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
      expect(readFileSync(join(dir, "x/vault/items/2026-11/三亚 亲子酒店 (aaaaaaaa).md"), "utf8")).toBe("正文".repeat(2000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
