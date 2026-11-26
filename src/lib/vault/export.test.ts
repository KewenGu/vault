import { beforeEach, describe, expect, it } from "vitest";
import { emptyStats } from "@/lib/sources/types";
import { makeFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { concat, readZip, text } from "@/test/read-zip";
import { askMarkdown, exportArchive, exportReadme, itemMarkdown, journalMarkdown, mapMarkdown, safeName } from "./export";
import { toItem } from "./store";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const NOW = new Date("2026-11-26T08:00:00.000Z");
const ROOT = "vault-export-2026-11-26";

const understanding = {
  title: "高压锅红烧牛腩",
  contentType: "recipe",
  category: "food",
  language: "zh",
  summary: "牛腩焯水后和冰糖炒色，高压锅上汽 25 分钟。",
  points: [{ at: 35, text: "冰糖炒糖色" }, { at: null, text: "上汽后 25 分钟" }],
  outline: [{ depth: 1, at: 35, text: "备料" }, { depth: 2, at: null, text: "牛腩 500 克" }],
  card: [{ label: "食材", value: "牛腩 500 克\n冰糖 20 克" }],
  quotes: ["糖色别炒过了\n过了会苦"],
  tags: ["牛肉"],
  entities: [{ type: "product", name: "高压锅", about: "用来炖牛腩" }],
  relations: [],
  ocr: "图上的字",
  gaps: ["口播只转了前 60 分钟"],
  model: "m",
};

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  user_id: USER,
  source: "link",
  dedupe_key: `k${n}`,
  platform: "douyin",
  external_id: `x${n}`,
  url: `https://www.douyin.com/video/${n}`,
  status: "ready",
  error: null,
  kind: "video",
  title: n === 1 ? "高压锅红烧牛腩" : `第 ${n} 条`,
  author: "阿福",
  post: { text: "正文：今天做牛腩", publishedAt: "2026-11-01T02:00:00.000Z", stats: emptyStats(), hashtags: [], topComments: [], music: null, notes: ["评论没读到"], authorId: null, durationS: null, digestNotes: [], transcriptFrom: null, cuts: [], links: [] },
  media: [{ role: "video", path: `${USER}/${id(n)}/video.mp4`, mime: "video/mp4", bytes: 10, width: 720, height: 1280 }],
  transcript: "[0:35] 冰糖下锅",
  user_text: null,
  understanding,
  summary: understanding.summary,
  content_type: "recipe",
  category: "food",
  tags: ["牛肉", "高压锅"],
  tags_locked: false,
  note: "周末做: 记得买冰糖",
  search_text: "不该导出的搜索全文",
  embedding: "[0.1,0.2]",
  usage: {},
  cost_usd: 0.04,
  started_at: "2026-11-20T00:00:00.000Z",
  processed_at: "2026-11-20T00:01:00.000Z",
  created_at: new Date(Date.UTC(2026, 10, 20, 0, n)).toISOString(),
  updated_at: "2026-11-20T00:00:00.000Z",
  ...over,
});

describe("safeName", () => {
  it("drops what file systems refuse, collapses whitespace, and never returns nothing", () => {
    expect(safeName('  a/b\\c:d*e?f"g<h>i|j \n k  ')).toBe("a b c d e f g h i j k");
    expect(safeName("...隐藏")).toBe("隐藏");
    expect(safeName(" / ")).toBe("未命名");
    expect(Array.from(safeName("长".repeat(200)))).toHaveLength(60);
  });
});

