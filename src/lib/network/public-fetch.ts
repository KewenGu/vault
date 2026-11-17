import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isPublicAddress, publicHttpUrl } from "./public-ip";
import { egressProxy, proxyAgent } from "./egress-proxy";

export class DownloadLimitError extends Error {
  constructor(readonly bytes: number | null) { super("下载内容超过大小上限"); this.name = "DownloadLimitError"; }
}
export type PublicFetchOptions = {
  headers?: HeadersInit; maxBytes?: number; timeoutMs?: number;
  maxRedirects?: number; signal?: AbortSignal; method?: "GET" | "HEAD"; redirect?: "follow" | "manual";
  /** Optional shared budget, charged while streaming and for decoded expansion. */
  consumeBytes?: (bytes: number) => void;
};

/** Resolve once and reject mixed answers. The returned IP is pinned at connect time. */
export async function resolvePublicAddress(url: URL): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.some((a) => /^198\.(18|19)\./.test(a.address))) throw new Error("地址不安全：DNS 返回 fake-IP/基准测试网段；请关闭 fake-IP，或配置 PUBLIC_EGRESS_MODE=trusted-proxy 及受信任的 HTTP(S) 代理");
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new Error("地址不安全：域名解析到非公开网络");
  return addresses[0];
}

function headersOf(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) if (value !== undefined) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }
  return headers;
}

async function requestOnce(url: URL, headers: Headers, opts: Required<Pick<PublicFetchOptions, "maxBytes" | "method">> & Pick<PublicFetchOptions, "consumeBytes">, signal: AbortSignal) {
  const proxy = egressProxy(url);
  const pinned = proxy ? null : await new Promise<{ address: string; family: number }>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    resolvePublicAddress(url).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const agent = proxy ? proxyAgent(url, proxy, signal) : null;
  try { return await new Promise<{ status: number; headers: Headers; body: Uint8Array }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: opts.method, headers: Object.fromEntries(headers), signal,
      agent: agent ?? false, family: pinned?.family,
      // Direct mode pins DNS. Trusted-proxy mode delegates DNS to the configured
      // public-only proxy, while retaining destination Host and TLS verification.
      ...(pinned ? { lookup: (_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family) } : {}),
    }, (res: IncomingMessage) => {
      const responseHeaders = headersOf(res.headers);
      const status = res.statusCode ?? 502;
      if (opts.method === "HEAD" || [301, 302, 303, 307, 308].includes(status)) {
        res.destroy(); resolve({ status, headers: responseHeaders, body: new Uint8Array() }); return;
      }
      const declared = Number(responseHeaders.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBytes) { res.destroy(); reject(new DownloadLimitError(declared)); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        try {
          bytes += chunk.length;
          if (bytes > opts.maxBytes) throw new DownloadLimitError(null);
          opts.consumeBytes?.(chunk.length);
          chunks.push(chunk);
        } catch (error) { res.destroy(); reject(error); }
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("下载连接提前中断")));
      res.on("end", () => {
        try {
          let body = Buffer.concat(chunks);
          const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
          const decode = encoding === "gzip" ? gunzipSync : encoding === "br" ? brotliDecompressSync : encoding === "deflate" ? inflateSync : null;
          if (decode) {
            try { body = decode(body, { maxOutputLength: opts.maxBytes }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new DownloadLimitError(null); throw error; }
            if (body.length > bytes) opts.consumeBytes?.(body.length - bytes);
            responseHeaders.delete("content-encoding");
          } else if (encoding && encoding !== "identity") throw new Error("不支持的下载压缩格式");
          responseHeaders.delete("transfer-encoding");
          responseHeaders.set("content-length", String(body.length));
          resolve({ status, headers: responseHeaders, body });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end();
  }); } finally { agent?.destroy(); }
}

/** Bounded, DNS-pinned egress for untrusted documents and media, including every redirect. */
export async function publicFetch(input: string, options: PublicFetchOptions = {}): Promise<Response> {
  let url = publicHttpUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("下载超时")), options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const headers = new Headers(options.headers);
  for (const name of ["host", "connection", "proxy-authorization", "proxy-connection"]) headers.delete(name);
  headers.set("accept-encoding", "identity");
  try {
    for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
      signal.throwIfAborted();
      const result = await requestOnce(url, headers, { maxBytes: options.maxBytes ?? 2 * 1024 * 1024, method: options.method ?? "GET", consumeBytes: options.consumeBytes }, signal);
      if (options.redirect !== "manual" && [301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get("location");
        if (!location) throw new Error("下载地址跳转到了空地址");
        const next = publicHttpUrl(new URL(location, url).href);
        if (next.origin !== url.origin) for (const name of ["authorization", "cookie", "referer", "origin"]) headers.delete(name);
        url = next; continue;
      }
      const response = new Response([204, 205, 304].includes(result.status) || options.method === "HEAD" ? null : result.body as BodyInit, { status: result.status, headers: result.headers });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    throw new Error("下载地址跳转次数太多");
  } finally { clearTimeout(timeout); }
}
