import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemMedia } from "@/lib/sources/types";

const state = vi.hoisted(() => ({ session: null as { user: { id: string }; db: object } | null, media: [] as unknown[], signed: vi.fn() }));
vi.mock("@/lib/auth/user", () => ({ apiSession: async () => state.session }));
vi.mock("@/lib/vault/store", async (orig) => ({ ...(await orig<object>()), getItem: async (_db: unknown, userId: string, id: string) => (userId === USER && id === ITEM ? { id, userId, media: state.media } : null) }));
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => ({ storage: { from: () => ({ createSignedUrl: state.signed }) } }) }));

import { GET } from "./route";

const USER = "22222222-2222-4222-8222-222222222222";
const ITEM = "11111111-1111-4111-8111-111111111111";
const video = (over: Partial<ItemMedia> = {}): ItemMedia => ({ role: "video", path: `${USER}/${ITEM}/video.mp4`, mime: "video/mp4", width: 1280, height: 720, bytes: 10, ...over });
const get = (id: string, file: string, range?: string) => GET(new Request(`https://vault.example/media/${id}/${file}`, { headers: range ? { range } : {} }), { params: Promise.resolve({ id, file }) });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "vault-media-route-test-"));
  vi.stubEnv("VAULT_LOCAL_MEDIA_DIR", dir);
  await mkdir(path.join(dir, USER, ITEM), { recursive: true });
  await writeFile(path.join(dir, USER, ITEM, "video.mp4"), "0123456789");
  state.session = { user: { id: USER }, db: {} };
  state.media = [video({ local: true })];
  state.signed.mockReset().mockResolvedValue({ data: { signedUrl: "https://storage.example/signed" }, error: null });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /media/<item>/<file>", () => {
  it("plays an original kept on this server's disk, in parts, without going to storage", async () => {
    const res = await get(ITEM, "video.mp4", "bytes=0-3");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(await res.text()).toBe("0123");
    expect((await get(ITEM, "video.mp4")).status).toBe(200);
    expect(state.signed).not.toHaveBeenCalled();
  });

  it("only for the signed-in owner, and only files registered on the item", async () => {
    state.session = { user: { id: "33333333-3333-4333-8333-333333333333" }, db: {} };
    expect((await get(ITEM, "video.mp4")).status).toBe(404);
    state.session = null;
    expect((await get(ITEM, "video.mp4")).status).toBe(401);
    state.session = { user: { id: USER }, db: {} };
    expect((await get(ITEM, "other.mp4")).status).toBe(404);
  });

  it("says so when the original is no longer on the disk", async () => {
    await rm(path.join(dir, USER, ITEM, "video.mp4"));
    const res = await get(ITEM, "video.mp4");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("原片不在这台服务器的磁盘上了");
  });

  it("still redirects to storage for files kept there", async () => {
    state.media = [video()];
    const res = await get(ITEM, "video.mp4");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.example/signed");
  });
});
