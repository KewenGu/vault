/**
 * iPhone 上「分享到 Vault」靠的快捷指令（纯函数，/mobile 页用）。
 * iOS 的 Safari 不认 manifest 里的 share_target，网页也不能不经确认读剪贴板；快捷指令两样都能做：
 * 收下分享菜单给的链接 / 文字（或者剪贴板），编码后打开 /share?b64=…，落到确认页。
 *
 * 内容用 Base64 传，不用百分号编码：2026-11-19 在 iOS 26 上实测，快捷指令打开 /share?text=<百分号编码的抖音分享文案>，
 * Safari 请求到的地址在一个汉字的编码中间就断了（服务器收到 31 个字节，页面上是「…看\uFFFD」）；同一个地址直接请求线上是完整的。
 * 断在哪一环没查实（推测是按解码后的长度截了编码后的地址），Base64 的字符不需要转义，绕开这个问题。
 */

/** 快捷指令里拼地址用的前半段：后面直接接 Base64 编码过的内容。 */
export function shareAddress(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/share?b64=`;
}

export type SharedText =
  | { ok: true; text: string }
  /** received = 收到的 Base64 字符数；readable = 还能读出来的那部分文字（给人看、定位用，不拿去存） */
  | { ok: false; received: number; readable: string; reason: string };

/**
 * 解开快捷指令传来的 Base64 内容。解不开时不当成没收到：说出收到了多少、能读出哪一段、卡在哪，
 * 页面上原样列出来（传到一半被截断的话，一看就知道断在哪）。
 * 查询串里的 + 到这里已经被当成空格；URL 安全写法的 - _ 也认。
 */
export function readSharedText(raw: string): SharedText {
  const b64 = raw.replace(/[\r\n\t]/g, "").replace(/[ -]/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bad = b64.replace(/[A-Za-z0-9+/]/g, "");
  const bytes = Buffer.from(b64, "base64");
  // 宽松地读一遍：坏掉的字节变成 \uFFFD，结尾那个半截的字去掉
  const readable = bytes.toString("utf8").replace(/\uFFFD+$/, "");
  const fail = (reason: string): SharedText => ({ ok: false, received: raw.length, readable, reason });
  if (!b64) return fail("内容是空的");
  if (bad) return fail(`里面混进了不属于 Base64 的字符（${Array.from(new Set(bad)).slice(0, 5).join(" ")}）`);
  if (b64.length % 4 === 1) return fail("长度不对，像是被截断了");
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return fail(readable.includes("\uFFFD") ? "解出来的不是文字" : "结尾断在一个字的中间，像是被截断了");
  }
}

/** 只要结果：解不开返回 null。 */
export function decodeSharedText(raw: string): string | null {
  const read = readSharedText(raw);
  return read.ok ? read.text : null;
}

export type ShortcutInstall = { kind: "none" } | { kind: "link"; url: string } | { kind: "invalid"; reason: string };

/**
 * 「安装快捷指令」按钮指向哪里。快捷指令只能从苹果设备上分享出来（iCloud 链接，苹果签名），网站自己生成不了，
 * 所以这是一个配置项：做好一次、拷出 iCloud 链接、填进 VAULT_IOS_SHORTCUT_URL。
 * 只认 iCloud 的快捷指令链接（国区是 icloud.com.cn）——填错了要说出来，不能悄悄当成没配。
 */
export function shortcutInstall(raw: string | undefined): ShortcutInstall {
  const value = raw?.trim();
  if (!value) return { kind: "none" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid", reason: "不是一个网址" };
  }
  const icloud = url.protocol === "https:" && /^(www\.)?icloud\.com(\.cn)?$/.test(url.hostname);
  if (!icloud || !/^\/shortcuts\/[\w-]+\/?$/.test(url.pathname)) return { kind: "invalid", reason: "不是 iCloud 的快捷指令链接（应该长这样：https://www.icloud.com/shortcuts/…）" };
  return { kind: "link", url: url.toString() };
}
