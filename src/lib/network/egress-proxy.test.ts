import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { egressProxy } from "./egress-proxy";
import { publicFetch } from "./public-fetch";
import { withPublicProxy } from "./public-proxy";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
// This suite uses only owned loopback proxies; no request reaches a real target.
vi.unmock("node:http");
vi.unmock("node:https");
vi.mock("node:dns/promises", () => ({ lookup }));
beforeEach(() => { lookup.mockReset().mockResolvedValue([{ address: "198.18.0.2", family: 4 }]); vi.stubEnv("PUBLIC_EGRESS_MODE", "direct"); });
afterEach(() => vi.unstubAllEnvs());

async function fixture(work: (proxy: string, seen: { target: string; auth?: string; request?: string }[]) => Promise<void>, status = 200) {
  const seen: { target: string; auth?: string; request?: string }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (req, socket) => {
    const row = { target: req.url!, auth: req.headers["proxy-authorization"], request: undefined as string | undefined }; seen.push(row);
    socket.write(`HTTP/1.1 ${status} ${status === 200 ? "OK" : "Denied"}\r\n\r\n`);
    if (status !== 200) { socket.end(); return; }
    socket.once("data", chunk => {
      row.request = chunk.toString();
      const redirect = row.request?.includes("GET /redirect ");
      socket.end(redirect ? "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n" : "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await work(`http://127.0.0.1:${(server.address() as { port: number }).port}`, seen); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("explicit trusted CONNECT egress", () => {
  it("keeps direct mode fail-closed with actionable fake-IP diagnostics", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    await expect(publicFetch("https://example.com")).rejects.toThrow("fake-IP");
    expect(egressProxy(new URL("https://example.com"))).toBeNull();
  });
  it("validates configuration without exposing credentials", () => {
    expect(() => egressProxy(new URL("https://example.com"), { PUBLIC_EGRESS_MODE: "trusted-proxy" })).toThrow("需要配置");
    expect(() => egressProxy(new URL("https://example.com"), { PUBLIC_EGRESS_MODE: "trusted-proxy", ALL_PROXY: "socks5://user:secret@localhost:1080" })).toThrow("HTTP(S) CONNECT");
  });
  it("passes hostnames to the configured proxy, preserving Host and isolating proxy credentials", async () => {
    await fixture(async (proxy, seen) => {
      vi.stubEnv("PUBLIC_EGRESS_MODE", "trusted-proxy"); vi.stubEnv("HTTP_PROXY", proxy.replace("://", "://test:synthetic@"));
      vi.stubEnv("http_proxy", "");
      const result = await publicFetch("http://media.example/file");
      expect(await result.text()).toBe("hello");
      expect(seen[0].target).toBe("media.example:80"); expect(seen[0].auth).toBeDefined();
      expect(seen[0].request).toContain("Host: media.example"); expect(seen[0].request?.toLowerCase()).not.toContain("proxy-authorization");
      expect(lookup).not.toHaveBeenCalled();
      await expect(publicFetch("http://media.example/redirect")).rejects.toThrow("不安全");
      expect(seen).toHaveLength(2);
      await expect(publicFetch("http://media.example/file", { maxBytes: 4 })).rejects.toThrow("大小上限");
    });
  });
  it("never falls back to direct access after a proxy denial", async () => {
    await fixture(async proxy => {
      vi.stubEnv("PUBLIC_EGRESS_MODE", "trusted-proxy"); vi.stubEnv("HTTP_PROXY", proxy); vi.stubEnv("http_proxy", "");
      await expect(publicFetch("http://media.example")).rejects.toThrow("403"); expect(lookup).not.toHaveBeenCalled();
    }, 403);
  });
  it("chains the native downloader CONNECT tunnel using remote DNS", async () => {
    await fixture(async (upstream, seen) => {
      vi.stubEnv("PUBLIC_EGRESS_MODE", "trusted-proxy"); vi.stubEnv("HTTPS_PROXY", upstream); vi.stubEnv("https_proxy", "");
      await withPublicProxy(async local => {
        const u = new URL(local);
        await new Promise<void>((resolve, reject) => {
          const req = request({ host: u.hostname, port: u.port, method: "CONNECT", path: "media.example:443" });
          req.on("connect", (res, socket) => { expect(res.statusCode).toBe(200); socket.destroy(); resolve(); });
          req.on("error", reject); req.end();
        });
      });
      expect(seen[0].target).toBe("media.example:443"); expect(lookup).not.toHaveBeenCalled();
    });
  });
  it("bounds a non-responsive CONNECT handshake", async () => {
    const sockets = new Set<Socket>(); const server = createServer();
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("connect", () => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      vi.stubEnv("PUBLIC_EGRESS_MODE", "trusted-proxy"); vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${(server.address() as { port: number }).port}`); vi.stubEnv("http_proxy", "");
      await expect(publicFetch("http://media.example", { timeoutMs: 50 })).rejects.toThrow();
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("rejects an untrusted target TLS certificate through the CONNECT tunnel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smi-proxy-tls-"));
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); };
    const proxy = createServer();
    let target: ReturnType<typeof createTlsServer> | undefined;
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=media.example"], { stdio: "ignore" });
      target = createTlsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) });
      target.on("connection", track); target.on("tlsClientError", () => {});
      await new Promise<void>(resolve => target!.listen(0, "127.0.0.1", resolve));
      proxy.on("connection", track);
      proxy.on("connect", (_req, client) => {
        const upstream = connect({ host: "127.0.0.1", port: (target!.address() as { port: number }).port }); track(upstream);
        upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
        upstream.once("connect", () => { client.write("HTTP/1.1 200 OK\r\n\r\n"); client.pipe(upstream); upstream.pipe(client); });
      });
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      vi.stubEnv("PUBLIC_EGRESS_MODE", "trusted-proxy"); vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${(proxy.address() as { port: number }).port}`); vi.stubEnv("https_proxy", "");
      await expect(publicFetch("https://media.example/", { timeoutMs: 2000 })).rejects.toThrow(/self.signed|certificate/i);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
      if (target?.listening) await new Promise<void>(resolve => target!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
