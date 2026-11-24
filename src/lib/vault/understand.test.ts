import { describe, expect, it } from "vitest";
import { emptyStats, type PostSnapshot } from "@/lib/sources/types";
import { BODY_MAX, MAX, buildUnderstandPrompt, parseUnderstanding, readUnderstanding, understandingSchema, type UnderstandInput } from "./understand";

const post = (patch: Partial<PostSnapshot> = {}): PostSnapshot => ({
  text: "",
  publishedAt: null,
  stats: emptyStats(),
  hashtags: [],
  topComments: [],
  music: null,
  notes: [],
  authorId: null,
  durationS: null,
  digestNotes: [],
  transcriptFrom: null,
  cuts: [],
  links: [],
  ...patch,
});

const input = (patch: Partial<UnderstandInput> = {}): UnderstandInput => ({
  source: "link",
  platform: "douyin",
  kind: "video",
  title: "三亚带娃住哪里",
  author: "小王",
  url: "https://www.douyin.com/video/1",
  post: post({ text: "三亚亲子酒店合集 #三亚 #亲子游", hashtags: ["三亚", "亲子游"], stats: { ...emptyStats(), likes: 12000 }, durationS: 65 }),
  userText: null,
  transcript: "[0:00] 今天说三家酒店\n[0:20] 第一家是亚特兰蒂斯",
  images: [],
  gaps: [],
  note: "",
  existingTags: [],
  language: "zh",
  now: new Date("2026-11-17T00:00:00Z"),
  ...patch,
});

const OUTPUT = `<title>三亚带娃住哪里：三家亲子酒店</title>
<type>travel</type>
<category>travel</category>
<lang>zh</lang>
<summary>
  博主推荐了三家三亚亲子酒店。
  亚特兰蒂斯水世界最适合大孩子。
</summary>
<point><at>0:20</at><text>亚特兰蒂斯：水世界和水族馆，房价约 2500 元起</text></point>
<point><text>海棠湾比亚龙湾人少</text></point>
<outline>
- [0:20] 亚特兰蒂斯
  - 水世界和水族馆
  - 约 2500 元起
- 选哪个湾
  - 海棠湾人少
</outline>
<field><label>目的地</label><value>三亚</value></field>
<field><label>住宿</label><value>亚特兰蒂斯
艾迪逊</value></field>
<field><label>预算</label><value></value></field>
<quote>「带娃就别折腾，选一个能待三天的酒店」</quote>
<tag>#三亚</tag><tag>亲子酒店</tag><tag>三亚</tag>
<entity><type>place</type><name>三亚</name><about>目的地</about></entity>
<entity><type>org</type><name>《亚特兰蒂斯》</name><about>推荐的第一家酒店</about></entity>
<entity><type>animal</type><name>海豚</name><about>类型不在列表里</about></entity>
<entity><type>place</type><name>三亚</name><about>重复的</about></entity>
<relation><from>亚特兰蒂斯</from><rel>located_in</rel><to>三亚</to></relation>
<relation><from>亚特兰蒂斯</from><rel>near</rel><to>三亚</to></relation>
<relation><from>亚特兰蒂斯</from><rel>located_in</rel><to>海口</to></relation>
<ocr>亚特兰蒂斯 ¥2500 起</ocr>`;

describe("parseUnderstanding", () => {
  const parsed = parseUnderstanding(OUTPUT);

  it("reads the single fields and trims each line", () => {
    expect(parsed.title).toBe("三亚带娃住哪里：三家亲子酒店");
    expect(parsed.contentType).toBe("travel");
    expect(parsed.category).toBe("travel");
    expect(parsed.language).toBe("zh");
    expect(parsed.summary).toBe("博主推荐了三家三亚亲子酒店。\n亚特兰蒂斯水世界最适合大孩子。");
    expect(parsed.ocr).toBe("亚特兰蒂斯 ¥2500 起");
  });

  it("turns point times into seconds and keeps points without a time", () => {
    expect(parsed.points).toEqual([
      { at: 20, text: "亚特兰蒂斯：水世界和水族馆，房价约 2500 元起" },
      { at: null, text: "海棠湾比亚龙湾人少" },
    ]);
  });

  it("reads the outline with its indentation intact", () => {
    expect(parsed.outline).toEqual([
      { depth: 1, at: 20, text: "亚特兰蒂斯" },
      { depth: 2, at: null, text: "水世界和水族馆" },
      { depth: 2, at: null, text: "约 2500 元起" },
      { depth: 1, at: null, text: "选哪个湾" },
      { depth: 2, at: null, text: "海棠湾人少" },
    ]);
    // 没写这个标签（内容没有层次）= 没有大纲，不算不合格
    const none = parseUnderstanding("<summary>x</summary>");
    expect(none.outline).toEqual([]);
    expect(understandingSchema.safeParse({ ...none, gaps: [], model: "m" }).success).toBe(true);
  });

  it("keeps multi-line card values and drops empty fields", () => {
    expect(parsed.card).toEqual([
      { label: "目的地", value: "三亚" },
      { label: "住宿", value: "亚特兰蒂斯\n艾迪逊" },
    ]);
  });

  it("strips the model's own quote marks and de-duplicates tags", () => {
    expect(parsed.quotes).toEqual(["带娃就别折腾，选一个能待三天的酒店"]);
    expect(parsed.tags).toEqual(["三亚", "亲子酒店"]);
  });

  it("drops entities of unknown type and duplicates, and strips book-title marks", () => {
    expect(parsed.entities).toEqual([
      { type: "place", name: "三亚", about: "目的地" },
      { type: "org", name: "亚特兰蒂斯", about: "推荐的第一家酒店" },
    ]);
  });

  it("keeps only relations between extracted entities; unknown relation kinds become related", () => {
    expect(parsed.relations).toEqual([
      { from: "亚特兰蒂斯", to: "三亚", relation: "located_in" },
      { from: "亚特兰蒂斯", to: "三亚", relation: "related" },
    ]);
  });

  it("falls back to other for values outside the lists, and passes the schema", () => {
    const odd = parseUnderstanding("<type>Podcast</type><category>astrology</category><summary>x</summary>");
    expect(odd.contentType).toBe("other");
    expect(odd.category).toBe("other");
    expect(understandingSchema.safeParse({ ...parsed, gaps: [], model: "m" }).success).toBe(true);
    // 没写概括 = 不合格（调用方会重做）
    expect(understandingSchema.safeParse({ ...parseUnderstanding("<title>t</title>"), gaps: [], model: "m" }).success).toBe(false);
  });

  it("caps repeated tags at their limits", () => {
    const many = parseUnderstanding(Array.from({ length: 40 }, (_, i) => `<point><text>要点 ${i}</text></point><tag>标签${i}</tag>`).join(""));
    expect(many.points).toHaveLength(MAX.points);
    expect(many.tags).toHaveLength(MAX.tags);
  });
});

