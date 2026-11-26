import { afterEach, describe, expect, it, vi } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { SourceFetchError } from "./types";
import { fetchXhsViaApify, mapXhsDetail } from "./xhs-apify";

/** actor 2026-11-26 实际返回的形状（留用得到的字段）。 */
const detail = (over: Record<string, unknown> = {}) => ({
  operation: "get_note_detail",
  note_id: "6a06c9360000000036001d5a",
  note_url: "https://www.xiaohongshu.com/explore/6a06c9360000000036001d5a?xsec_token=CB7U",
  note_type: "image",
  title: " 审美积累｜勇敢、自由、有力量 ",
  content: "分享一位健身博主。\n\t\n#审美累积[话题]# #户外穿搭[话题]#",
  cover_image_url: "https://sns-img-qc.xhscdn.com/spectrum/a?imageView2/2/format/webp",
  image_items: [
    { image_url: "https://sns-img-qc.xhscdn.com/spectrum/a?imageView2/2/format/webp", width: 1080, height: 1417, live_photo: null },
    { image_url: "https://sns-img-qc.xhscdn.com/spectrum/b?imageView2/2/format/webp", width: 1080, height: 1360, live_photo: null },
    { image_url: "" },
  ],
  like_count: 2617,
  collect_count: 501,
  comment_count: 21,
  share_count: 146,
  publish_time: 1778829622,
  topic_tags: [{ name: "审美累积", id: "1" }, { name: " 户外穿搭 ", id: "2" }, { id: "3" }],
  author_user_id: "5c0892a5000000000500f3b6",
  author_name: "艺文搭搭",
  content_statement: null,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("小红书：按笔记 id 走 Apify 读一篇", () => {
  it("图文：每一张图都要，正文里的话题写法理顺，互动数、话题、作者、发布时间都读到", () => {
    expect(mapXhsDetail(detail(), "6a06c9360000000036001d5a")).toEqual({
      platform: "xiaohongshu",
      externalId: "6a06c9360000000036001d5a",
      kind: "image",
      title: "审美积累｜勇敢、自由、有力量",
      text: "分享一位健身博主。\n\n#审美累积 #户外穿搭",
      author: { id: "5c0892a5000000000500f3b6", name: "艺文搭搭" },
      publishedAt: "2026-05-15T07:20:22.000Z",
      stats: { views: null, likes: 2617, collects: 501, comments: 21, shares: 146 },
      hashtags: ["审美累积", "户外穿搭"],
      topComments: [],
      images: [
        { url: "https://sns-img-qc.xhscdn.com/spectrum/a?imageView2/2/format/webp", width: 1080, height: 1417 },
        { url: "https://sns-img-qc.xhscdn.com/spectrum/b?imageView2/2/format/webp", width: 1080, height: 1360 },
      ],
      video: null,
      music: null,
      notes: ["这条路读不到评论内容，只有评论数"],
    });
  });

  it("视频：只留封面，带上视频地址和时长；没给地址记一句", () => {
    const video = { note_type: "video", video_video_url: "https://sns-video-al.xhscdn.com/stream/x.mp4?v=2", video_duration_ms: 155000, video_width: 720, video_height: 1280, content_statement: "内容包含虚构演绎" };
    const got = mapXhsDetail(detail(video), "6a06c9360000000036001d5a");
    expect(got.kind).toBe("video");
    expect(got.images).toHaveLength(1);
    expect(got.video).toEqual({ url: "https://sns-video-al.xhscdn.com/stream/x.mp4?v=2", width: 720, height: 1280, bytes: null, durationS: 155 });
    expect(got.notes).toEqual(["这条路读不到评论内容，只有评论数", "作者声明：内容包含虚构演绎"]);
    const missing = mapXhsDetail(detail({ ...video, video_video_url: null, image_items: [] }), "6a06c9360000000036001d5a");
    expect(missing.video).toBeNull();
    expect(missing.images).toEqual([{ url: "https://sns-img-qc.xhscdn.com/spectrum/a?imageView2/2/format/webp", width: null, height: null }]);
    expect(missing.notes).toContain("没有拿到视频地址，只读到了封面");
  });

  it("没有这一篇（actor 返回空数组）、返回的不是要的那篇：读不到", () => {
    expect(() => mapXhsDetail(undefined, "6a06c9360000000036001d5a")).toThrow(SourceFetchError);
    expect(() => mapXhsDetail(detail(), "ffffffffffffffffffffffff")).toThrow(/这篇小红书笔记读不到/);
  });

  it("一次同步运行：令牌在请求头里；读到了记一笔，没读到不记", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    let items: unknown[] = [detail()];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(items), { status: 201, headers: { "content-type": "application/json" } });
    });
    const counts: Record<string, number> = {};
    const post = await meterInto(counts, () => fetchXhsViaApify({ externalId: "6a06c9360000000036001d5a" }));
    expect(post.title).toBe("审美积累｜勇敢、自由、有力量");
    expect(calls).toEqual([{ url: "https://api.apify.com/v2/acts/socialdatax~socialdatax-xhs-data-api/run-sync-get-dataset-items?timeout=110", auth: "Bearer apify_secret_1", body: { operation: "get_note_detail", note_id: "6a06c9360000000036001d5a" } }]);
    expect(counts).toEqual({ apify_xhs_note: 1 });

    items = [];
    const none: Record<string, number> = {};
    await expect(meterInto(none, () => fetchXhsViaApify({ externalId: "6a06c9360000000036001d5a" }))).rejects.toThrow(SourceFetchError);
    expect(none).toEqual({});
  });

  it("actor 可以用环境变量换；没配令牌说清楚", async () => {
    await expect(fetchXhsViaApify({ externalId: "1" })).rejects.toThrow("不带访问口令读小红书要用 Apify（环境变量 APIFY_TOKEN 没配）");
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    vi.stubEnv("APIFY_XHS_ACTOR", "someone~other");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("[]", { status: 201 });
    });
    await expect(fetchXhsViaApify({ externalId: "1" })).rejects.toThrow(SourceFetchError);
    expect(urls[0]).toContain("/acts/someone~other/");
  });
});