describe("itemMarkdown", () => {
  it("writes the properties as YAML that survives colons and quotes, then everything a reader needs without Vault", () => {
    const md = itemMarkdown(toItem(item(1, { title: '牛腩: "最好吃" 的做法' })));
    expect(md.startsWith('---\ntitle: "牛腩: \\"最好吃\\" 的做法"\nsource: "抖音"\nauthor: "阿福"\nurl: "https://www.douyin.com/video/1"\nsaved: "2026-11-20"\npublished: "2026-11-01"\ntype: "食谱"\ncategory: "美食"\ntags: ["牛肉", "高压锅"]\nstatus: "ready"\n')).toBe(true);
    expect(md).toContain(`vault_id: "${id(1)}"\n---\n\n# 牛腩: "最好吃" 的做法`);
    expect(md).toContain("## 我的备注\n\n周末做: 记得买冰糖");
    expect(md).toContain("## 概括\n\n牛腩焯水后");
    expect(md).toContain("## 食谱\n\n- **食材**：牛腩 500 克\n  冰糖 20 克");
    expect(md).toContain("## 内容要点\n\n- （0:35）冰糖炒糖色\n- 上汽后 25 分钟");
    expect(md).toContain("## 大纲\n\n- （0:35）备料\n  - 牛腩 500 克");
    expect(md).toContain("## 原话\n\n> 糖色别炒过了\n> 过了会苦");
    expect(md).toContain("## 提到的\n\n- 产品：高压锅——用来炖牛腩");
    expect(md).toContain("## 读这条内容时没看到的\n\n- 评论没读到\n- 口播只转了前 60 分钟");
    expect(md).toContain("## 原文\n\n正文：今天做牛腩");
    expect(md).toContain("## 图上的文字\n\n图上的字");
    expect(md).toContain("## 说的话\n\n[0:35] 冰糖下锅");
    expect(md).toContain(`## 文件（没有包含在这个导出里）\n\n- video：${USER}/${id(1)}/video.mp4`);
  });

  it("writes the user's highlights and annotations under his note: the quoted passage as a quote, his words below", () => {
    const md = itemMarkdown(toItem(item(1)), [{ quote: "冰糖下锅", body: "火要小\n不然苦", at: 35 }, { quote: "", body: "下次少放糖", at: null }, { quote: "糖色别炒过了", body: "", at: null }]);
    expect(md).toContain("## 我的划线和批注\n\n> 冰糖下锅（0:35）\n\n火要小\n不然苦\n\n---\n\n下次少放糖\n\n---\n\n> 糖色别炒过了\n\n## 概括");
    expect(itemMarkdown(toItem(item(1)))).not.toContain("我的划线和批注");
  });

  it("still exports an item that failed, with the reason and whatever text it has", () => {
    const md = itemMarkdown(toItem(item(2, { status: "failed", error: "链接读不到", understanding: null, title: null, tags: [], note: null, transcript: null, media: [], content_type: null, category: null })));
    expect(md).toContain('title: "抖音');
    expect(md).toContain('status: "failed"');
    expect(md).toContain("## 没处理成\n\n链接读不到");
    expect(md).toContain("## 原文\n\n正文：今天做牛腩");
    for (const absent of ["## 概括", "## 我的备注", "tags:", "## 文件"]) expect(md).not.toContain(absent);
  });
});

describe("mapMarkdown / askMarkdown / journalMarkdown", () => {
  it("writes a map as an indented outline", () => {
    expect(mapMarkdown({ title: "理财", nodes: [{ depth: 1, text: "应急金", item: null }, { depth: 2, text: "3–6 个月", item: id(1) }] })).toBe("# 理财\n\n- 应急金\n  - 3–6 个月\n");
    expect(mapMarkdown({ title: "", nodes: [] })).toContain("# 没起名的导图");
  });

  it("writes a question with its answers, the sources behind the numbers, and what was not seen", () => {
    const md = askMarkdown({
      id: id(7), title: "应急金存多少", sources: [], usage: {}, cost_usd: 0, created_at: "t", updated_at: "t",
      chat: [
        { role: "user", text: "应急金存多少", at: "t" },
        { role: "assistant", text: "3–6 个月[1]。", at: "t", cites: [{ id: id(1), title: "四步走", origin: "抖音 · 小鹿" }], notes: ["语义搜索这次不可用"], seen: 3, total: 9 },
        { role: "user", text: "谢谢", at: "t" },
        { role: "assistant", text: "不客气。", at: "t", cites: [], notes: [], seen: 0, total: 9 },
      ],
    });
    expect(md).toBe("# 应急金存多少\n\n## 问：应急金存多少\n\n3–6 个月[1]。\n\n出处：\n\n1. 四步走（抖音 · 小鹿）\n\n- 语义搜索这次不可用\n\n## 问：谢谢\n\n不客气。\n");
  });

  it("writes a journal page as its text, photo captions and what was said in the recordings", () => {
    // 正文里的照片和录音是按 id（uuid）指着 journal_media 里的行的
    const [photo, audio] = [id(801), id(802)];
    const media = new Map([[photo, { id: photo, path: "u/journal/e/p.jpg", transcript: null }], [audio, { id: audio, path: "u/journal/e/a.m4a", transcript: "[0:00] 今天很累" }]]);
    const md = journalMarkdown({ day: "2026-11-21", title: "", mood: "累", weather: "雨", doc: { v: 1, blocks: [{ id: "b1", type: "text", text: "下班很晚" }, { id: "b2", type: "photo", media: photo, caption: "晚饭" }, { id: "b3", type: "audio", media: audio }, { id: "b4", type: "text", text: "  " }], decos: [], strokes: [] } }, media);
    expect(md).toBe("# 2026-11-21\n\n2026-11-21 · 累 · 雨\n\n下班很晚\n\n（照片：晚饭，文件 u/journal/e/p.jpg）\n\n（录音，文件 u/journal/e/a.m4a）\n\n> [0:00] 今天很累\n");
  });
});

