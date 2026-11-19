import { describe, expect, it } from "vitest";
import { shareAddress, shortcutInstall } from "./shortcut";

describe("shareAddress", () => {
  it("接在站点地址后面，不重复斜杠", () => {
    expect(shareAddress("https://vault.example.com")).toBe("https://vault.example.com/share?text=");
    expect(shareAddress("https://vault.example.com/")).toBe("https://vault.example.com/share?text=");
  });
});

describe("shortcutInstall", () => {
  it("没配就是没有", () => {
    expect(shortcutInstall(undefined)).toEqual({ kind: "none" });
    expect(shortcutInstall("  ")).toEqual({ kind: "none" });
  });

  it("认 iCloud 的快捷指令链接（含国区域名）", () => {
    expect(shortcutInstall(" https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef ")).toEqual({ kind: "link", url: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef" });
    expect(shortcutInstall("https://www.icloud.com.cn/shortcuts/0123456789abcdef0123456789abcdef").kind).toBe("link");
  });

  it("别的地址不当成安装链接，并说明原因", () => {
    for (const bad of ["not a url", "http://www.icloud.com/shortcuts/abc", "https://evil.example/shortcuts/abc", "https://www.icloud.com.evil.example/shortcuts/abc", "https://www.icloud.com/photos/abc", "javascript:alert(1)"]) {
      expect(shortcutInstall(bad).kind, bad).toBe("invalid");
    }
  });
});
