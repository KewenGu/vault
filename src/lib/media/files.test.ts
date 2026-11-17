import { describe, it, expect, vi, afterEach } from "vitest";
import sharp from "sharp";
import { TooLargeError, downloadRemote, normalizeImage, visionImage } from "./files";

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
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
