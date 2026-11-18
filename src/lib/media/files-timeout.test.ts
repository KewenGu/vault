import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicFetch } = vi.hoisted(() => ({ publicFetch: vi.fn() }));
vi.mock("@/lib/network/public-fetch", async (original) => ({ ...(await original<typeof import("@/lib/network/public-fetch")>()), publicFetch }));

import { downloadRemote } from "./files";

describe("downloadRemote time limit", () => {
  beforeEach(() => {
    publicFetch.mockReset();
    publicFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  });

  it("hands its time limit to the guarded fetch, which otherwise cuts every download at 20 seconds", async () => {
    await downloadRemote({ url: "https://cdn.example.com/video.mp4" }, 600 * 1024 * 1024, 600_000);
    expect(publicFetch).toHaveBeenCalledTimes(1);
    expect(publicFetch.mock.calls[0][1]).toMatchObject({ timeoutMs: 600_000, maxBytes: 600 * 1024 * 1024 });
  });

  it("uses two minutes when the caller names no limit", async () => {
    await downloadRemote({ url: "https://cdn.example.com/cover.jpg" }, 1024);
    expect(publicFetch.mock.calls[0][1]).toMatchObject({ timeoutMs: 120_000 });
  });
});
