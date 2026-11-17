import { describe, expect, it } from "vitest";
import { gate, safeNext } from "./gate";

describe("gate", () => {
  it("sends signed-out visitors to login and remembers where they were going", () => {
    expect(gate("/", "", false)).toEqual({ kind: "redirect", to: "/login" });
    expect(gate("/items/abc", "", false)).toEqual({ kind: "redirect", to: "/login?next=%2Fitems%2Fabc" });
    // 手机上分享进来、还没登录：登录后接着存
    expect(gate("/share", "?url=https%3A%2F%2Fexample.com", false)).toEqual({ kind: "redirect", to: "/login?next=%2Fshare%3Furl%3Dhttps%253A%252F%252Fexample.com" });
  });

  it("lets public pages through, and keeps signed-in users out of the login page", () => {
    expect(gate("/login", "", false)).toEqual({ kind: "next" });
    expect(gate("/auth/confirm", "?code=x", false)).toEqual({ kind: "next" });
    expect(gate("/login", "", true)).toEqual({ kind: "redirect", to: "/" });
    expect(gate("/graph", "", true)).toEqual({ kind: "next" });
  });

  it("forwards an email-link code that landed on the site root", () => {
    expect(gate("/", "?code=abc", false)).toEqual({ kind: "redirect", to: "/auth/confirm?code=abc" });
  });
});

describe("safeNext", () => {
  it("accepts in-site paths only", () => {
    expect(safeNext("/items/1?x=1#a")).toBe("/items/1?x=1#a");
    expect(safeNext("/share?url=https%3A%2F%2Fa.com")).toBe("/share?url=https%3A%2F%2Fa.com");
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "", null, "/login", "/auth/confirm?code=1"]) expect(safeNext(bad)).toBe("/");
  });
});
