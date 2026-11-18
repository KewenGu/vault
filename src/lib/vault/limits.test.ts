import { describe, expect, it } from "vitest";
import { storeMaxBytes } from "./limits";

const MB = 1024 * 1024;

describe("storeMaxBytes", () => {
  it("defaults to the free plan's 50 MB", () => {
    expect(storeMaxBytes({})).toBe(50 * MB);
    expect(storeMaxBytes({ VAULT_STORE_MAX_MB: "" })).toBe(50 * MB);
    expect(storeMaxBytes({ VAULT_STORE_MAX_MB: "abc" })).toBe(50 * MB);
    expect(storeMaxBytes({ VAULT_STORE_MAX_MB: "0" })).toBe(50 * MB);
  });

  it("follows the setting, up to what the bucket allows", () => {
    expect(storeMaxBytes({ VAULT_STORE_MAX_MB: "120" })).toBe(120 * MB);
    expect(storeMaxBytes({ VAULT_STORE_MAX_MB: "20" })).toBe(20 * MB);
    expect(storeMaxBytes({ VAULT_STORE_MAX_MB: "5000" })).toBe(200 * MB);
  });
});
