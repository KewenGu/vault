import { describe, expect, it } from "vitest";
import { decodeSharedText, readSharedText, shareAddress, shortcutInstall } from "./shortcut";

describe("shareAddress", () => {
  it("接在站点地址后面，不重复斜杠", () => {
    expect(shareAddress("https://vault.example.com")).toBe("https://vault.example.com/share?b64=");
    expect(shareAddress("https://vault.example.com/")).toBe("https://vault.example.com/share?b64=");
  });
});

describe("decodeSharedText", () => {
  const share = "6.99 复制打开抖音，看看【🐎飒露紫 🇨🇳🇫🇷的图文作品】生活的苦，只是体力与情绪的重复； # 日落\nhttps://v.douyin.com/iAbCdEf/ m@Q.Kj 03/21";
  const b64 = Buffer.from(share, "utf8").toString("base64");

  it("解开整段分享文案（含表情和换行）", () => {
    expect(decodeSharedText(b64)).toBe(share);
  });

  it("查询串把 + 变成了空格、去掉了末尾的 =、用了 URL 安全写法，都能解", () => {
    expect(b64).toMatch(/[+/]/);
    expect(decodeSharedText(b64.replace(/\+/g, " "))).toBe(share);
    expect(decodeSharedText(b64.replace(/=+$/, ""))).toBe(share);
    expect(decodeSharedText(Buffer.from(share, "utf8").toString("base64url"))).toBe(share);
  });

  it("解不开的返回 null：空的、混进别的字符、截在一个字中间", () => {
    expect(decodeSharedText("")).toBeNull();
    expect(decodeSharedText("%E7%9C%8B")).toBeNull();
    expect(decodeSharedText(Buffer.from("看看", "utf8").subarray(0, 5).toString("base64"))).toBeNull();
  });
});

describe("readSharedText", () => {
  const share = "6.99 复制打开抖音，看看【🐎飒露紫】生活的苦 https://v.douyin.com/iAbCdEf/";
  const bytes = Buffer.from(share, "utf8");

  it("截在一个字中间：说出收到多少、能读出哪一段", () => {
    const cut = bytes.subarray(0, 31).toString("base64").replace(/=+$/, "");
    expect(readSharedText(cut)).toEqual({ ok: false, received: cut.length, readable: "6.99 复制打开抖音，看", reason: "结尾断在一个字的中间，像是被截断了" });
  });

  it("Base64 本身断了一截、混进别的字符、不是文字，原因分开说", () => {
    const b64 = bytes.toString("base64");
    expect(readSharedText(b64.slice(0, 41))).toMatchObject({ ok: false, reason: "长度不对，像是被截断了" });
    expect(readSharedText("%E7%9C%8B")).toMatchObject({ ok: false, reason: "里面混进了不属于 Base64 的字符（%）" });
    expect(readSharedText(Buffer.from([0xff, 0xfe, 0x36, 0x00, 0x2e, 0x00]).toString("base64"))).toMatchObject({ ok: false, reason: "解出来的不是文字" });
    expect(readSharedText("")).toMatchObject({ ok: false, reason: "内容是空的" });
  });

  it("完整的照常解开", () => {
    expect(readSharedText(bytes.toString("base64"))).toEqual({ ok: true, text: share });
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