describe("readUnderstanding", () => {
  it("returns null for data that is not an understanding", () => {
    expect(readUnderstanding(null)).toBeNull();
    expect(readUnderstanding({ summary: "只有概括" })).toBeNull();
    expect(readUnderstanding({ ...parseUnderstanding(OUTPUT), gaps: ["a"], model: "claude" })?.gaps).toEqual(["a"]);
  });

  it("still reads rows saved before there was an outline", () => {
    const { outline, ...old } = { ...parseUnderstanding(OUTPUT), gaps: [], model: "claude" };
    expect(outline.length).toBeGreaterThan(0);
    const read = readUnderstanding(old);
    expect(read?.summary).toBe(old.summary);
    expect(read?.outline).toEqual([]);
  });
});

describe("buildUnderstandPrompt", () => {
  it("carries the source facts, text, transcript and output language", () => {
    const { prompt, gaps } = buildUnderstandPrompt(input());
    expect(prompt).toContain("来源：抖音（视频）的链接");
    expect(prompt).toContain("作者：小王");
    expect(prompt).toContain("时长：1:05");
    expect(prompt).toContain("互动：点赞 1.2万");
    expect(prompt).toContain("<原标题>\n三亚带娃住哪里");
    expect(prompt).toContain("三亚亲子酒店合集");
    expect(prompt).toContain("语音识别，可能有错字");
    expect(prompt).toContain("每段开头方括号里是这段开始的时间");
    expect(prompt).toContain("其余全部用简体中文写");
    expect(prompt).toContain("<outline>");
    expect(prompt).toContain("只有一层意思的不写这个标签");
    expect(gaps).toEqual([]);
  });

  it("puts the saver's note and existing tags in front of the model", () => {
    const { prompt } = buildUnderstandPrompt(input({ note: "寒假带娃去", existingTags: ["亲子游", "酒店"] }));
    expect(prompt).toContain("<收藏者的备注>\n寒假带娃去");
    expect(prompt).toContain("<已有的标签>\n亲子游、酒店");
  });

  it("says what was not seen instead of hiding it", () => {
    const { prompt, gaps } = buildUnderstandPrompt(input({ transcript: null, post: post({ notes: ["视频太大，没有转存"], digestNotes: ["没有转写说的话：没配 OPENAI_API_KEY"] }) }));
    expect(gaps).toEqual(["视频太大，没有转存", "没有转写说的话：没配 OPENAI_API_KEY", "没有口播文字：视频里说了什么只能从画面上的字和文案里看"]);
    expect(prompt).toContain("<读取情况>\n- 视频太大，没有转存");
  });

  it("reports truncation of very long text", () => {
    const { prompt, gaps } = buildUnderstandPrompt(input({ source: "text", platform: null, kind: "text", url: null, transcript: null, userText: "长".repeat(BODY_MAX + 10) }));
    expect(prompt).toContain("来源：用户自己贴的文字");
    expect(gaps.some((g) => g.startsWith("正文太长，只读了前 60,000 个字"))).toBe(true);
  });

  it("carries top comments, each cut short; Reddit ones get more room because the answers live there", () => {
    const long = "答".repeat(900);
    const withComments = (platform: UnderstandInput["platform"]) => buildUnderstandPrompt(input({ platform, post: post({ topComments: [{ text: long, likes: 266 }, { text: "短的\n一条", likes: null }] }) })).prompt;
    expect(withComments("douyin")).toContain(`<高赞评论>\n- ${"答".repeat(200)}（266 赞）\n- 短的 一条\n</高赞评论>`);
    expect(withComments("reddit")).toContain(`- ${"答".repeat(600)}（266 赞）`);
    expect(withComments("reddit")).toContain("来源：Reddit（视频）的链接");
  });

  it("describes uploads and attached images, in English when asked", () => {
    const { prompt } = buildUnderstandPrompt(
      input({ source: "upload", platform: null, kind: "image", url: null, title: "", author: "", transcript: null, post: post(), images: [{ caption: "图片", data: new Uint8Array() }], language: "en" })
    );
    expect(prompt).toContain("来源：用户上传的图片 / 截图");
    expect(prompt).toContain("下面附了 1 张图");
    expect(prompt).toContain("其余全部用English写");
    expect(prompt).not.toContain("互动：");
  });
});
