import { describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "@/test/fake-supabase";
import { readZip, text } from "@/test/read-zip";

const USER = "11111111-1111-4111-8111-111111111111";
const apiSession = vi.fn();
vi.mock("@/lib/auth/user", () => ({ apiSession: (request: Request) => apiSession(request) }));

import { GET } from "./route";

const row = { id: "00000001-0000-4000-8000-000000000000", user_id: USER, source: "text", dedupe_key: "k", status: "ready", title: "随手记", user_text: "一段文字", media: [], tags: [], tags_locked: false, cost_usd: 0, started_at: "2026-11-20T00:00:00.000Z", created_at: "2026-11-20T00:00:00.000Z", updated_at: "2026-11-20T00:00:00.000Z" };

describe("GET /api/v1/export", () => {
  it("refuses without a session", async () => {
    apiSession.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://localhost/api/v1/export"));
    expect(res.status).toBe(401);
  });

  it("streams a zip download that opens, named after the day", async () => {
    apiSession.mockResolvedValueOnce({ user: { id: USER }, db: makeFakeSupabase({ items: [row] }).db });
    const res = await GET(new Request("http://localhost/api/v1/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const name = /^attachment; filename="(vault-export-\d{4}-\d{2}-\d{2})\.zip"$/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    expect(name).toBeTruthy();
    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    expect(text(files.get(`${name}/items/2026-11/2026-11-20 随手记 (00000001).md`))).toContain("## 原文\n\n一段文字");
    expect(text(files.get(`${name}/README.md`))).toContain("- 内容：1");
  });
});
