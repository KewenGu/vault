import { describe, expect, it } from "vitest";
import { countFacets } from "./facets";
import { STUCK_MS, stuckMs, coverOf, displayTitle, inProgress, isStuck, itemFileUrl, linkDedupeKey, sourceLabel, toItem } from "./store";
import { cleanTags, parseTagInput } from "./taxonomy";

const row = (patch: Record<string, unknown> = {}) =>
  toItem({
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "u",
    source: "link",
    dedupe_key: "k",
    platform: "douyin",
    external_id: "1",
    url: "https://www.douyin.com/video/1",
    status: "ready",
    error: null,
    kind: "video",
    title: null,
    author: null,
    media: [],
    summary: null,
    content_type: null,
    category: null,
    tags: [],
    tags_locked: false,
    note: null,
    cost_usd: 0,
    started_at: "2026-11-17T00:00:00.000Z",
    processed_at: null,
    created_at: "2026-11-17T00:00:00.000Z",
    updated_at: "2026-11-17T00:00:00.000Z",
    ...patch,
  } as never);

describe("toItem", () => {
  it("reads a list row (without the heavy columns) into safe defaults", () => {
    const item = row();
    expect(item.transcript).toBeNull();
    expect(item.understanding).toBeNull();
    expect(item.post.text).toBe("");
    expect(item.contentType).toBeNull();
  });

  it("maps unknown values to safe ones instead of crashing the page", () => {
    const item = row({ platform: "newsite", status: "weird", kind: "hologram", content_type: "poem", category: "mars", media: [{ role: "image", path: "u/i/img-01.jpg" }, { role: "nope", path: "x" }, "junk"] });
    expect(item.platform).toBe("web");
    expect(item.status).toBe("failed");
    expect(item.kind).toBeNull();
    expect(item.contentType).toBe("other");
    expect(item.category).toBe("other");
    expect(item.media).toHaveLength(1);
  });
});

describe("display helpers", () => {
  it("names untitled items by where they came from", () => {
    expect(displayTitle(row())).toBe("抖音视频");
    expect(displayTitle(row({ title: "有标题" }))).toBe("有标题");
    expect(displayTitle(row({ source: "text", platform: null, kind: "text", user_text: "明天买牛奶\n还有鸡蛋" }))).toBe("明天买牛奶");
    expect(displayTitle(row({ source: "upload", platform: null, kind: "audio" }))).toBe("上传的音频");
    expect(sourceLabel(row())).toBe("抖音");
    expect(sourceLabel(row({ source: "upload", platform: null }))).toBe("上传");
    expect(linkDedupeKey({ platform: "youtube", externalId: "abc" })).toBe("youtube:abc");
  });

  it("builds file urls that change with each processing round, and picks a cover", () => {
    const item = row({ media: [{ role: "frame", path: "u/i/frame-01.jpg", at: 3 }, { role: "video", path: "u/i/video.mp4" }] });
    expect(itemFileUrl(item, item.media[1])).toMatch(/^\/media\/11111111-1111-4111-8111-111111111111\/video\.mp4\?v=[a-z0-9]+$/);
    expect(coverOf(item)?.path).toBe("u/i/frame-01.jpg");
    expect(coverOf(row())).toBeNull();
  });

  it("tells running from stuck by how long ago the round started", () => {
    const started = new Date("2026-11-17T00:00:00.000Z").getTime();
    const item = row({ status: "analyzing" });
    expect(inProgress(item, started + 60_000)).toBe(true);
    expect(isStuck(item, started + 60_000)).toBe(false);
    expect(isStuck(item, started + STUCK_MS + 1)).toBe(true);
    expect(isStuck(row({ status: "ready" }), started + STUCK_MS * 10)).toBe(false);
  });
});

describe("stuckMs", () => {
  it("is 20 minutes unless a sensible number of minutes is set", () => {
    expect(stuckMs({})).toBe(20 * 60_000);
    expect(stuckMs({ VAULT_STUCK_MINUTES: "60" })).toBe(60 * 60_000);
    expect(stuckMs({ VAULT_STUCK_MINUTES: "1" })).toBe(20 * 60_000);
    expect(stuckMs({ VAULT_STUCK_MINUTES: "abc" })).toBe(20 * 60_000);
  });
});

describe("tags", () => {
  it("cleans, de-duplicates and caps tags", () => {
    expect(cleanTags(["#三亚", " 三亚 ", "Sous  Vide", "sous vide", ""])).toEqual(["三亚", "Sous Vide"]);
    expect(parseTagInput("三亚，亲子游、 酒店;#美食 #探店")).toEqual(["三亚", "亲子游", "酒店", "美食", "探店"]);
  });
});

describe("countFacets", () => {
  it("counts by type, category and origin, skipping uploads that never arrived", () => {
    const f = countFacets([
      { content_type: "recipe", category: "food", platform: "douyin", source: "link", status: "ready" },
      { content_type: "recipe", category: "food", platform: null, source: "upload", status: "ready" },
      { content_type: null, category: null, platform: null, source: "text", status: "analyzing" },
      { content_type: null, category: null, platform: null, source: "upload", status: "uploading" },
    ]);
    expect(f.total).toBe(3);
    expect(Object.fromEntries(f.contentType)).toEqual({ recipe: 2 });
    expect(Object.fromEntries(f.origin)).toEqual({ douyin: 1, upload: 1, text: 1 });
  });
});
