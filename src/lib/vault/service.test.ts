import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import type { Session } from "@/lib/auth/user";

let fake: FakeSupabase;
vi.mock("@/lib/supabase/service", () => ({ getServiceClient: () => fake.db }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/process-item", () => ({ processItem: vi.fn() }));

import { removeItem } from "./service";

const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ID = "11111111-1111-4111-8111-111111111111";
const session = (id: string) => ({ user: { id }, db: fake.db }) as unknown as Session;
const bytes = new Uint8Array([1, 2, 3]);

let localDir: string;
const localVideo = (user: string) => path.join(localDir, user, ID, "video.mp4");
beforeEach(async () => {
  localDir = await mkdtemp(path.join(os.tmpdir(), "vault-service-test-"));
  vi.stubEnv("VAULT_LOCAL_MEDIA_DIR", localDir);
  fake = makeFakeSupabase({ items: [{ id: ID, user_id: ME, source: "link", status: "ready", media: [] }] }, { rpc: { prune_orphan_entities: () => 0 } });
  // 这条内容转存的东西：存储桶里的封面、帧、帧格，服务器磁盘上的大视频原片
  for (const name of ["img-01.jpg", "frame-01.jpg", "sheet-01.jpg"]) await fake.db.storage.from("vault").upload(`${ME}/${ID}/${name}`, bytes);
  await mkdir(path.dirname(localVideo(ME)), { recursive: true });
  await writeFile(localVideo(ME), bytes);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(localDir, { recursive: true, force: true });
});

describe("removeItem", () => {
  it("deletes the row, its files in storage and its original on the server's disk", async () => {
    await removeItem(session(ME), ID);
    expect(fake.store.items).toEqual([]);
    expect([...fake.files.keys()]).toEqual([]);
    expect(existsSync(localVideo(ME))).toBe(false);
    expect(existsSync(path.dirname(localVideo(ME)))).toBe(false);
  });

  it("touches nothing of an item that belongs to someone else", async () => {
    await expect(removeItem(session(OTHER), ID)).rejects.toMatchObject({ status: 404 });
    expect(fake.store.items).toHaveLength(1);
    expect([...fake.files.keys()]).toHaveLength(3);
    expect(existsSync(localVideo(ME))).toBe(true);
  });
});
