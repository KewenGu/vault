import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 容器里临时目录和存原片的卷不是一个盘，改名会报 EXDEV：这里能让改名假装跨盘
const fsState = vi.hoisted(() => ({ crossDevice: false }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const rename: typeof real.rename = async (from, to) => {
    if (fsState.crossDevice) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return real.rename(from, to);
  };
  return { ...real, rename };
});

import { keepLocalFile, localFileResponse, localFileSize, localMediaPath, localMediaRoot, localMediaUsage, parseRange, removeLocalItemFiles } from "./local-store";

const USER = "22222222-2222-4222-8222-222222222222";
const ITEM = "11111111-1111-4111-8111-111111111111";
const VIDEO = `${USER}/${ITEM}/video.mp4`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "vault-local-store-test-"));
  vi.stubEnv("VAULT_LOCAL_MEDIA_DIR", path.join(dir, "media"));
});
afterEach(async () => {
  fsState.crossDevice = false;
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("where originals are kept", () => {
  it("is the configured directory, or .vault-media under the working directory", () => {
    expect(localMediaRoot()).toBe(path.join(dir, "media"));
    expect(localMediaRoot({})).toBe(path.resolve(".vault-media"));
  });

  it("maps a storage path to a file under that directory, and refuses anything that could leave it", () => {
    expect(localMediaPath(VIDEO)).toBe(path.join(dir, "media", USER, ITEM, "video.mp4"));
    for (const bad of ["video.mp4", `${USER}/../../etc/passwd`, `../${ITEM}/video.mp4`, `/etc/passwd`, `${USER}//video.mp4`, `${USER}/${ITEM}/.env`, `${USER}/${ITEM}/a\\b`, ""]) {
      expect(localMediaPath(bad)).toBeNull();
    }
  });
});

describe("keeping, measuring and removing", () => {
  it("moves a downloaded file in, replaces an earlier one, and removes an item's files", async () => {
    const tmp = path.join(dir, "source.mp4");
    await writeFile(tmp, "first");
    const kept = await keepLocalFile(tmp, VIDEO);
    expect(kept).toBe(localMediaPath(VIDEO));
    expect(existsSync(tmp)).toBe(false);
    expect(await readFile(kept, "utf8")).toBe("first");
    expect(await localFileSize(VIDEO)).toBe(5);
    await writeFile(tmp, "second one");
    await keepLocalFile(tmp, VIDEO);
    expect(await readFile(kept, "utf8")).toBe("second one");

    expect(await localMediaUsage()).toMatchObject({ dir: path.join(dir, "media"), files: 1, bytes: 10 });
    expect((await localMediaUsage()).freeBytes).toBeGreaterThan(0);

    await removeLocalItemFiles(USER, ITEM);
    expect(await localFileSize(VIDEO)).toBeNull();
    expect(await localMediaUsage()).toMatchObject({ files: 0, bytes: 0 });
    // 本来就没有：不报错
    await removeLocalItemFiles(USER, ITEM);
  });

  it("copies instead when the download sits on another disk, and leaves no half file when the copy fails", async () => {
    fsState.crossDevice = true;
    const tmp = path.join(dir, "source.mp4");
    await writeFile(tmp, "across disks");
    const kept = await keepLocalFile(tmp, VIDEO);
    expect(await readFile(kept, "utf8")).toBe("across disks");
    expect(existsSync(tmp)).toBe(false);
    // 复制不成（这里：源文件不在）：目标位置不留东西
    await removeLocalItemFiles(USER, ITEM);
    await expect(keepLocalFile(path.join(dir, "missing.mp4"), VIDEO)).rejects.toThrow();
    expect(await localFileSize(VIDEO)).toBeNull();
  });

  it("reports nothing kept, and still the free space, before the directory exists", async () => {
    const usage = await localMediaUsage();
    expect(usage).toMatchObject({ files: 0, bytes: 0 });
    expect(usage.freeBytes).toBeGreaterThan(0);
  });

  it("refuses a path that is not a plain storage path", async () => {
    const tmp = path.join(dir, "source.mp4");
    await writeFile(tmp, "x");
    await expect(keepLocalFile(tmp, "../outside.mp4")).rejects.toThrow("文件路径不合规");
    expect(existsSync(path.join(dir, "outside.mp4"))).toBe(false);
  });
});

describe("parseRange", () => {
  it("reads the forms browsers send", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=0-1", 1000)).toEqual({ start: 0, end: 1 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=500-99999", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("says when a range starts past the end, and ignores what it does not understand", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-10,20-30", 1000)).toBeNull();
    expect(parseRange("items=0-10", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("bytes=20-10", 1000)).toBeNull();
  });
});

describe("serving a kept original", () => {
  const body = "0123456789";
  beforeEach(async () => {
    await mkdir(path.dirname(localMediaPath(VIDEO)!), { recursive: true });
    await writeFile(localMediaPath(VIDEO)!, body);
  });
  const get = (range?: string) => localFileResponse(new Request("https://vault.example/media/x/video.mp4", { headers: range ? { range } : {} }), VIDEO, "video/mp4");

  it("sends the whole file, or the part asked for", async () => {
    const whole = (await get())!;
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(whole.headers)).toMatchObject({ "content-type": "video/mp4", "content-length": "10", "accept-ranges": "bytes" });
    expect(await whole.text()).toBe(body);

    const part = (await get("bytes=2-5"))!;
    expect(part.status).toBe(206);
    expect(Object.fromEntries(part.headers)).toMatchObject({ "content-range": "bytes 2-5/10", "content-length": "4" });
    expect(await part.text()).toBe("2345");

    const tail = (await get("bytes=7-"))!;
    expect(tail.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await tail.text()).toBe("789");

    const past = (await get("bytes=10-"))!;
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */10");
  });

  it("answers nothing for a file that is not on the disk", async () => {
    expect(await localFileResponse(new Request("https://vault.example/"), `${USER}/${ITEM}/other.mp4`, "video/mp4")).toBeNull();
    expect(await localFileResponse(new Request("https://vault.example/"), "../../etc/passwd", "video/mp4")).toBeNull();
  });
});
