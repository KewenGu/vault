/**
 * iPhone 上「分享到 Vault」靠的快捷指令（纯函数，/mobile 页用）。
 * iOS 的 Safari 不认 manifest 里的 share_target，网页也不能不经确认读剪贴板；快捷指令两样都能做：
 * 收下分享菜单给的链接 / 文字（或者剪贴板），编码后打开 /share?text=…，落到确认页。
 */

/** 快捷指令里「打开 URL」那一步填的地址：后面直接接编码过的内容。 */
export function shareAddress(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/share?text=`;
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