describe("exportReadme", () => {
  it("says plainly when the archive is incomplete", () => {
    const whole = exportReadme({ now: NOW, counts: [["内容", 3]], mediaFiles: 5, notes: [] });
    expect(whole).toContain("- 内容：3");
    expect(whole).toContain("一共登记了 5 个");
    expect(whole).toContain("没有：上面列的每一部分都读完了");
    const partial = exportReadme({ now: NOW, counts: [], mediaFiles: 0, notes: ["日记：读的时候出错了"] });
    expect(partial).toContain("- 日记：读的时候出错了");
    expect(partial).toContain("**这个包不完整**");
  });
});

let fake: FakeSupabase;
const seed = () => ({
  items: [...Array.from({ length: 120 }, (_, i) => item(i + 1)), item(500, { user_id: OTHER, title: "别人的" })],
  entities: [{ id: "e1", user_id: USER, type: "product", name: "高压锅", aliases: [], summary: "", embedding: "[1]", created_at: "t", updated_at: "t" }, { id: "e2", user_id: OTHER, type: "place", name: "别人的", aliases: [], summary: "", embedding: null, created_at: "t", updated_at: "t" }],
  item_entities: [{ item_id: id(1), entity_id: "e1", user_id: USER, about: "" }],
  item_notes: [
    { id: id(950), user_id: USER, item_id: id(1), quote: "冰糖下锅", body: "火要小", at: 35, search_text: "冰糖下锅\n火要小", created_at: "2026-11-21T00:00:00.000Z", updated_at: "t" },
    { id: id(951), user_id: OTHER, item_id: id(500), quote: "别人划的", body: "", at: null, search_text: "别人划的\n", created_at: "t", updated_at: "t" },
  ],
  maps: [{ id: id(900), user_id: USER, title: "理财/入门", nodes: [{ depth: 1, text: "应急金", item: null }], sources: [], chat: [], usage: {}, cost_usd: 0, created_at: "2026-11-21T00:00:00.000Z", updated_at: "2026-11-21T00:00:00.000Z" }],
  asks: [{ id: id(901), user_id: USER, title: "应急金存多少", chat: [{ role: "user", text: "应急金存多少", at: "t" }], sources: [], usage: {}, cost_usd: 0, created_at: "2026-11-25T00:00:00.000Z", updated_at: "2026-11-25T00:00:00.000Z" }],
  journal_entries: [
    { id: id(902), user_id: USER, day: "2026-11-21", title: "加班", style: "fresh", mood: "累", weather: "雨", doc: { v: 1, blocks: [{ id: "b1", type: "text", text: "下班很晚" }], decos: [], strokes: [] }, rev: 1, search_text: "", created_at: "2026-11-21T00:00:00.000Z", updated_at: "2026-11-21T00:00:00.000Z" },
    { id: id(903), user_id: OTHER, day: "2026-11-21", title: "别人的日记", style: "fresh", mood: "", weather: "", doc: {}, rev: 1, search_text: "", created_at: "t", updated_at: "t" },
  ],
  journal_media: [{ id: id(904), user_id: USER, entry_id: id(902), kind: "image", status: "ready", path: "p.jpg", transcript: null }],
});

async function run(db = fake.db): Promise<Map<string, Uint8Array>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of exportArchive(db, USER, NOW)) chunks.push(chunk);
  return readZip(concat(chunks));
}
const json = (files: Map<string, Uint8Array>, path: string) => JSON.parse(text(files.get(`${ROOT}/${path}`))) as Record<string, unknown>[];

beforeEach(() => {
  fake = makeFakeSupabase(seed());
});

