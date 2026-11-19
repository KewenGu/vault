import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { isPublicAddress, publicHttpUrl } from "./public-ip";

const state = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: state.lookup }));
vi.mock("node:http", async (original) => ({ ...await original<object>(), request: state.request }));
vi.mock("node:https", () => ({ request: state.request }));
import { publicFetch, DownloadLimitError } from "./public-fetch";

type Reply = { status?: number; headers?: Record<string, string | string[]>; chunks?: Buffer[] };
let replies: Reply[];
let connections: { url: URL; headers: Record<string, string>; address: string }[];
beforeEach(() => {
  replies = []; connections = [];
  state.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  state.request.mockReset().mockImplementation((url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      options.lookup(url.hostname, {}, (_error: unknown, address: string) => connections.push({ url, headers: options.headers, address }));
      const reply = replies.shift() ?? {};
      const res = Readable.from(reply.chunks ?? [Buffer.from("public content")]);
      Object.assign(res, { statusCode: reply.status ?? 200, headers: reply.headers ?? {} });
      callback(res);
    };
    return req;
  });
});

describe("public address boundary", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "2001::1"])('rejects %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:808:808"])('permits public %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each(["http://2130706433/", "http://0177.0.0.1/", "http://user:pass@example.com/", "file:///etc/passwd", "http://localhost./"])('rejects URL %s', (url) => expect(() => publicHttpUrl(url)).toThrow());
});

describe("bounded DNS-pinned download", () => {
  it("pins the validated answer at connect time, retaining hostname for Host/TLS", async () => {
    state.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await (await publicFetch("https://example.com/a")).text()).toBe("public content");
    expect(state.lookup).toHaveBeenCalledTimes(1);
    expect(connections[0].address).toBe("93.184.216.34");
    expect(connections[0].url.hostname).toBe("example.com");
  });
  it("blocks private or mixed DNS before any connection", async () => {
    state.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }]);
    await expect(publicFetch("https://example.com/")).rejects.toThrow("非公开");
    expect(state.request).not.toHaveBeenCalled();
  });
  it("checks redirect DNS again, including a rebinding same-host redirect", async () => {
    replies.push({ status: 302, headers: { location: "/next" } });
    state.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(publicFetch("https://example.com/")).rejects.toThrow("非公开");
    expect(connections).toHaveLength(1);
  });
  it("blocks a redirect to metadata and supports safe public redirects without leaking credentials", async () => {
    replies.push({ status: 302, headers: { location: "http://169.254.169.254/" } });
    await expect(publicFetch("https://example.com/")).rejects.toThrow("不安全");
    replies.push({ status: 302, headers: { location: "https://cdn.example.com/file" } }, {});
    const res = await publicFetch("https://example.com/file", { headers: { cookie: "secret", authorization: "token" } });
    expect(await res.text()).toBe("public content");
    expect(connections.at(-1)?.headers).not.toHaveProperty("cookie");
    expect(connections.at(-1)?.headers).not.toHaveProperty("authorization");
  });
  it("bounds declared, streamed and inflated bytes", async () => {
    const cases: Reply[] = [
      { headers: { "content-length": "100" } },
      { chunks: [Buffer.alloc(3), Buffer.alloc(3)] },
      { headers: { "content-encoding": "gzip" }, chunks: [gzipSync(Buffer.alloc(1000))] },
    ];
    for (const reply of cases) {
      replies.push(reply);
      await expect(publicFetch("https://example.com/", { maxBytes: reply.headers?.["content-encoding"] ? 100 : 5 })).rejects.toBeInstanceOf(DownloadLimitError);
    }
  });
  it("times out even if DNS never answers", async () => {
    state.lookup.mockReturnValue(new Promise(() => {}));
    await expect(publicFetch("https://example.com/", { timeoutMs: 10 })).rejects.toThrow("超时");
    expect(state.request).not.toHaveBeenCalled();
  });
  it("preserves separate Set-Cookie fields needed for legitimate platform media", async () => {
    replies.push({ headers: { "set-cookie": ["first=1; Path=/", "second=2; Path=/"] } });
    expect((await publicFetch("https://example.com/")).headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
  });
  it("streams a body to a file instead of memory, under the same size limits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "public-fetch-test-"));
    try {
      const file = path.join(dir, "video.mp4");
      let used = 0;
      replies.push({ chunks: [Buffer.from("abc"), Buffer.from("defg")] });
      const res = await publicFetch("https://example.com/v.mp4", { toFile: file, maxBytes: 7, consumeBytes: (n) => { used += n; } });
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
      expect(await readFile(file, "utf8")).toBe("abcdefg");
      expect(used).toBe(7);
      // Over the limit: declared up front, or counted while streaming.
      replies.push({ headers: { "content-length": "100" } });
      await expect(publicFetch("https://example.com/v.mp4", { toFile: path.join(dir, "declared.mp4"), maxBytes: 5 })).rejects.toMatchObject({ name: "DownloadLimitError", bytes: 100 });
      expect(existsSync(path.join(dir, "declared.mp4"))).toBe(false);
      replies.push({ chunks: [Buffer.alloc(3), Buffer.alloc(3)] });
      await expect(publicFetch("https://example.com/v.mp4", { toFile: path.join(dir, "streamed.mp4"), maxBytes: 5 })).rejects.toBeInstanceOf(DownloadLimitError);
      // An error page or a redirect is not the file.
      replies.push({ status: 403, chunks: [Buffer.from("denied")] });
      expect((await publicFetch("https://example.com/v.mp4", { toFile: path.join(dir, "denied.mp4") })).status).toBe(403);
      expect(existsSync(path.join(dir, "denied.mp4"))).toBe(false);
      replies.push({ status: 302, headers: { location: "https://cdn.example.com/v.mp4" } }, { chunks: [Buffer.from("moved")] });
      await publicFetch("https://example.com/v.mp4", { toFile: path.join(dir, "moved.mp4") });
      expect(await readFile(path.join(dir, "moved.mp4"), "utf8")).toBe("moved");
      // A compressed body cannot be written through as-is.
      replies.push({ headers: { "content-encoding": "gzip" }, chunks: [gzipSync(Buffer.alloc(10))] });
      await expect(publicFetch("https://example.com/v.mp4", { toFile: path.join(dir, "gz.mp4") })).rejects.toThrow("不支持的下载压缩格式");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("enforces a shared streaming budget across parallel subresources", async () => {
    let used = 0;
    const consumeBytes = (size: number) => { if (used + size > 10) throw new Error("page budget"); used += size; };
    replies.push({ chunks: [Buffer.alloc(6)] }, { chunks: [Buffer.alloc(6)] });
    const results = await Promise.allSettled([publicFetch("https://example.com/a", { consumeBytes }), publicFetch("https://example.com/b", { consumeBytes })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(used).toBe(6);
  });
});
