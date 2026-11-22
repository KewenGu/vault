import { describe, it, expect, vi, afterEach } from "vitest";
import { RedditArchiveMiss, flattenComments, mapRedditPost, pickComments, pickDashAudio, readRedditPost } from "./reddit";
import { SourceFetchError } from "./types";

/**
 * 下面的帖子和评论是从 Arctic Shift 真实返回的内容里缩出来的（2026-11-22 读的；只留了用得到的字段，正文截短了）。
 * 存档给的是没转义的原文。
 */
const selfPost = {
  id: "1xv8a46",
  title: "Vegetable side to bring to pot luck (host is making lasagna)?",
  selftext: "We will be going to an Italian-themed pot luck next week where the host will be providing the main entree — lasagna.",
  author: "AlicePalace2",
  author_fullname: "t2_4jvrtj78",
  subreddit: "Cooking",
  created_utc: 1794577559,
  retrieved_on: 1794577567,
  _meta: { retrieved_2nd_on: 1794707164 },
  score: 183,
  num_comments: 412,
  permalink: "/r/Cooking/comments/1xv8a46/vegetable_side_to_bring_to_pot_luck_host_is/",
  url: "https://www.reddit.com/r/Cooking/comments/1xv8a46/vegetable_side_to_bring_to_pot_luck_host_is/",
  is_self: true,
  is_video: false,
  media: null,
  preview: null,
  crosspost_parent_list: null,
  removed_by_category: null,
  link_flair_text: null,
};
const imagePost = {
  id: "1xva9gc",
  title: "[OC] As an arborist & artist, I created The Lorax at our library to encourage saving the leaves",
  selftext: "",
  author: "jakevanyahres",
  author_fullname: "t2_mt4eg",
  subreddit: "pics",
  created_utc: 1794582398,
  retrieved_on: 1794582453,
  _meta: { retrieved_2nd_on: 1795187198 },
  score: 24486,
  num_comments: 633,
  permalink: "/r/pics/comments/1xva9gc/oc_as_an_arborist_artist_i_created_the_lorax_at/",
  url: "https://i.redd.it/wa8316usae1i1.jpeg",
  is_self: false,
  post_hint: "image",
  link_flair_text: "Arts/Crafts",
  preview: { images: [{ source: { height: 3500, url: "https://preview.redd.it/wa8316usae1i1.jpeg?auto=webp&amp;s=9f8f0d62", width: 2800 } }] },
};
const galleryPost = {
  id: "1xvfs96",
  title: "Denny’s where Nvidia was born has taken down the sign honoring the company",
  selftext: "",
  author: "nbcnews",
  subreddit: "pics",
  created_utc: 1794594830,
  retrieved_on: 1794594837,
  score: 23899,
  num_comments: 1288,
  permalink: "/r/pics/comments/1xvfs96/dennys_where_nvidia_was_born_has_taken_down_the/",
  url: "https://www.reddit.com/gallery/1xvfs96",
  is_self: false,
  is_gallery: true,
  gallery_data: { items: [{ id: 1095298457, media_id: "78x117b7bf1i1", caption: "The plaque in 2024" }, { id: 1095298458, media_id: "vcsxs5blbf1i1" }, { id: 3, media_id: "gone" }] },
  media_metadata: {
    vcsxs5blbf1i1: { e: "Image", m: "image/jpeg", p: [{ u: "https://preview.redd.it/vcsxs5blbf1i1.jpeg?width=1080", x: 1080, y: 720 }], s: { u: "https://i.redd.it/vcsxs5blbf1i1.jpeg", x: 1120, y: 747 }, status: "valid" },
    "78x117b7bf1i1": { e: "Image", m: "image/jpeg", p: [], s: { u: "https://i.redd.it/78x117b7bf1i1.jpeg", x: 1500, y: 1000 }, status: "valid" },
    gone: { status: "failed" },
  },
};
const videoPost = {
  id: "1xvd93b",
  title: "Desde que nos conocimos, este es su juego favorito.",
  selftext: "",
  author: "Darcelle1",
  subreddit: "aww",
  created_utc: 1794589243,
  retrieved_on: 1794589255,
  score: 89,
  num_comments: 18,
  permalink: "/r/aww/comments/1xvd93b/desde_que_nos_conocimos_este_es_su_juego_favorito/",
  url: "https://v.redd.it/5k6j7nfoue1i1",
  is_self: false,
  is_video: true,
  post_hint: "hosted:video",
  media: { reddit_video: { fallback_url: "https://v.redd.it/5k6j7nfoue1i1/CMAF_480.mp4?source=fallback", width: 480, height: 854, duration: 50, is_gif: false, has_audio: null } },
  preview: { images: [{ source: { height: 1024, url: "https://external-preview.redd.it/Y2RnMTV2.png?format=pjpg&auto=webp&s=4517d63c", width: 576 } }] },
};
const linkPost = {
  id: "1xvh2cl",
  title: "Hakeem Jeffries interview by Jessica Tarlov at a Democratic Forum in Colorado",
  selftext: "",
  author: "ControlCAD",
  subreddit: "videos",
  created_utc: 1794597713,
  score: 1590,
  num_comments: 990,
  permalink: "/r/videos/comments/1xvh2cl/hakeem_jeffries_interview_by_jessica_tarlov_at_a/",
  url: "https://www.youtube.com/watch?app=desktop&v=ZcPH60XDB6g",
  is_self: false,
  post_hint: "rich:video",
  preview: { images: [{ source: { height: 360, url: "https://external-preview.redd.it/5hcP7WQq.jpeg?format=pjpg", width: 480 } }] },
};
const removedPost = {
  id: "1xqyhfz",
  title: "[ Removed by moderator ]",
  selftext: "I thought I'd share my recent experience with FileRun, as I suspect some people here are using it or considering buying a license.",
  author: "koevet",
  subreddit: "selfhosted",
  created_utc: 1794144686,
  retrieved_on: 1794144696,
  _meta: { edited_title: "FileRun canceled my lifetime license after I requested a receipt", is_edited: true, removal_type: "moderator", retrieved_2nd_on: 1794749487 },
  score: 2853,
  num_comments: 750,
  permalink: "/r/selfhosted/comments/1xqyhfz/removed_by_moderator/",
  url: "https://www.reddit.com/r/selfhosted/comments/1xqyhfz/removed_by_moderator/",
  is_self: true,
  link_flair_text: "Meta Post",
  removed_by_category: "moderator",
};
const crossPost = {
  id: "1xv9in2",
  title: "London for 5 days - a first visit to an incredible city",
  selftext: "",
  author: "pedralexpereira",
  subreddit: "pics",
  created_utc: 1794580601,
  score: 544,
  num_comments: 64,
  permalink: "/r/pics/comments/1xv9in2/london_for_5_days_a_first_visit_to_an_incredible/",
  url: "https://www.reddit.com/gallery/1xtpkxe",
  is_self: false,
  post_hint: "link",
  crosspost_parent_list: [
    {
      id: "1xtpkxe",
      selftext: "Unlike the fearmongering that London gets involved in in certain social media spheres…",
      author: "pedralexpereira",
      subreddit: "travel",
      url: "https://www.reddit.com/gallery/1xtpkxe",
      is_self: false,
      is_gallery: true,
      gallery_data: { items: [{ id: 1093683022, media_id: "zotuq4e7111i1" }] },
      media_metadata: { zotuq4e7111i1: { e: "Image", m: "image/jpeg", p: [], s: { u: "https://i.redd.it/zotuq4e7111i1.jpeg", x: 2048, y: 1365 }, status: "valid" } },
    },
  ],
};
const inlinePost = {
  id: "1xv8sch",
  title: "Great tool, destroyed by its horrendous UI",
  selftext: "https://i.redd.it/mc4qvyoxyd1i1.png\n\nJust a bit sad that a great tool was made barely usable.",
  author: "EsorinMeja",
  subreddit: "homelab",
  created_utc: 1794578803,
  retrieved_on: 1794578812,
  score: 1,
  permalink: "/r/homelab/comments/1xv8sch/great_tool_destroyed_by_its_horrendous_ui/",
  url: "https://www.reddit.com/r/homelab/comments/1xv8sch/great_tool_destroyed_by_its_horrendous_ui/",
  is_self: true,
  link_flair_text: ":emoji: Discussion",
  media_metadata: { mc4qvyoxyd1i1: { e: "Image", id: "mc4qvyoxyd1i1", m: "image/png", p: [], s: { u: "https://i.redd.it/mc4qvyoxyd1i1.png", x: 1910, y: 911 }, status: "valid" } },
};

