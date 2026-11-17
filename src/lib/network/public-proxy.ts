import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { publicHttpUrl } from "./public-ip";
import { publicFetch, resolvePublicAddress } from "./public-fetch";
import { egressProxy, proxyTunnel } from "./egress-proxy";

/** Short-lived local egress proxy for the optional native yt-dlp downloader. */
export async function withPublicProxy<T>(work: (url: string) => Promise<T>, maxBytes = 256 * 1024 * 1024): Promise<T> {
  const sockets = new Set<Socket>();
  let bytes = 0;
  let requests = 0;
  const server = createServer(async (req, res) => {
    try {
      if (++requests > 200 || !["GET", "HEAD"].includes(req.method ?? "")) throw new Error("代理请求超出限制");
      const response = await publicFetch(req.url ?? "", { method: req.method as "GET" | "HEAD", redirect: "manual", maxBytes: Math.min(maxBytes - bytes, 50 * 1024 * 1024), headers: Object.fromEntries(Object.entries(req.headers).filter(([key, value]) => !!value && !["proxy-authorization", "host"].includes(key)).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value!])) });
      const body = Buffer.from(await response.arrayBuffer());
      bytes += body.length;
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(body);
    } catch { res.writeHead(403); res.end("Public network access only"); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setTimeout(30_000, () => socket.destroy()); });
  server.on("connect", async (req, client, head) => {
    try {
      if (++requests > 200 || bytes >= maxBytes) throw new Error("代理请求超出限制");
      const url = publicHttpUrl(`https://${req.url ?? ""}/`);
      if (url.port && url.port !== "443") throw new Error("TLS 代理只支持 HTTPS 端口");
      const proxy = egressProxy(url);
      const pinned = proxy ? null : await resolvePublicAddress(url);
      if (client.destroyed) return;
      const controller = new AbortController();
      client.once("close", () => controller.abort());
      // Bound establishment, not the lifetime of an actively streaming download.
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      let upstream: Socket;
      try {
        if (proxy) handshakeTimer = setTimeout(() => controller.abort(new Error("代理连接超时")), 30_000);
        upstream = proxy ? await proxyTunnel(url, proxy, controller.signal) : connect({ host: pinned!.address, family: pinned!.family, port: 443 });
      } finally { clearTimeout(handshakeTimer); }
      if (client.destroyed) { upstream.destroy(); return; }
      sockets.add(upstream);
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      client.on("error", () => upstream.destroy());
      upstream.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBytes) for (const socket of sockets) socket.destroy(); });
      const ready = () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); };
      if (proxy) ready(); else upstream.once("connect", ready);
    } catch { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("代理无法启动");
    return await work(`http://127.0.0.1:${address.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
