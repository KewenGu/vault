import { describe, expect, it } from "vitest";
import { allowedEmails, isAllowed } from "./allowlist";

describe("email allowlist", () => {
  it("is open when unset", () => {
    expect(allowedEmails({})).toBeNull();
    expect(isAllowed("anyone@example.com", {})).toBe(true);
    expect(isAllowed(null, { VAULT_ALLOWED_EMAILS: "  " })).toBe(true);
  });

  it("only lets listed emails in, ignoring case and spacing", () => {
    const env = { VAULT_ALLOWED_EMAILS: "Me@Example.com, other@example.com" };
    expect(isAllowed("me@example.com", env)).toBe(true);
    expect(isAllowed("OTHER@example.com", env)).toBe(true);
    expect(isAllowed("stranger@example.com", env)).toBe(false);
    expect(isAllowed(undefined, env)).toBe(false);
  });
});
