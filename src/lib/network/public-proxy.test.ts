import { describe, expect, it, vi } from "vitest";
import { withPublicProxy } from "./public-proxy";
import { publicHttpUrl } from "./public-ip";
import { Duplex } from "node:stream";

const { lookup, connect } = vi.hoisted(() => ({ lookup: vi.fn(), connect: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:net", async (original) => ({ ...await original<object>(), connect }));

describe("native downloader proxy", () => {
  it("rejects private literal, IPv6 and private DNS CONNECT destinations before opening an upstream connection", async () => {
    const http = await vi.importActual<typeof import("node:http")>("node:http");
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await withPublicProxy(async (proxy) => {
      const u = new URL(proxy);
      for (const target of ["127.0.0.1:443", "[::1]:443", "metadata.example:443", "example.com:8080"]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request({ host: u.hostname, port: u.port, method: "CONNECT", path: target });
          req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
          req.on("error", reject); req.end();
        });
        expect(status).toBe(403);
      }
      return publicHttpUrl("https://example.com/media").hostname;
    });
    expect(lookup).toHaveBeenCalledWith("metadata.example", { all: true, verbatim: true });
    expect(connect).not.toHaveBeenCalled();
  });
  it("opens a public HTTPS tunnel using the validated IP rather than re-resolving the hostname", async () => {
    const http = await vi.importActual<typeof import("node:http")>("node:http");
    lookup.mockReset().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    connect.mockImplementation(() => {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
      Object.assign(socket, { setTimeout() { return socket; } });
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    await withPublicProxy(async (proxy) => {
      const u = new URL(proxy);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, method: "CONNECT", path: "public.example:443" });
        req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
        req.on("error", reject); req.end();
      });
      expect(status).toBe(200);
    });
    expect(connect).toHaveBeenCalledWith({ host: "93.184.216.34", family: 4, port: 443 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
