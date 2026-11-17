import { explainFetchError } from "@/lib/fetch-error";
import { publicFetch } from "./public-fetch";

/** Read-only remote content adapter. Provider POST APIs use their fixed endpoints. */
export async function labeledPublicFetch(service: string, input: string, init: RequestInit = {}): Promise<Response> {
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) throw new Error("公开内容下载只支持 GET/HEAD");
  try {
    return await publicFetch(input, { method: init.method as "GET" | "HEAD" | undefined, headers: init.headers, signal: init.signal ?? undefined, redirect: init.redirect === "manual" ? "manual" : "follow", maxBytes: 5 * 1024 * 1024 });
  } catch (error) { throw explainFetchError(error, service); }
}
