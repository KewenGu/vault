import { createServer, request } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as realTimeout } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { withPublicProxy } from "./public-proxy";

vi.unmock("node:http");
vi.unmock("node:https");
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("keeps an established native CONNECT download alive after the handshake deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Advance AbortSignal.timeout too, to exercise the old absolute-deadline regression.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); setTimeout(() => c.abort(new Error("deadline")), ms); return c.signal;
  });
  const sockets = new Set<Socket>();
  const upstream = createServer();
  upstream.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  upstream.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", chunk => socket.write(chunk));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("PUBLIC_EGRESS_MODE", "trusted-proxy"); vi.stubEnv("https_proxy", "");
  vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${(upstream.address() as { port: number }).port}`);
  try {
    await withPublicProxy(async local => {
      const url = new URL(local);
      const socket = await new Promise<Socket>((resolve, reject) => {
        const req = request({ host: url.hostname, port: url.port, method: "CONNECT", path: "media.example:443" });
        req.on("connect", (res, stream) => { if (res.statusCode === 200) resolve(stream); else reject(new Error("CONNECT rejected")); });
        req.on("error", reject); req.end();
      });
      try {
        const exchange = (data: string) => new Promise<string>((resolve, reject) => {
          socket.once("data", chunk => { socket.removeListener("error", reject); resolve(chunk.toString()); });
          socket.once("error", reject); socket.write(data);
        });
        expect(await exchange("first media bytes")).toBe("first media bytes");
        await vi.advanceTimersByTimeAsync(30_001);
        await new Promise<void>(resolve => realTimeout(resolve, 30));
        expect(socket.destroyed).toBe(false);
        expect(await exchange("later media bytes")).toBe("later media bytes");
      } finally { socket.destroy(); }
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
