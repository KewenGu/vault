import { publicHttpUrl } from "@/lib/network/public-ip";

/** Cheap URL prefilter. Fetching also pins verified public DNS at the socket. */
export function assertSafeUrl(url: string): boolean {
  try { publicHttpUrl(url); return true; } catch { return false; }
}
