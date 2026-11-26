import { afterEach, describe, expect, it, vi } from "vitest";
import { meterInto } from "@/lib/usage/meter";
import { SourceFetchError } from "./types";
import { cleanWeiboText, mapWeibo, mapWeiboDetail, readWeiboPost, weiboTitle } from "./weibo";

const REFERER = { referer: "https://weibo.com/" };

/** actor 2026-11-26 实际返回的形状（get_post_detail，各留用得到的字段）。 */
const detail = (over: Record<string, unknown> = {}) => ({
  operation: "get_post_detail",
  post_id: "5369611206793532",
  content: "【#粽子式洋葱式橘子式#，你是什么式？】最近我国气温反复横跳，27—29日，#这个周末怎么穿对衣服#？建议粽子式穿衣法 ​​​",
  publish_time: 1795698537,
  post_url: "https://weibo.com/2803301701/RtcU8svj6",
  like_count: 475,
  comment_count: 208,
  repost_count: 149,
  play_count: null,
  read_count: null,
  image_urls: ["https://wx4.sinaimg.cn/mw2000/a.jpg", "https://wx2.sinaimg.cn/mw2000/b.jpg"],
  images: [
    { url: "https://wx4.sinaimg.cn/mw2000/a.jpg", width: 1080, height: 1440, content_statement: null },
    { url: "https://wx2.sinaimg.cn/mw2000/b.jpg", width: 1080, height: 1440, content_statement: null },
  ],
  topic_tags: [{ name: "粽子式洋葱式橘子式" }, { name: "这个周末怎么穿对衣服" }],
  author_user_id: "2803301701",
  author_name: "人民日报",
  // 带话题的微博：卡片是话题页，不是视频也不是文章
  video_video_page_url: "https://m.weibo.cn/search?containerid=231522type%3D1%26q%3D%23x%23&luicode=20000061",
  video_title: "#粽子式洋葱式橘子式#",
  video_video_id: null,
  video_duration_ms: null,
  video_video_url: null,
  video_cover_image_url: "https://wx4.sinaimg.cn/large/topic.jpg",
  video_width: null,
  video_height: null,
  ...over,
});
const ref = { externalId: "5369611206793532" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("微博：读一条（Apify）", () => {
  it("配图的微博：全文（末尾的零宽空格去掉）、作者、时间、互动数、话题、每一张图；图片下载要带 Referer", () => {
    expect(mapWeiboDetail(detail(), ref)).toEqual({
      platform: "weibo",
      externalId: "5369611206793532",
      kind: "image",
      title: "粽子式洋葱式橘子式，你是什么式？",
      text: "【#粽子式洋葱式橘子式#，你是什么式？】最近我国气温反复横跳，27—29日，#这个周末怎么穿对衣服#？建议粽子式穿衣法",
      author: { id: "2803301701", name: "人民日报" },
      publishedAt: "2026-11-26T13:08:57.000Z",
      stats: { views: null, likes: 475, collects: null, comments: 208, shares: 149 },
      hashtags: ["粽子式洋葱式橘子式", "这个周末怎么穿对衣服"],
      topComments: [],
      images: [
        { url: "https://wx4.sinaimg.cn/mw2000/a.jpg", width: 1080, height: 1440, headers: REFERER },
        { url: "https://wx2.sinaimg.cn/mw2000/b.jpg", width: 1080, height: 1440, headers: REFERER },
      ],
      video: null,
      music: null,
      notes: ["读不到评论内容，只有评论数"],
    });
    // 只给了地址、没给宽高的那种写法也认
    expect(mapWeiboDetail(detail({ images: [] }), ref).images).toEqual([
      { url: "https://wx4.sinaimg.cn/mw2000/a.jpg", width: null, height: null, headers: REFERER },
      { url: "https://wx2.sinaimg.cn/mw2000/b.jpg", width: null, height: null, headers: REFERER },
    ]);
  });

  it("带视频的微博：视频地址、时长、播放量，图只要封面；actor 接在正文末尾的卡片标题拿掉", () => {
    const post = mapWeiboDetail(
      detail({
        content: "【分享！#甘孜日照金山#】摄影师拍下日照金山与人间烟火同框↓↓#视界这么美#（人民号：Vito刘西滨） 人民日报的微博视频",
        images: [],
        image_urls: [],
        play_count: 100000,
        topic_tags: [],
        video_video_page_url: "https://video.weibo.com/show?fid=1034%3A5369618798411795&luicode=20000061",
        video_title: "人民日报的微博视频",
        video_video_id: "1034:5369618798411795",
        video_duration_ms: 15882,
        video_video_url: "https://f.video.weibocdn.com/o0/x.mp4?label=mp4_720p&Expires=1795713257&ssig=abc",
        video_cover_image_url: "https://wx4.sinaimg.cn/orj480/cover.jpg",
      }),
      ref,
    );
    expect(post.kind).toBe("video");
    expect(post.text).toBe("【分享！#甘孜日照金山#】摄影师拍下日照金山与人间烟火同框↓↓#视界这么美#（人民号：Vito刘西滨）");
    expect(post.title).toBe("分享！甘孜日照金山");
    expect(post.video).toEqual({ url: "https://f.video.weibocdn.com/o0/x.mp4?label=mp4_720p&Expires=1795713257&ssig=abc", width: null, height: null, bytes: null, durationS: 15.9, headers: REFERER });
    expect(post.images).toEqual([{ url: "https://wx4.sinaimg.cn/orj480/cover.jpg", width: null, height: null, headers: REFERER }]);
    expect(post.stats.views).toBe(100000);
    // actor 没给话题时从正文里找成对的井号
    expect(post.hashtags).toEqual(["甘孜日照金山", "视界这么美"]);
    expect(post.links).toBeUndefined();
    expect(post.notes).toEqual(["读不到评论内容，只有评论数"]);
  });

  it("是视频但没给视频地址：文字和封面留着，说清楚画面和口播没读到", () => {
    const post = mapWeiboDetail(detail({ images: [], image_urls: [], video_video_id: "1034:1", video_video_page_url: "https://video.weibo.com/show?fid=1034%3A1", video_title: "某某的微博视频", video_cover_image_url: "https://wx4.sinaimg.cn/orj480/cover.jpg" }), ref);
    expect(post.kind).toBe("video");
    expect(post.video).toBeNull();
    expect(post.images).toHaveLength(1);
    expect(post.notes).toContain("没有拿到视频地址，只读到了封面和文字：画面和里面说的话都没读到");
  });

  it("带文章的微博：算文字，文章按手机版的地址跟着读（地址留在 links 里，来源参数去掉）；卡片的题图不算这条微博的图", () => {
    const { post, mentions } = mapWeibo(
      detail({
        // actor 把文章的标题接在正文末尾；卡片标题给的是作者名
        content: "【夜读：#不高估困难不低估自己#】人生就像一场漫长的马拉松。#人民日报夜读#，与你共勉。 【夜读】不要高估困难，更不要低估自己",
        images: [],
        image_urls: [],
        video_video_page_url: "https://weibo.com/ttarticle/p/show?id=2309405369631686132718&luicode=20000061&lfid=5369631688884759&launchid=10000360-page_H5",
        video_title: "人民日报",
        video_cover_image_url: "https://wx4.sinaimg.cn/large/article.jpg",
      }),
      ref,
    );
    expect(post.kind).toBe("text");
    expect(post.images).toEqual([]);
    expect(post.text).toBe("【夜读：#不高估困难不低估自己#】人生就像一场漫长的马拉松。#人民日报夜读#，与你共勉。 【夜读】不要高估困难，更不要低估自己");
    expect(post.links).toEqual([{ text: "", url: "https://weibo.com/ttarticle/p/show?id=2309405369631686132718" }]);
    expect(post.notes).toEqual(["读不到评论内容，只有评论数"]);
    expect(mentions).toEqual([{ how: "link", url: "https://card.weibo.com/article/m/show/id/2309405369631686132718", ref: { platform: "web", externalId: expect.stringMatching(/^[0-9a-f]{32}$/), url: "https://card.weibo.com/article/m/show/id/2309405369631686132718" } }]);
  });

  it("带外链的微博：链接跟着读（认得的平台走那个平台的读法）；微博自己的别的卡片（超话、地点）、话题、视频不跟", () => {
    const card = (url: string, title = "卡片") => mapWeibo(detail({ video_video_page_url: url, video_title: title }), ref);
    expect(card("https://www.youtube.com/watch?v=dQw4w9WgXcQ&luicode=20000061", "一个视频").mentions).toEqual([{ how: "link", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", ref: { platform: "youtube", externalId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }]);
    expect(card("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "一个视频").post.links).toEqual([{ text: "一个视频", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]);
    expect(card("https://example.com/a?luicode=1").mentions).toMatchObject([{ how: "link", url: "https://example.com/a", ref: { platform: "web" } }]);
    for (const url of ["https://weibo.com/p/1008087f5f1e7d5a?luicode=1", "https://m.weibo.cn/p/index?containerid=2306570042B2094654D06FA3FD", "不是地址"]) {
      const got = card(url);
      expect(got.mentions, url).toEqual([]);
      expect(got.post.links, url).toBeUndefined();
    }
    expect(mapWeibo(detail(), ref).mentions).toEqual([]);
    expect(mapWeibo(detail({ video_video_id: "1034:1", video_video_page_url: "https://video.weibo.com/show?fid=1034%3A1", video_title: "某某的微博视频" }), ref).mentions).toEqual([]);
  });

  it("没读到（空的、不是这一条、什么内容都没有）：读不到", () => {
    for (const bad of [undefined, {}, detail({ post_id: "5369611206793533" }), detail({ content: " ​", images: [], image_urls: [] })]) {
      expect(() => mapWeiboDetail(bad, ref)).toThrow(SourceFetchError);
    }
    expect(() => mapWeiboDetail(undefined, ref)).toThrow("这条微博读不到：可能被删了、设成了仅自己或仅粉丝可见，或者链接不对");
  });

  it("标题：开头的「【标题】」优先，没有用第一行；话题留字去井号，短链去掉；正文末尾补的零宽空格不算", () => {
    expect(weiboTitle("【#你好，明天#｜#当校门口开卖纸质短剧#】“纸质短剧”在小学生中悄然流行")).toBe("你好，明天｜当校门口开卖纸质短剧");
    expect(weiboTitle("第一期#声生不息天涯共此时# 上线。看了吗？ http://t.cn/AXTnnihj ​​​")).toBe("第一期声生不息天涯共此时 上线。看了吗？");
    expect(weiboTitle("\n\n致敬！\n第二行")).toBe("致敬！");
    // 括号里太短的不当标题（「【转】」）
    expect(weiboTitle("【转】今天的事")).toBe("【转】今天的事");
    expect(weiboTitle("一二三四五六七八九十", 4)).toBe("一二三四");
    expect(weiboTitle("#只有话题# http://t.cn/x")).toBe("只有话题");
    expect(cleanWeiboText("第一行  \n第二行 ​​​")).toBe("第一行\n第二行");
  });

  it("一次同步运行：按数字 id 读，令牌放请求头；读到了记一笔", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify([detail()]), { status: 201 });
    });
    const counts: Record<string, number> = {};
    const { post, mentions } = await meterInto(counts, () => readWeiboPost(ref));
    expect(post.author.name).toBe("人民日报");
    expect(mentions).toEqual([]);
    expect(calls).toEqual([{ url: "https://api.apify.com/v2/acts/socialdatax~socialdatax-weibo-data-api/run-sync-get-dataset-items?timeout=110", auth: "Bearer apify_secret_1", body: { operation: "get_post_detail", post_id: "5369611206793532" } }]);
    expect(counts).toEqual({ apify_weibo_post: 1 });
  });

  it("没配令牌说清楚；微博不存在（actor 返回空的）是读不到，不记账；actor 可以用环境变量换", async () => {
    await expect(readWeiboPost(ref)).rejects.toThrow("读微博要用 Apify（环境变量 APIFY_TOKEN 没配）");
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    vi.stubEnv("APIFY_WEIBO_ACTOR", "someone~other");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("[]", { status: 201 });
    });
    const counts: Record<string, number> = {};
    await expect(meterInto(counts, () => readWeiboPost(ref))).rejects.toThrow(SourceFetchError);
    expect(urls[0]).toContain("/acts/someone~other/");
    expect(counts.apify_weibo_post ?? 0).toBe(0);
  });

  it("那次运行失败了（微博不存在时 actor 会这样）：算读不到，说清楚也可能是临时出错；别的 400 照旧报错", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_secret_1");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: qH2qBB69hSwaY9cRK, status: FAILED)." } }), { status: 400 }));
    const failed = await readWeiboPost(ref).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(SourceFetchError);
    expect((failed as Error).message).toBe("这条微博读不到：可能被删了、设成了仅自己或仅粉丝可见，或者链接不对（读它的那次 Apify 运行失败了：微博不存在时会这样，也可能是那边临时出错，过一会儿可以再试）");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { type: "invalid-input", message: "Input is not valid" } }), { status: 400 }));
    const invalid = await readWeiboPost(ref).catch((e: unknown) => e);
    expect(invalid).not.toBeInstanceOf(SourceFetchError);
    expect((invalid as Error).message).toContain("400: ");
  });
});
