import { isIP } from "node:net";

/** Only globally routable unicast addresses may be used by an untrusted URL. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(ip) !== 6 || ip.includes("%")) return false;
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map((x) => parseInt(x, 16));
  if (words.slice(0, 5).every((x) => x === 0) && words[5] === 0xffff) {
    return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Exclude non-global IPv6, IPv4 tunnelling and special-purpose assignments.
  return words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) &&
    words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1] < 0x1000);
}

export function publicHttpUrl(input: string): URL {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !host ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || (!host.includes(".") && !isIP(host)) ||
      (isIP(host) && !isPublicAddress(host))) throw new Error("地址不安全：只允许公开 HTTP/HTTPS 地址");
  url.hash = "";
  return url;
}
