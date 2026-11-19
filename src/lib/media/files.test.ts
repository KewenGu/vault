import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { TooLargeError, archiveImage, downloadRemote, downloadRemoteToFile, normalizeImage, visionImage, visionSlices } from "./files";

afterEach(() => vi.unstubAllGlobals());

const bytes = (n: number) => new Uint8Array(n).fill(7);

describe("收藏夹：文件处理", () => {
  it("下载：跟着 CDN 跳转走，每一跳都过 SSRF 守卫（跳去内网就停）", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "https://www.douyin.com/play" ? new Response(null, { status: 302, headers: { location: "https://v3-dy.douyinvod.com/x.mp4" } }) : new Response(bytes(10))
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await downloadRemote({ url: "https://www.douyin.com/play" }, 100)).byteLength).toBe(10);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://www.douyin.com/play", "https://v3-dy.douyinvod.com/x.mp4"]);

    const inward = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    vi.stubGlobal("fetch", inward);
    await expect(downloadRemote({ url: "https://cdn.example.com/a.jpg" }, 100)).rejects.toThrow("文件地址不安全，没有下载");
    expect(inward).toHaveBeenCalledTimes(1);
  });

  it("下载：文件自带的请求头（cookie、referer）只发给原来那个站，跳去别的站就不带了", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url === "https://v16-webapp-prime.us.tiktok.com/play/"
        ? new Response(null, { status: 302, headers: { location: "https://v19.tiktok.com/next/" } })
        : url === "https://v19.tiktok.com/next/"
          ? new Response(null, { status: 302, headers: { location: "https://cdn.example.net/x.mp4" } })
          : new Response(bytes(4))
    );
    vi.stubGlobal("fetch", fetchMock);
    const headers = { cookie: "tt_chain_token=abc", referer: "https://www.tiktok.com/", "user-agent": "DesktopUA" };
    expect((await downloadRemote({ url: "https://v16-webapp-prime.us.tiktok.com/play/", headers }, 100)).byteLength).toBe(4);
    const sent = fetchMock.mock.calls.map((c) => c[1]?.headers as Record<string, string>);
    // 原始源可带；即便同站跨子域也不能带凭据
    expect(sent[0]).toMatchObject(headers);
    expect(sent[1].cookie).toBeUndefined();
    expect(sent[1].referer).toBeUndefined();
    expect(sent[2].cookie).toBeUndefined();
    expect(sent[2].referer).toBeUndefined();
    expect(sent[2]["user-agent"]).not.toBe("DesktopUA");
  });

  it("下载：主地址不行试备用地址；都不行抛最后一个错", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("backup") ? new Response(bytes(3)) : new Response("no", { status: 403 })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await downloadRemote({ url: "https://a.example.com/1", backupUrls: ["https://backup.example.com/1"] }, 100)).byteLength).toBe(3);
    await expect(downloadRemote({ url: "https://a.example.com/1" }, 100)).rejects.toThrow("下载文件失败（403）");
  });

  it("下载：超过上限就停——平台报的大小、响应头的大小、边读边数都算；超了不再试备用地址", async () => {
    const fetchMock = vi.fn(async () => new Response(bytes(50)));
    vi.stubGlobal("fetch", fetchMock);
    // 平台已经说了多大：不发请求
    await expect(downloadRemote({ url: "https://a.example.com/v.mp4", bytes: 291_000_000 }, 1000)).rejects.toMatchObject({ name: "TooLargeError", bytes: 291_000_000 });
    expect(fetchMock).not.toHaveBeenCalled();
    // 响应头报的
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes(50), { headers: { "content-length": "5000" } })));
    await expect(downloadRemote({ url: "https://a.example.com/v.mp4" }, 1000)).rejects.toMatchObject({ bytes: 5000 });
    // 没报大小：读到超了为止
    const lying = vi.fn(async () => new Response(bytes(50)));
    vi.stubGlobal("fetch", lying);
    await expect(downloadRemote({ url: "https://a.example.com/v.mp4", backupUrls: ["https://b.example.com/v.mp4"] }, 20)).rejects.toBeInstanceOf(TooLargeError);
    expect(lying).toHaveBeenCalledTimes(1);
  });

  it("下载：估算出来的大小（码率 × 时长）超了也照样去下，由服务器报的真实大小来判断", async () => {
    const fetchMock = vi.fn(async () => new Response(bytes(50)));
    vi.stubGlobal("fetch", fetchMock);
    // X 上两个多小时的讲课录屏：估出来 269 MB，实际的文件在上限以内
    expect((await downloadRemote({ url: "https://video.twimg.com/v.mp4", bytes: 269 * 1024 * 1024, bytesEstimated: true }, 1000)).byteLength).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 真的超了：按响应头报的大小拦下，报的也是那个真实的数
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes(50), { headers: { "content-length": "5000" } })));
    await expect(downloadRemote({ url: "https://video.twimg.com/v.mp4", bytes: 291_000_000, bytesEstimated: true }, 1000)).rejects.toMatchObject({ name: "TooLargeError", bytes: 5000 });
  });

  it("下载到磁盘：内容写进文件、返回大小；跳转、备用地址、上限都和下载到内存一样", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vault-files-test-"));
    try {
      const dest = path.join(dir, "source.mp4");
      const fetchMock = vi.fn(async (url: string) =>
        url === "https://www.douyin.com/play"
          ? new Response(null, { status: 302, headers: { location: "https://v3-dy.douyinvod.com/x.mp4" } })
          : url.includes("dead")
            ? new Response("no", { status: 403 })
            : new Response(bytes(10))
      );
      vi.stubGlobal("fetch", fetchMock);
      expect(await downloadRemoteToFile({ url: "https://www.douyin.com/play" }, dest, 100)).toBe(10);
      expect(new Uint8Array(await readFile(dest))).toEqual(bytes(10));
      // 主地址不行试备用地址，写的还是同一个文件
      expect(await downloadRemoteToFile({ url: "https://dead.example.com/1", backupUrls: ["https://backup.example.com/1"] }, dest, 100)).toBe(10);
      await expect(downloadRemoteToFile({ url: "https://dead.example.com/1" }, dest, 100)).rejects.toThrow("下载文件失败（403）");
      // 平台报的大小超了：不发请求
      fetchMock.mockClear();
      await expect(downloadRemoteToFile({ url: "https://a.example.com/v.mp4", bytes: 291_000_000 }, dest, 1000)).rejects.toMatchObject({ name: "TooLargeError", bytes: 291_000_000 });
      expect(fetchMock).not.toHaveBeenCalled();
      // 空文件算失败
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array())));
      await expect(downloadRemoteToFile({ url: "https://a.example.com/v.mp4" }, dest, 1000)).rejects.toThrow("下载文件失败（空文件）");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("图片统一成 JPEG：长边缩到上限、不放大；给模型看的再缩到 1024", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 3000, height: 1500, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer());
    const stored = await normalizeImage(png);
    expect(stored).toMatchObject({ mime: "image/jpeg", width: 2160, height: 1080 });
    expect((await sharp(Buffer.from(stored.data)).metadata()).format).toBe("jpeg");
    const small = new Uint8Array(await sharp({ create: { width: 300, height: 400, channels: 3, background: "#fff" } }).webp().toBuffer());
    expect(await normalizeImage(small)).toMatchObject({ width: 300, height: 400 });
    const vision = await sharp(Buffer.from(await visionImage(png))).metadata();
    expect([vision.width, vision.height]).toEqual([1024, 512]);
    await expect(normalizeImage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  /** 白底、最下面 120 像素是红色的长图（看切段有没有切到底） */
  const tallPng = async (width: number, height: number) =>
    new Uint8Array(
      await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
        .composite([{ input: { create: { width, height: 120, channels: 3, background: "#ff0000" } }, top: height - 120, left: 0 }])
        .png()
        .toBuffer()
    );

  it("长图存档按宽度缩：宽不超过 1440，高不按 2160 截；普通图片照旧按长边", async () => {
    // 一张 iPhone 长截图：原样留着（以前会缩成 212 × 2160）
    expect(await archiveImage(await tallPng(1179, 12_000))).toMatchObject({ mime: "image/jpeg", width: 1179, height: 12_000 });
    expect(await archiveImage(await tallPng(3000, 20_000))).toMatchObject({ width: 1440, height: 9600 });
    // 普通图片同 normalizeImage
    const wide = new Uint8Array(await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#fff" } }).png().toBuffer());
    expect(await archiveImage(wide)).toMatchObject({ width: 2160, height: 1080 });
    await expect(archiveImage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("给模型看的长图切成几段：缩到宽 1024，每段 1536 高、相邻重叠，最后一段贴着底边；段数有上限", async () => {
    const tall = await tallPng(1179, 12_000);
    const cut = await visionSlices(tall);
    // 缩到 1024 × 10422，每段往下 1440：一共 8 段
    expect(cut.total).toBe(8);
    expect(cut.slices).toHaveLength(8);
    for (const s of cut.slices) expect(await sharp(Buffer.from(s)).metadata()).toMatchObject({ format: "jpeg", width: 1024, height: 1536 });
    // 最后一段的最底下是红色的那一条
    const last = await sharp(Buffer.from(cut.slices[7])).extract({ left: 500, top: 1520, width: 1, height: 1 }).raw().toBuffer();
    expect(last[0]).toBeGreaterThan(200);
    expect(last[1]).toBeLessThan(60);
    // 第一段没有红色
    const first = await sharp(Buffer.from(cut.slices[0])).stats();
    expect(first.channels[1].min).toBeGreaterThan(200);

    const capped = await visionSlices(tall, { maxSlices: 3 });
    expect([capped.slices.length, capped.total]).toEqual([3, 8]);

    // 普通手机截图（约 2.17 倍）切成两段
    expect((await visionSlices(await tallPng(1179, 2556))).total).toBe(2);
    // 不是长图：一张，同 visionImage
    const photo = new Uint8Array(await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#fff" } }).png().toBuffer());
    const one = await visionSlices(photo);
    expect(one.total).toBe(1);
    expect(await sharp(Buffer.from(one.slices[0])).metadata()).toMatchObject({ width: 1024, height: 683 });
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
// toFile is honoured the way the real one does it: a 2xx body goes to the file and the response comes back empty.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: async (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => {
    const res = await fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) });
    if (!options.toFile || !res.ok) return res;
    await writeFile(options.toFile, new Uint8Array(await res.arrayBuffer()));
    return new Response(null, { status: res.status, headers: res.headers });
  },
}));
