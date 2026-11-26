import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { selectAll } from "@/lib/db/select-all";
import { clock } from "@/lib/media/transcript";
import { postNotes } from "@/lib/sources/types";
import { stripCiteMarks } from "./ask";
import { toAsk } from "./ask-store";
import { cleanDoc } from "./journal-doc";
import { cleanMapNodes } from "./map-nodes";
import { notesOfItems } from "./note-store";
import type { ItemNote } from "./notes";
import { ITEM_COLUMNS, displayTitle, sourceLabel, toItem, type Item } from "./store";
import { CATEGORY_LABEL, CONTENT_TYPE_INFO, ENTITY_TYPE_INFO } from "./taxonomy";
import { ZipWriter } from "./zip";

/**
 * 整库导出：把一个人存在 Vault 里的东西打成一个 zip，边生成边发给浏览器。不调模型，不花钱。
 *
 * 包里有两样：
 * - 给人看的 Markdown（不用 Vault 也能读，能直接拖进 Obsidian 这类笔记软件）：每条内容一个文件（开头是 YAML 属性，
 *   下面是概括、卡片、要点、大纲、原话、原文、说的话），加上自己建的导图、问过的问题、日记；
 * - 完整的数据（`data/`，JSON）：每张表按原样导出，以后要搬到别处、或者写脚本处理用。
 *
 * **不包含文件本身**（图片、视频、音频、抽的帧、贴纸）：它们在存储桶和服务器的磁盘上，加起来可能几十 GB，这里只导出它们的路径。
 * 向量和拼出来的搜索全文也不导出（都能从别的列重新算出来）。
 *
 * 「没看到」和「没有」分开：哪张表还不存在、哪一段读的时候出错，记下来写进包里的 README.md，包照样生成完——
 * 不让一个半截的 zip 被当成完整的备份。
 */

type Db = SupabaseClient<Database>;

/** 一次读多少条内容（每条可能带几万字的口播，不一次全读进内存） */
const ITEM_PAGE = 50;
/** Markdown 文件最多写到这么多个就停：zip 一共只装得下 65,535 个文件，要给后面的数据文件和 README 留位置 */
export const DOC_LIMIT = 64_000;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const stamp = (now: Date) => `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;

export const exportName = (now: Date) => `vault-export-${stamp(now)}`;

/**
 * 标题 → 能当文件名的一段（纯函数）：去掉各个系统不让用的字符（/ \ : * ? " < > | 和控制字符），空白压成一个空格，
 * 开头的点去掉（不然成了隐藏文件），最多 60 个字。什么都不剩时用「未命名」。
 */
export function safeName(title: string): string {
  const clean = Array.from(
    title
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
  )
    .slice(0, 60)
    .join("")
    .trim();
  return clean || "未命名";
}

const id8 = (id: string) => id.slice(0, 8);
/** 数据里的时间（可能是空的、坏的）→ 文件的修改时间；用不了的时候用导出的时间 */
function fileTime(iso: string, fallback: Date): Date {
  const at = new Date(iso);
  return iso && !Number.isNaN(at.getTime()) ? at : fallback;
}
/** YAML 里的一个值：字符串写成 JSON 的双引号形式（YAML 认），免得冒号、井号、引号把属性弄坏 */
const yaml = (value: string | string[]) => (Array.isArray(value) ? `[${value.map((v) => JSON.stringify(v)).join(", ")}]` : JSON.stringify(value));
const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");

/** 一条内容写成 Markdown（纯函数）。只写有的部分；没处理成的也导出来（带着原文和失败的原因）。notes 是他在这条上划的线、写的批注。 */
export function itemMarkdown(item: Item, notes: Pick<ItemNote, "quote" | "body" | "at">[] = []): string {
  const u = item.understanding;
  const title = displayTitle(item);
  const props: [string, string | string[]][] = [["title", title], ["source", sourceLabel(item)]];
  if (item.author) props.push(["author", item.author]);
  if (item.url) props.push(["url", item.url]);
  props.push(["saved", day(item.createdAt)]);
  if (item.post.publishedAt) props.push(["published", day(item.post.publishedAt)]);
  if (item.contentType) props.push(["type", CONTENT_TYPE_INFO[item.contentType].label]);
  if (item.category) props.push(["category", CATEGORY_LABEL[item.category]]);
  if (item.tags.length > 0) props.push(["tags", item.tags]);
  props.push(["status", item.status], ["vault_id", item.id]);

  const parts: string[] = [`---\n${props.map(([k, v]) => `${k}: ${yaml(v)}`).join("\n")}\n---`, `# ${title}`];
  if (item.note) parts.push(`## 我的备注\n\n${item.note}`);
  if (notes.length > 0) {
    // 划的话写成引用（带着视频里的时间），自己写的话跟在下面
    const blocks = notes.map((n) => [n.quote ? `${quote(n.quote)}${n.at === null ? "" : `（${clock(n.at)}）`}` : "", n.body].filter(Boolean).join("\n\n"));
    parts.push(`## 我的划线和批注\n\n${blocks.join("\n\n---\n\n")}`);
  }
  if (item.status === "failed" && item.error) parts.push(`## 没处理成\n\n${item.error}`);
  if (u) {
    parts.push(`## 概括\n\n${u.summary}`);
    if (u.card.length > 0) parts.push(`## ${CONTENT_TYPE_INFO[u.contentType].label}\n\n${u.card.map((f) => `- **${f.label}**：${f.value.replace(/\n/g, "\n  ")}`).join("\n")}`);
    if (u.points.length > 0) parts.push(`## 内容要点\n\n${u.points.map((p) => `- ${p.at === null ? "" : `（${clock(p.at)}）`}${p.text}`).join("\n")}`);
    if (u.outline.length > 0) parts.push(`## 大纲\n\n${u.outline.map((n) => `${"  ".repeat(n.depth - 1)}- ${n.at === null ? "" : `（${clock(n.at)}）`}${n.text}`).join("\n")}`);
    if (u.quotes.length > 0) parts.push(`## 原话\n\n${u.quotes.map(quote).join("\n\n")}`);
    if (u.entities.length > 0) parts.push(`## 提到的\n\n${u.entities.map((e) => `- ${ENTITY_TYPE_INFO[e.type].label}：${e.name}${e.about ? `——${e.about}` : ""}`).join("\n")}`);
  }
  const gaps = [...postNotes(item.post), ...(u?.gaps ?? [])].filter((n, i, all) => all.indexOf(n) === i);
  if (gaps.length > 0) parts.push(`## 读这条内容时没看到的\n\n${gaps.map((g) => `- ${g}`).join("\n")}`);
  const body = item.userText || item.post.text;
  if (body) parts.push(`## 原文\n\n${body}`);
  if (u?.ocr) parts.push(`## 图上的文字\n\n${u.ocr}`);
  if (item.transcript) parts.push(`## 说的话\n\n${item.transcript}`);
  if (item.media.length > 0) parts.push(`## 文件（没有包含在这个导出里）\n\n${item.media.map((m) => `- ${m.role}：${m.path}`).join("\n")}`);
  return `${parts.join("\n\n")}\n`;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 自己建的一张导图写成 Markdown：标题 + 缩进的大纲（纯函数）。 */