describe("exportArchive", () => {
  it("exports every item of this user (and nobody else's) as a Markdown file and as raw rows, oldest first, page by page", async () => {
    const files = await run();
    const docs = [...files.keys()].filter((k) => k.startsWith(`${ROOT}/items/`));
    expect(docs).toHaveLength(120);
    expect(docs[0]).toBe(`${ROOT}/items/2026-11/2026-11-20 高压锅红烧牛腩 (00000001).md`);
    expect(text(files.get(docs[0]))).toContain("## 概括\n\n牛腩焯水后");
    // 120 条分三页读，原始的行也分三个文件
    const pages = ["items-0001.json", "items-0002.json", "items-0003.json"].map((f) => json(files, `data/items/${f}`));
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    const rows = pages.flat();
    expect(new Set(rows.map((r) => r.id)).size).toBe(120);
    expect(rows.every((r) => r.user_id === USER)).toBe(true);
    // 向量和搜索全文不导出；别的列原样在
    expect(rows[0]).not.toHaveProperty("embedding");
    expect(rows[0]).not.toHaveProperty("search_text");
    expect(rows[0]).toMatchObject({ note: "周末做: 记得买冰糖", cost_usd: 0.04, transcript: "[0:35] 冰糖下锅" });
    expect([...files.keys()].some((k) => k.includes("别人的"))).toBe(false);
  });

  it("exports the other tables as they are, the readable copies, and a README that accounts for all of it", async () => {
    const files = await run();
    expect(json(files, "data/entities.json")).toEqual([{ id: "e1", user_id: USER, type: "product", name: "高压锅", aliases: [], summary: "", created_at: "t", updated_at: "t" }]);
    expect(json(files, "data/item_entities.json")).toHaveLength(1);
    // 划线和批注：原始数据一份（拼出来的搜索列不导），那条内容的 Markdown 里也有
    expect(json(files, "data/item_notes.json")).toEqual([{ id: id(950), user_id: USER, item_id: id(1), quote: "冰糖下锅", body: "火要小", at: 35, created_at: "2026-11-21T00:00:00.000Z", updated_at: "t" }]);
    expect(text(files.get(`${ROOT}/items/2026-11/2026-11-20 高压锅红烧牛腩 (00000001).md`))).toContain("## 我的划线和批注\n\n> 冰糖下锅（0:35）\n\n火要小");
    expect(text(files.get(`${ROOT}/README.md`))).toContain("- 划线和批注：1");
    expect(json(files, "data/journal_entries.json").map((r) => r.title)).toEqual(["加班"]);
    expect(json(files, "data/creators.json")).toEqual([]);
    // 标题里的斜杠不会变成一层文件夹
    expect(text(files.get(`${ROOT}/maps/理财 入门 (00000900).md`))).toBe("# 理财/入门\n\n- 应急金\n");
    expect(text(files.get(`${ROOT}/asks/2026-11-25 应急金存多少 (00000901).md`))).toContain("## 问：应急金存多少");
    expect(text(files.get(`${ROOT}/journal/2026-11-21 加班 (00000902).md`))).toContain("下班很晚");

    const readme = text(files.get(`${ROOT}/README.md`));
    expect(readme).toContain("- 内容：120");
    expect(readme).toContain("- 日记：1");
    // 120 条内容各一个视频 + 日记里的一张照片
    expect(readme).toContain("一共登记了 121 个");
    expect(readme).toContain("没有：上面列的每一部分都读完了");
    expect([...files.keys()].at(-1)).toBe(`${ROOT}/README.md`);
  });

  it("a table that does not exist yet, or fails to read, is named in the README and the rest still exports", async () => {
    fake = makeFakeSupabase(seed(), { failSelect: { asks: { message: "Could not find the table 'public.asks' in the schema cache", code: "PGRST205" }, maps: { message: "connection reset" } } });
    const files = await run();
    expect(files.has(`${ROOT}/data/asks.json`)).toBe(false);
    expect(files.has(`${ROOT}/data/maps.json`)).toBe(false);
    expect(json(files, "data/journal_entries.json")).toHaveLength(1);
    expect([...files.keys()].filter((k) => k.startsWith(`${ROOT}/items/`))).toHaveLength(120);
    const readme = text(files.get(`${ROOT}/README.md`));
    expect(readme).toContain("- 问过的问题：数据库里还没有这张表（迁移没推），没有导出");
    expect(readme).toContain("- 自己建的导图：读的时候出错了，没有导出（读取自己建的导图失败: connection reset）");
    expect(readme).toContain("**这个包不完整**");
  });

  it("when the items themselves cannot be read, the archive says so instead of looking like an empty library", async () => {
    fake = makeFakeSupabase(seed(), { failSelect: { items: { message: "timeout" } } });
    const readme = text((await run()).get(`${ROOT}/README.md`));
    expect(readme).toContain("- 内容：0");
    expect(readme).toContain("内容：读到第 0 条之后出错了，后面的没有导出（timeout）");
    expect(readme).toContain("**这个包不完整**");
  });

  it("two items with the same day, title and id prefix still both get a file", async () => {
    const twin = "00000001-9999-4999-8999-999999999999";
    fake = makeFakeSupabase({ items: [item(1), item(1, { id: twin, dedupe_key: "twin" })] });
    const docs = [...(await run()).keys()].filter((k) => k.includes("/items/"));
    expect(docs.filter((k) => k.endsWith(".md"))).toEqual([`${ROOT}/items/2026-11/2026-11-20 高压锅红烧牛腩 (00000001).md`, `${ROOT}/items/2026-11/2026-11-20 高压锅红烧牛腩 (${twin}).md`]);
  });
});
