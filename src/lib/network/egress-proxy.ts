import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { isIP, type Socket } from "node:net";
import { publicHttpUrl } from "./public-ip";

/** Explicit operator trust: the proxy must enforce public-only DNS and destination ACLs. */
export function egressProxy(url: URL, env: Partial<NodeJS.ProcessEnv> = process.env): URL | null {
  const mode = env.PUBLIC_EGRESS_MODE?.trim() || "direct";
  if (mode === "direct") return null;
  if (mode !== "trusted-proxy") throw new Error("PUBLIC_EGRESS_MODE 只支持 direct 或 trusted-proxy");
  const configured = (url.protocol === "https:" ? env.https_proxy || env.HTTPS_PROXY : env.http_proxy || env.HTTP_PROXY) || env.all_proxy || env.ALL_PROXY;
  let proxy: URL;
  try { proxy = new URL(configured ?? ""); } catch { throw new Error("trusted-proxy 模式需要配置 HTTP(S) 环境代理"); }
  if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new Error("出网代理必须是 HTTP(S) CONNECT 代理地址");
  }
  return proxy;
}

/** CONNECT carries the destination hostname; local fake-IP DNS is never consulted. */
export function proxyTunnel(url: URL, proxy: URL, signal: AbortSignal): Promise<Socket> {
  publicHttpUrl(url.href);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const authority = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    const headers: Record<string, string> = { host: authority };
    if (proxy.username || proxy.password) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const request = proxy.protocol === "https:" ? httpsRequest : httpRequest;
    // Keep credentials out of request URLs and error text; never fall back to direct access.
    const endpoint = new URL(proxy.href); endpoint.username = ""; endpoint.password = "";
    const req = request(endpoint, { method: "CONNECT", path: authority, headers, agent: false, signal });
    req.once("error", () => reject(signal.aborted ? signal.reason : new Error("出网代理连接失败")));
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200 || signal.aborted) {
        socket.destroy(); reject(signal.aborted ? signal.reason : new Error(`出网代理拒绝连接（HTTP ${res.statusCode}）`)); return;
      }
      if (head.length) socket.unshift(head);
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", abort));
      resolve(socket);
    });
    req.end();
  });
}

export function proxyAgent(url: URL, proxy: URL, signal: AbortSignal): HttpAgent | HttpsAgent {
  const agent = url.protocol === "https:" ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    void proxyTunnel(url, proxy, signal).then(socket => {
      if (signal.aborted) { socket.destroy(); callback?.(signal.reason, socket); return; }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      // Certificate verification stays enabled against the original destination.
      const connection = url.protocol === "https:" ? tlsConnect({ socket, servername: isIP(host) ? undefined : host, host, rejectUnauthorized: true }) : socket;
      callback?.(null, connection);
    }, error => callback?.(error, undefined as unknown as Socket));
    return undefined;
  };
  return agent;
}