const t1 = (data: Record<string, unknown>, children: unknown[] = []) => ({ kind: "t1", data: { ...data, replies: children.length > 0 ? { kind: "Listing", data: { children } } : "" } });
/** 评论树：一层一层往下套，没展开的回复是「more」节点 */
const tree = [
  t1({ author: "AutoModerator", body: "Thanks for posting to r/Cooking.", score: 1, stickied: true, distinguished: "moderator" }),
  t1({ author: "modernhedgewitch", body: "Antipasta plate", score: 42 }, [
    t1({ author: "AlicePalace2", body: "Great idea, thanks!", score: 266 }, [{ kind: "more", data: { count: 2, children: ["19skwyb1owxur"] } }]),
    t1({ author: "[deleted]", body: "[removed]", score: 3 }),
  ]),
  t1({ author: "someone", body: "  Roasted broccolini with lemon and garlic.  ", score: 159 }),
  { kind: "more", data: { count: 300, children: [] } },
];

const ref = (id: string) => ({ platform: "reddit" as const, externalId: id, url: `https://www.reddit.com/comments/${id}` });
const read = (post: unknown, comments: unknown[] | null = []) => mapRedditPost({ post, comments }, ref((post as { id: string }).id));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("收藏夹：读 Reddit 帖子（第三方存档）", () => {
  it("文字帖：标题、正文、作者带版块、发布时间、点赞数和评论数；链接换成带版块和标题的那个", () => {
    const { post, mentions } = read(selfPost, tree);
    expect(post).toMatchObject({
      platform: "reddit",
      externalId: "1xv8a46",
      url: "https://www.reddit.com/r/Cooking/comments/1xv8a46/vegetable_side_to_bring_to_pot_luck_host_is/",
      kind: "text",
      title: "Vegetable side to bring to pot luck (host is making lasagna)?",
      author: { id: "t2_4jvrtj78", name: "u/AlicePalace2 · r/Cooking" },
      publishedAt: "2026-11-13T13:45:59.000Z",
      stats: { views: null, likes: 183, collects: null, comments: 412, shares: null },
      hashtags: [],
      images: [],
      video: null,
    });
    expect(post.text).toMatch(/^We will be going to an Italian-themed pot luck/);
    expect(mentions).toEqual([]);
  });

  it("评论：整棵树里按赞数排（回复也算），删掉的、AutoModerator、版主置顶的公告不要；没展开的回复跳过", () => {
    expect(flattenComments(tree).map((c) => c.author)).toEqual(["AutoModerator", "modernhedgewitch", "AlicePalace2", "[deleted]", "someone"]);
    const { post } = read(selfPost, tree);
    expect(post.topComments).toEqual([
      { text: "Great idea, thanks!", likes: 266 },
      { text: "Roasted broccolini with lemon and garlic.", likes: 159 },
      { text: "Antipasta plate", likes: 42 },
    ]);
    // 读到 5 条、留了 3 条：说清楚一共多少、读了多少
    expect(post.notes).toContain("评论一共 412 条，从存档里读到的 5 条里按赞数留了 3 条");
    expect(pickComments([{ body: "x".repeat(3000), score: -4 }])).toEqual([{ text: "x".repeat(1500), likes: -4 }]);
    expect(pickComments(Array.from({ length: 30 }, (_, i) => ({ body: `c${i}`, score: i })))).toHaveLength(12);
  });

  it("这些数字是什么时候的：存档第二次收录的时间减发帖时间，写进读取情况", () => {
    // 1794707164 − 1794577559 = 129605 秒，一天半
    expect(read(selfPost).post.notes[0]).toBe("Reddit 不让服务器直接读，内容来自第三方存档（Arctic Shift）：点赞数和评论数是发帖后 2 天记下的，之后的变化没有");
    expect(read(inlinePost).post.notes[0]).toMatch(/发帖后 1 分钟内记下的/);
    expect(read(linkPost).post.notes[0]).toMatch(/是存档那一刻的，可能比现在的少/);
  });

  it("评论没读到和没有评论分开说", () => {
    const failed = mapRedditPost({ post: selfPost, comments: null, commentsError: "Reddit 存档 请求超时" }, ref("1xv8a46")).post;
    expect(failed.topComments).toEqual([]);
    expect(failed.notes).toContain("评论没读到（Reddit 存档 请求超时）");
    // 帖子报了有评论、存档里还没有
    expect(read(selfPost, []).post.notes).toContain("帖子报了 412 条评论，存档里一条都还没有");
    // 真的没有评论：什么都不说
    expect(read({ ...selfPost, num_comments: 0 }, []).post.notes).toHaveLength(1);
    // 全读到了、也都留下了：不用说
    expect(read({ ...selfPost, num_comments: 1 }, [t1({ author: "a", body: "唯一的一条", score: 2 })]).post.notes).toHaveLength(1);
  });

  it("图片帖：原图在前、预览图当备用（地址里的 &amp; 还原），带尺寸；版块给帖子贴的标签当话题", () => {
    const { post, mentions } = read(imagePost);
    expect(post.kind).toBe("image");
    expect(post.images).toEqual([{ url: "https://i.redd.it/wa8316usae1i1.jpeg", backupUrls: ["https://preview.redd.it/wa8316usae1i1.jpeg?auto=webp&s=9f8f0d62"], width: 2800, height: 3500 }]);
    expect(post.hashtags).toEqual(["Arts/Crafts"]);
    // 标题里的 & 是原文，不动
    expect(post.title).toContain("arborist & artist");
    expect(mentions).toEqual([]);
  });

  it("图集：按图集的顺序（不是 media_metadata 的顺序），坏掉的那张跳过，图注接在正文后面", () => {
    const { post } = read(galleryPost);
    expect(post.kind).toBe("image");
    expect(post.images).toEqual([
      { url: "https://i.redd.it/78x117b7bf1i1.jpeg", width: 1500, height: 1000 },
      { url: "https://i.redd.it/vcsxs5blbf1i1.jpeg", width: 1120, height: 747 },
    ]);
    expect(post.text).toBe("图 1：The plaque in 2024");
  });

  it("动图：图集里的取最大那档静止的预览，单张的 gif 先用预览图；记一句", () => {
    const animated = { ...galleryPost, gallery_data: { items: [{ media_id: "anim" }] }, media_metadata: { anim: { e: "AnimatedImage", status: "valid", s: { gif: "https://i.redd.it/anim.gif", x: 400, y: 300 }, p: [{ u: "https://preview.redd.it/anim.gif?width=108&amp;format=png8", x: 108, y: 81 }, { u: "https://preview.redd.it/anim.gif?width=320&amp;format=png8", x: 320, y: 240 }] } } };
    const a = read(animated).post;
    expect(a.images).toEqual([{ url: "https://preview.redd.it/anim.gif?width=320&format=png8", width: 320, height: 240 }]);
    expect(a.notes).toContain("有 1 张动图，只存了静止的画面");
    const gif = read({ ...imagePost, url: "https://i.redd.it/abc.gif" }).post;
    expect(gif.images[0]).toMatchObject({ url: "https://preview.redd.it/wa8316usae1i1.jpeg?auto=webp&s=9f8f0d62", backupUrls: ["https://i.redd.it/abc.gif"] });
  });

  it("正文里插的图：存下来", () => {
    const { post } = read(inlinePost);
    expect(post.kind).toBe("image");
    expect(post.images).toEqual([{ url: "https://i.redd.it/mc4qvyoxyd1i1.png", width: 1910, height: 911 }]);
    expect(post.hashtags).toEqual(["Discussion"]);
  });

  it("视频：画面的地址、尺寸、时长，封面进图片；声音是另一个文件，带在 video.audio 上", () => {
    const one = { ...videoPost, num_comments: 0 };
    const withSound = mapRedditPost({ post: one, comments: [], audio: { url: "https://v.redd.it/5k6j7nfoue1i1/CMAF_AUDIO_128.mp4" } }, ref("1xvd93b")).post;
    expect(withSound.kind).toBe("video");
    expect(withSound.video).toEqual({ url: "https://v.redd.it/5k6j7nfoue1i1/CMAF_480.mp4?source=fallback", width: 480, height: 854, bytes: null, durationS: 50, audio: { url: "https://v.redd.it/5k6j7nfoue1i1/CMAF_AUDIO_128.mp4" } });
    expect(withSound.images).toEqual([{ url: "https://external-preview.redd.it/Y2RnMTV2.png?format=pjpg&auto=webp&s=4517d63c" }]);
    expect(withSound.notes).toHaveLength(1);
    // 清单读到了、里面没有声音（本来就是无声的视频）：不带 audio，也不用说
    const silent = mapRedditPost({ post: one, comments: [], audio: null }, ref("1xvd93b")).post;
    expect(silent.video).not.toHaveProperty("audio");
    expect(silent.notes).toHaveLength(1);
    // 清单没读到：不知道有没有声音，说出来
    const unknown = mapRedditPost({ post: videoPost, comments: [], audio: "failed" }, ref("1xvd93b")).post;
    expect(unknown.notes).toContain("没找到这个视频的声音文件（Reddit 把画面和声音分开放），只有画面：说了什么读不到");
  });

  it("DASH 清单里挑码率最高的那条声音；没有声音是 null；不认带路径的文件名", () => {
    const set = (type: string, reps: [number, string][]) =>
      `<AdaptationSet contentType="${type}" id="1">${reps.map(([b, f]) => `<Representation bandwidth="${b}" mimeType="${type}/mp4"><BaseURL>${f}</BaseURL><SegmentBase indexRange="1-2"/></Representation>`).join("")}</AdaptationSet>`;
    const video = set("video", [[242472, "CMAF_220.mp4"], [1270333, "CMAF_480.mp4"]]);
    expect(pickDashAudio(`<MPD><Period>${video}${set("audio", [[67789, "CMAF_AUDIO_64.mp4"], [131597, "CMAF_AUDIO_128.mp4"]])}</Period></MPD>`)).toBe("CMAF_AUDIO_128.mp4");
    expect(pickDashAudio(`<MPD><Period>${video}</Period></MPD>`)).toBeNull();
    expect(pickDashAudio(`<MPD><Period>${set("audio", [[1, "https://evil.example/a.mp4"], [2, "../a.mp4"]])}</Period></MPD>`)).toBeNull();
    expect(pickDashAudio("不是清单")).toBeNull();
  });

  it("链接帖：链接写进正文，交给跟着读；封面不存（链接读到了会带它自己的图）", () => {
    const { post, mentions } = read(linkPost);
    expect(post.kind).toBe("text");
    expect(post.text).toBe("链接：https://www.youtube.com/watch?app=desktop&v=ZcPH60XDB6g");
    expect(post.images).toEqual([]);
    expect(mentions).toEqual([{ how: "link", url: "https://www.youtube.com/watch?app=desktop&v=ZcPH60XDB6g", ref: null }]);
  });

  it("转帖：内容（正文、图集）取原帖的，数字和评论是转帖自己的，记一句", () => {
    const { post, mentions } = read(crossPost);
    expect(post.kind).toBe("image");
    expect(post.text).toMatch(/^Unlike the fearmongering/);
    expect(post.images).toEqual([{ url: "https://i.redd.it/zotuq4e7111i1.jpeg", width: 2048, height: 1365 }]);
    expect(post.author.name).toBe("u/pedralexpereira · r/pics");
    expect(post.stats.likes).toBe(544);
    expect(post.notes).toContain("这是一条转帖：内容来自 r/travel 的原帖，点赞数和评论是这条转帖自己的");
    // 原帖的图集地址不是「指向别处的链接」
    expect(mentions).toEqual([]);
  });

  it("被移除的帖子：存档里留着的正文照读，标题用存档记下的原标题，说清楚是被谁移除的", () => {
    const { post } = read(removedPost);
    expect(post.title).toBe("FileRun canceled my lifetime license after I requested a receipt");
    expect(post.text).toMatch(/^I thought I'd share/);
    expect(post.notes).toContain("这条帖子被版主移除了，读到的是存档里留下的内容");
    // 存档收录之前就没了的：标题留空（让模型起），正文没读到要说
    const late = read({ ...removedPost, _meta: {}, selftext: "[removed]", author: "[deleted]", removed_by_category: "deleted" }).post;
    expect(late.title).toBe("");
    expect(late.text).toBe("");
    expect(late.author.name).toBe("r/selfhosted");
    expect(late.notes).toEqual(expect.arrayContaining(["这条帖子被作者删除了，读到的是存档里留下的内容", "正文在存档收录之前就被删了，没读到", "标题在存档收录之前就被移除了"]));
  });

  it("NSFW、投票、被踩到负数", () => {
    const post = read({ ...selfPost, over_18: true, poll_data: { options: [] }, score: -7 }).post;
    expect(post.notes).toEqual(expect.arrayContaining(["帖子标了 NSFW（成人内容）", "帖子里有一个投票，选项和票数没读"]));
    expect(post.stats.likes).toBe(0);
  });

  it("形状不对：不是一条帖子就报读不到", () => {
    expect(() => mapRedditPost({ post: { error: "x" }, comments: [] }, ref("abc12"))).toThrow(SourceFetchError);
  });
});

describe("收藏夹：读 Reddit 帖子（请求）", () => {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { data } : { error: "slow down" }), { status, headers: { "content-type": "application/json" } });
  const noWait = async () => {};
  /** 按地址回话；记下问过哪些地址 */
  function stub(handler: (url: string) => Response | Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return handler(url);
    }));
    return calls;
  }

  it("帖子和评论各问一次存档；视频再去 v.redd.it 的清单里找声音", async () => {
    const mpd = `<MPD><Period><AdaptationSet contentType="audio"><Representation bandwidth="131597"><BaseURL>CMAF_AUDIO_128.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const calls = stub((url) => (url.includes("/posts/ids") ? json([videoPost]) : url.includes("/comments/tree") ? json(tree) : new Response(mpd)));
    const { post } = await readRedditPost(ref("1xvd93b"), noWait);
    expect(calls).toEqual([
      "https://arctic-shift.photon-reddit.com/api/posts/ids?ids=1xvd93b",
      "https://arctic-shift.photon-reddit.com/api/comments/tree?link_id=t3_1xvd93b&limit=500",
      "https://v.redd.it/5k6j7nfoue1i1/DASHPlaylist.mpd",
    ]);
    expect(post.video?.audio).toEqual({ url: "https://v.redd.it/5k6j7nfoue1i1/CMAF_AUDIO_128.mp4" });
    expect(post.topComments).toHaveLength(3);
  });

  it("存档里没有这条帖子（不认识的 id 不在结果里）：RedditArchiveMiss，不再去问评论", async () => {
    const calls = stub(() => json([]));
    await expect(readRedditPost(ref("zzzzzzz9"), noWait)).rejects.toBeInstanceOf(RedditArchiveMiss);
    expect(calls).toHaveLength(1);
  });

  it("存档嫌快（422）：等一下再问一次；还是不行才算出错", async () => {
    let n = 0;
    const wait = vi.fn(async () => {});
    stub((url) => (url.includes("/posts/ids") ? (n++ === 0 ? json(null, 422) : json([selfPost])) : json([])));
    expect((await readRedditPost(ref("1xv8a46"), wait)).post.title).toMatch(/^Vegetable side/);
    expect(wait).toHaveBeenCalledWith(1500);
    stub(() => json(null, 422));
    await expect(readRedditPost(ref("1xv8a46"), noWait)).rejects.toThrow(/Reddit 存档/);
  });

  it("评论那一次出错不算失败：帖子照样读到，记一句评论没读到", async () => {
    stub((url) => (url.includes("/posts/ids") ? json([selfPost]) : new Response("boom", { status: 500 })));
    const { post } = await readRedditPost(ref("1xv8a46"), noWait);
    expect(post.topComments).toEqual([]);
    expect(post.notes.some((n) => n.startsWith("评论没读到（"))).toBe(true);
  });

  it("声音的清单读不到：画面照样有，记一句；动图不去找声音", async () => {
    stub((url) => (url.includes("/posts/ids") ? json([videoPost]) : url.includes("/comments/tree") ? json([]) : new Response("", { status: 403 })));
    const { post } = await readRedditPost(ref("1xvd93b"), noWait);
    expect(post.video?.url).toMatch(/CMAF_480\.mp4/);
    expect(post.notes.some((n) => n.startsWith("没找到这个视频的声音文件"))).toBe(true);
    const gif = { ...videoPost, media: { reddit_video: { ...videoPost.media.reddit_video, is_gif: true } } };
    const calls = stub((url) => (url.includes("/posts/ids") ? json([gif]) : json([])));
    await readRedditPost(ref("1xvd93b"), noWait);
    expect(calls).toHaveLength(2);
  });

  it("id 不像 Reddit 的：不发请求", async () => {
    const calls = stub(() => json([]));
    await expect(readRedditPost(ref("../../x"), noWait)).rejects.toThrow(SourceFetchError);
    expect(calls).toHaveLength(0);
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