export function mapMarkdown(row: Raw): string {
  const nodes = cleanMapNodes(row.nodes);
  return `# ${str(row.title) || "没起名的导图"}\n\n${nodes.map((n) => `${"  ".repeat(n.depth - 1)}- ${n.text}`).join("\n")}\n`;
}

/** 问过的一个问题和后面的追问写成 Markdown（纯函数）。回答里的出处标记 [1] 留着，下面列出是哪几条内容。 */
export function askMarkdown(row: Raw): string {
  const ask = toAsk(row as Parameters<typeof toAsk>[0]);
  const parts = [`# ${ask.title || "没写问题的一次提问"}`];
  for (const m of ask.chat) {
    if (m.role === "user") parts.push(`## 问：${m.text}`);
    else {
      parts.push(m.cites.length > 0 ? m.text : stripCiteMarks(m.text));
      if (m.cites.length > 0) parts.push(`出处：\n\n${m.cites.map((c, i) => `${i + 1}. ${c.title}${c.origin ? `（${c.origin}）` : ""}`).join("\n")}`);
      if (m.notes.length > 0) parts.push(m.notes.map((n) => `- ${n}`).join("\n"));
    }
  }
  return `${parts.join("\n\n")}\n`;
}

/** 一篇日记写成 Markdown：正文的文字、照片的说明、录音转出来的字（纯函数）。贴纸和手绘只在 data/ 里。 */
export function journalMarkdown(row: Raw, media: Map<string, Raw>): string {
  const doc = cleanDoc(row.doc);
  const head = [str(row.day), str(row.mood), str(row.weather)].filter(Boolean).join(" · ");
  const parts = [`# ${str(row.title) || str(row.day) || "日记"}`, head];
  for (const b of doc.blocks) {
    if (b.type === "text") {
      if (b.text.trim()) parts.push(b.text);
      continue;
    }
    const file = media.get(b.media);
    const path = file ? str(file.path) : "";
    if (b.type === "photo") parts.push(`（照片${b.caption ? `：${b.caption}` : ""}${path ? `，文件 ${path}` : ""}）`);
    else {
      const transcript = file ? str(file.transcript) : "";
      parts.push(`（录音${path ? `，文件 ${path}` : ""}）${transcript ? `\n\n${quote(transcript)}` : ""}`);
    }
  }
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** 按原样导出的表（内容那张单独分页读，不在这里）：列、排序用的列（要稳定，分页才不漏行） */
const TABLES: { name: string; label: string; columns: string; order: string[] }[] = [
  { name: "entities", label: "知识图谱的实体", columns: "id,user_id,type,name,aliases,summary,created_at,updated_at", order: ["id"] },
  { name: "item_entities", label: "内容和实体的关联", columns: "*", order: ["item_id", "entity_id"] },
  { name: "entity_edges", label: "实体之间的关系", columns: "*", order: ["item_id", "src_id", "dst_id", "relation"] },
  { name: "item_notes", label: "划线和批注", columns: "id,user_id,item_id,quote,body,at,created_at,updated_at", order: ["id"] },
  { name: "item_traces", label: "溯源的结果", columns: "*", order: ["item_id"] },
  { name: "maps", label: "自己建的导图", columns: "*", order: ["id"] },
  { name: "asks", label: "问过的问题", columns: "*", order: ["id"] },
  { name: "creators", label: "博主", columns: "*", order: ["id"] },
  { name: "creator_posts", label: "博主的作品清单", columns: "*", order: ["id"] },
  { name: "journal_entries", label: "日记", columns: "*", order: ["id"] },
  { name: "journal_media", label: "日记里的照片和录音（登记，不是文件）", columns: "*", order: ["id"] },
  { name: "journal_stickers", label: "我的贴纸（登记，不是文件）", columns: "*", order: ["id"] },
];

const missingTable = (message: string) => /42P01|PGRST205|does not exist|schema cache/i.test(message);

/**
 * 生成整个包：一段一段的字节（zip 的一个个文件，最后是目录）。now 是导出的时间（写进文件名和 README）。
 * 读某一部分出错不会让整个导出断掉：记进 README 的「没导出的」，后面的照常导出。
 */
export async function* exportArchive(db: Db, userId: string, now: Date = new Date()): AsyncGenerator<Uint8Array, void, void> {
  const zip = new ZipWriter();
  const root = exportName(now);
  // 表名和列是运行时拼的，类型化的客户端认不了：这一段按没有类型的用（每个查询都带 user_id，行级安全再兜一层）
  const raw = db as unknown as SupabaseClient;
  const counts: [string, number][] = [];
  const notes: string[] = [];
  let mediaFiles = 0;
  /** 加一个 Markdown 文件：名字后面带 id 的前 8 位；真撞上了同名的（同一天、同标题、id 开头也一样）就带上整个 id */
  const addDoc = (path: string, id: string, text: string, at: Date): Uint8Array => {
    if (zip.count >= DOC_LIMIT) throw new Error(`文件数到了 zip 装得下的上限（已经 ${zip.count} 个）`);
    try {
      return zip.add(`${root}/${path} (${id8(id)}).md`, text, at);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("已经有这个文件")) throw e;
      return zip.add(`${root}/${path} (${id}).md`, text, at);
    }
  };

  // 内容：一页一页读，每条一个 Markdown，原始的行按页存成 JSON
  let items = 0;
  let notesFailed = false;
  try {
    for (let page = 0; ; page++) {
      const { data, error } = await db
        .from("items")
        .select(ITEM_COLUMNS)
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(page * ITEM_PAGE, (page + 1) * ITEM_PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      if (rows.length === 0) break;
      // 这一页内容上的划线和批注写进各自的 Markdown。读不到只是 Markdown 里没有（原始数据后面还会单独导一遍），记一次
      let notesOf = new Map<string, ItemNote[]>();
      try {
        notesOf = (await notesOfItems(db, userId, rows.map((r) => r.id))).byItem;
      } catch (e) {
        if (!notesFailed) notes.push(`划线和批注：读的时候出错了，内容的 Markdown 里没有写进去（${e instanceof Error ? e.message : String(e)}）`);
        notesFailed = true;
      }
      for (const row of rows) {
        const item = toItem(row);
        mediaFiles += item.media.length;
        yield addDoc(`items/${item.createdAt.slice(0, 7)}/${day(item.createdAt)} ${safeName(displayTitle(item))}`, item.id, itemMarkdown(item, notesOf.get(item.id)), fileTime(item.createdAt, now));
      }
      yield zip.add(`${root}/data/items/items-${pad(page + 1, 4)}.json`, JSON.stringify(rows, null, 1), now);
      items += rows.length;
      if (rows.length < ITEM_PAGE) break;
    }
  } catch (e) {
    notes.push(`内容：读到第 ${items} 条之后出错了，后面的没有导出（${e instanceof Error ? e.message : String(e)}）`);
  }
  counts.push(["内容", items]);

  const tables = new Map<string, Raw[]>();
  for (const t of TABLES) {
    try {
      const rows = await selectAll<Raw>((from, to) => {
        let query = raw.from(t.name).select(t.columns).eq("user_id", userId);
        for (const column of t.order) query = query.order(column, { ascending: true });
        return query.range(from, to) as unknown as PromiseLike<{ data: Raw[] | null; error: { message: string } | null }>;
      }, t.label);
      tables.set(t.name, rows);
      counts.push([t.label, rows.length]);
      yield zip.add(`${root}/data/${t.name}.json`, JSON.stringify(rows, null, 1), now);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      notes.push(missingTable(message) ? `${t.label}：数据库里还没有这张表（迁移没推），没有导出` : `${t.label}：读的时候出错了，没有导出（${message}）`);
    }
  }
  mediaFiles += (tables.get("journal_media")?.length ?? 0) + (tables.get("journal_stickers")?.length ?? 0);

  // 给人看的：导图、问过的、日记。某一篇写不出来（数据的形状不对）只跳过那一篇，原始数据还在 data/ 里
  const readable = function* (table: string, label: string, write: (row: Raw) => { path: string; text: string; at: string }): Generator<Uint8Array> {
    let skipped = 0;
    for (const row of tables.get(table) ?? []) {
      try {
        const file = write(row);
        yield addDoc(file.path, str(row.id), file.text, fileTime(file.at, now));
      } catch {
        // 数据的形状不对，或者文件数到了上限
        skipped++;
      }
    }
    if (skipped > 0) notes.push(`${label}：有 ${skipped} 篇没能写成 Markdown（原始数据在 data/${table}.json 里）`);
  };
  yield* readable("maps", "自己建的导图", (row) => ({ path: `maps/${safeName(str(row.title) || "没起名的导图")}`, text: mapMarkdown(row), at: str(row.updated_at) }));
  yield* readable("asks", "问过的问题", (row) => ({ path: `asks/${day(str(row.created_at))} ${safeName(str(row.title) || "提问")}`, text: askMarkdown(row), at: str(row.updated_at) }));
  const journalMedia = new Map((tables.get("journal_media") ?? []).map((m) => [str(m.id), m]));
  yield* readable("journal_entries", "日记", (row) => ({ path: `journal/${str(row.day)} ${safeName(str(row.title) || "日记")}`, text: journalMarkdown(row, journalMedia), at: str(row.updated_at) }));

  yield zip.add(`${root}/README.md`, exportReadme({ now, counts, mediaFiles, notes }), now);
  yield zip.end();
}

/** 包里的 README.md：里面有什么、没有什么、这次没导出成的（纯函数）。 */
export function exportReadme(input: { now: Date; counts: [string, number][]; mediaFiles: number; notes: string[] }): string {
  const parts = [
    `# Vault 导出`,
    `导出时间：${input.now.toISOString()}（文件名和内容里的日期都是 UTC 的）`,
    `## 里面有什么\n\n${input.counts.map(([label, n]) => `- ${label}：${n}`).join("\n")}`,
    [
      "## 怎么看",
      "- `items/`：每条内容一个 Markdown 文件，按存进来的月份分文件夹。开头的属性（标题、来源、链接、标签…）是 YAML，Obsidian 这类笔记软件认；下面是概括、卡片、要点、大纲、原话、原文、说的话。",
      "- `maps/`、`asks/`、`journal/`：自己建的导图、问过的问题、日记，也是 Markdown。",
      "- `data/`：完整的数据，每张表一个 JSON 文件（内容那张表分成几个文件，在 `data/items/` 里）。Markdown 里没写的（处理花费、图谱的关联、贴纸和手绘的位置…）都在这里。",
    ].join("\n"),
    [
      "## 没有包含的",
      `- 文件本身（图片、视频、音频、抽的帧、日记的照片和录音、贴纸）：一共登记了 ${input.mediaFiles} 个，这里只有它们的路径。它们在 Supabase 的存储桶 \`vault\` 里；太大的视频原片在服务器的磁盘上，要另外备份。`,
      "- 搜索用的向量和拼出来的搜索全文：能从别的内容重新算出来。",
      "- 登录账号本身。",
    ].join("\n"),
  ];
  parts.push(input.notes.length > 0 ? `## 这次没导出成的\n\n${input.notes.map((n) => `- ${n}`).join("\n")}\n\n**这个包不完整**：上面这些补好之后重新导出一次。` : "## 这次没导出成的\n\n没有：上面列的每一部分都读完了。");
  return `${parts.join("\n\n")}\n`;
}
