import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ClaudeNotConfiguredError, askClaude } from "@/lib/ai/claude";
import type { Session } from "@/lib/auth/user";
import type { Database } from "@/lib/db/types";
import { selectAll } from "@/lib/db/select-all";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { parseAskReply } from "./ask";
import { asksReady, createAsk, findAskByTitle, listAsks, type AskMessage, type AskSummary } from "./ask-store";
import { VaultError } from "./errors";
import { notesBetween, notesOfItems } from "./note-store";
import type { ItemNote } from "./notes";
import {
  REVIEW_ITEMS_MAX,
  REVIEW_SYSTEM,
  addDays,
  asAskMaterial,
  buildReviewPrompt,
  cleanTz,
  daysRange,
  itemLookBackDays,
  pickForDay,
  readReviewDays,
  recurring,
  reviewTitle,
  weekLabel,
  weekRange,
  type ReviewMaterial,
} from "./review";
import { ITEM_LIST_COLUMNS, displayTitle, getItemsInOrder, sourceLabel, toItem, type Item } from "./store";
import { CATEGORY_LABEL, toEntityType, type Category, type EntityType } from "./taxonomy";

/**
 * 「回顾」：收藏库自己把东西翻出来给你看，不用你去找。三样：
 *
 * - 这一周：存了什么（按领域分）、哪些人 / 东西 / 标签出现了不止一次、自己写了什么（自己写的内容、划的线和批注）、问过什么。
 * - 翻出来的：今天从早些时候存的内容里挑几条（同一天挑的一样，换一天换一批）；往期的今天（一个月前、半年前、往年的同一天存的）。
 * - AI 写的一周回顾：点了才写（一次 Claude 调用），把这一周存的和写的归成几条线、带出处。写完存成一次「提问」，
 *   在「问」里看、能接着追问——不另建表。
 *
 * 前两样都是现成的数据，不调模型、不花钱。页面的 server action 和 /api/v1/review 的接口都调这里。
 * 日记不在里面（见 AGENTS.md）：日记有自己的「那年今日」。
 */

type Db = SupabaseClient<Database>;

/** 一周最多列这么多条内容、这么多条笔记；常出现的实体和标签各列这么多 */
export const WEEK_ITEMS_MAX = 200;
const WEEK_NOTES_MAX = 50;
const RECURRING_MAX = 12;
/** 今天翻几条出来；往期的今天最多列几条 */
export const PICKS = 3;
const LOOK_BACK_MAX = 6;
const SOURCES_KEEP = 40;

export type WeekEntity = { id: string; name: string; type: EntityType; count: number };
export type WeekReview = {
  /** 这一周的周一（当地的日期）和周日 */
  week: string;
  lastDay: string;
  label: string;
  /** 这一周存的内容，新存的在前（还在处理、处理失败的也在里面）；more = 超过了能列的上限 */
  items: Item[];
  more: boolean;
  /** 处理好的按领域分，条数多的在前 */
  byCategory: { category: Category | null; label: string; items: Item[] }[];
  /** 这一周不止一条内容提到的人 / 地方 / 东西，和不止一条内容带着的标签 */
  entities: WeekEntity[];
  tags: { tag: string; count: number }[];
  /** 这一周自己写的内容 */
  own: Item[];
  /** 这一周划的线、写的批注（写在哪条内容上都算），新写的在前 */
  notes: { note: ItemNote; itemTitle: string }[];
  /** 这一周问过的（含 AI 写的回顾） */
  asks: AskSummary[];
  /** AI 给这一周写过回顾的话，是哪一次提问 */
  aiReviewId: string | null;
  /** 这次没读到的 */
  gaps: string[];
};
export type Resurfaced = {
  /** 今天翻出来的：这一周之前存的内容里挑的 */
  picks: Item[];
  /** 往期的今天存的 */
  lookBack: { label: string; item: Item }[];
};
export type Review = { today: string; week: WeekReview; resurfaced: Resurfaced | null };

const BAD_DAYS = "要给今天是哪一天（当地的日期，YYYY-MM-DD）；哪一周的话给那一周里的任何一天";

async function itemsBetween(db: Db, userId: string, from: string, to: string, limit: number): Promise<Item[]> {
  const { data, error } = await db.from("items").select(ITEM_LIST_COLUMNS).eq("user_id", userId).neq("status", "uploading").gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`读取这段时间存的内容失败: ${error.message}`);
  return (data ?? []).map(toItem);
}

/** 这几条内容里不止一条提到的实体 */
async function recurringEntities(db: Db, userId: string, itemIds: string[]): Promise<WeekEntity[]> {
  const links: { entity_id: string }[] = [];
  for (let i = 0; i < itemIds.length; i += 50) {
    const { data, error } = await db.from("item_entities").select("entity_id").eq("user_id", userId).in("item_id", itemIds.slice(i, i + 50));
    if (error) throw new Error(`读取图谱关联失败: ${error.message}`);
    links.push(...(data ?? []));
  }
  const top = recurring(links, (l) => l.entity_id, RECURRING_MAX);
  if (top.length === 0) return [];
  const { data, error } = await db.from("entities").select("id,type,name").eq("user_id", userId).in("id", top.map((t) => t.value.entity_id));
  if (error) throw new Error(`读取实体失败: ${error.message}`);
  const byId = new Map((data ?? []).map((e) => [e.id, e]));
  return top.flatMap(({ value, count }) => {
    const e = byId.get(value.entity_id);
    const type = e ? toEntityType(e.type) : null;
    return e && type ? [{ id: e.id, name: e.name, type, count }] : [];
  });
}

async function weekReview(session: Session, week: string, tz: number): Promise<WeekReview> {
  const { user, db } = session;
  const range = weekRange(week, tz);
  const gaps: string[] = [];
  const fetched = await itemsBetween(db, user.id, range.from, range.to, WEEK_ITEMS_MAX + 1);
  const items = fetched.slice(0, WEEK_ITEMS_MAX);
  const ready = items.filter((i) => i.status === "ready");

  const groups = new Map<string, { category: Category | null; label: string; items: Item[] }>();
  for (const item of ready) {
    const key = item.category ?? "";
    const group = groups.get(key) ?? { category: item.category, label: item.category ? CATEGORY_LABEL[item.category] : "没分类的", items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  let entities: WeekEntity[] = [];
  try {
    entities = await recurringEntities(db, user.id, ready.map((i) => i.id));
  } catch (e) {
    console.error(`回顾：读图谱出错 user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    gaps.push("这次没读到这一周常出现的人和东西（查询出错）");
  }

  // 这一周写的笔记：写在哪条内容上都算（那条内容可能是更早存的）
  let notes: WeekReview["notes"] = [];
  try {
    const found = (await notesBetween(db, user.id, range.from, range.to, WEEK_NOTES_MAX)).notes;
    const titles = new Map(items.map((i) => [i.id, displayTitle(i)]));
    const elsewhere = [...new Set(found.map((n) => n.itemId).filter((id) => !titles.has(id)))];
    for (const item of await getItemsInOrder(db, user.id, elsewhere)) titles.set(item.id, displayTitle(item));
    notes = found.map((note) => ({ note, itemTitle: titles.get(note.itemId) ?? "" }));
  } catch (e) {
    console.error(`回顾：读笔记出错 user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    gaps.push("这次没读到这一周划的线和写的批注（查询出错）");
  }

  let asks: AskSummary[] = [];
  let aiReviewId: string | null = null;
  try {
    asks = (await listAsks(db, user.id)).filter((a) => a.updatedAt >= range.from && a.updatedAt < range.to);
    aiReviewId = await findAskByTitle(db, user.id, reviewTitle(week));
  } catch (e) {
    // 表还没建（VaultError）就是没问过；别的错说一声
    if (!(e instanceof VaultError)) {
      console.error(`回顾：读问过的出错 user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
      gaps.push("这次没读到这一周问过的问题（查询出错）");
    }
  }

  return {
    week,
    lastDay: addDays(week, 6),
    label: weekLabel(week),
    items,
    more: fetched.length > WEEK_ITEMS_MAX,
    byCategory: [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label)),
    entities,
    tags: recurring(ready.flatMap((i) => i.tags), (t) => t, RECURRING_MAX).map(({ value, count }) => ({ tag: value, count })),
    own: items.filter((i) => i.source === "own"),
    notes,
    asks,
    aiReviewId,
    gaps,
  };
}

/** 今天翻出来的、往期的今天。读不出来不拦着别的：返回 null，页面上那一块不显示。 */
async function resurface(session: Session, today: string, tz: number): Promise<Resurfaced | null> {
  const { user, db } = session;
  try {
    // 候选：这一周之前存的、处理好的。这一周存的在「这一周」里已经列着了
    const before = weekRange(readReviewDays({ today })!.week, tz).from;
    const candidates = await selectAll<{ id: string }>((from, to) => db.from("items").select("id").eq("user_id", user.id).eq("status", "ready").lt("created_at", before).order("id").range(from, to), "收藏库");
    const picks = await getItemsInOrder(db, user.id, pickForDay(candidates.map((c) => c.id), `${today}:${user.id}`, PICKS));
    const days = itemLookBackDays(today);
    const found = await Promise.all(
      days.map(async ({ day, label }) => {
        const range = daysRange(day, addDays(day, 1), tz);
        return (await itemsBetween(db, user.id, range.from, range.to, 3)).filter((i) => i.status === "ready").map((item) => ({ label, item }));
      })
    );
    return { picks, lookBack: found.flat().slice(0, LOOK_BACK_MAX) };
  } catch (e) {
    console.error(`回顾：翻旧内容出错 user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * 回顾页要的全部：today = 看的人当地的今天，tz = 他的时区差（分钟，浏览器的 getTimezoneOffset），week = 看哪一周（不给是这一周）。
 * 翻出来的只跟今天有关，看以前的某一周时也是今天的那几条。
 */
export async function getReview(session: Session, input: { today: unknown; tz?: unknown; week?: unknown }): Promise<Review> {
  const days = readReviewDays(input);
  if (!days) throw new VaultError(BAD_DAYS);
  const tz = cleanTz(input.tz);
  const [week, resurfaced] = await Promise.all([weekReview(session, days.week, tz), resurface(session, days.today, tz)]);
  return { today: days.today, week, resurfaced };
}

/** 只要翻出来的（首页那一小块用）。 */
export async function getResurfaced(session: Session, input: { today: unknown; tz?: unknown }): Promise<Resurfaced | null> {
  const days = readReviewDays(input);
  if (!days) throw new VaultError(BAD_DAYS);
  return resurface(session, days.today, cleanTz(input.tz));
}

const origin = (item: Item) => [sourceLabel(item), item.author].filter(Boolean).join(" · ");
/** 存进来的那一刻在他当地是哪一天 */
const localDayOf = (iso: string, tz: number) => new Date(new Date(iso).getTime() - tz * 60_000).toISOString().slice(0, 10);

/**
 * 让 AI 写这一周的回顾：把这一周存的和写的归成几条线，带出处。一次 Claude 调用；写完存成一次「提问」（标题认得出是哪一周），
 * 返回那次提问的 id——页面带他去「问」的对话页看，可以接着追问。这一周已经写过的直接返回那一次，不重复花钱
 * （要重写：在「问」里把那一次删了再来）。
 */
export async function writeWeekReview(session: Session, input: { week: unknown; tz?: unknown }): Promise<{ id: string; existing: boolean }> {
  const days = readReviewDays({ today: input.week, week: input.week });
  if (!days) throw new VaultError("要给是哪一周（那一周里任何一天的日期，YYYY-MM-DD）");
  const { week } = days;
  const tz = cleanTz(input.tz);
  const { user, db } = session;
  // 先确认存得下、有没有写过，免得等完模型、花了钱才发现
  await asksReady(db, user.id);
  const had = await findAskByTitle(db, user.id, reviewTitle(week));
  if (had) return { id: had, existing: true };

  const range = weekRange(week, tz);
  const all = (await itemsBetween(db, user.id, range.from, range.to, WEEK_ITEMS_MAX + 1)).filter((i) => i.status === "ready");
  if (all.length === 0) throw new VaultError("这一周没有存进来处理好的内容，没什么可回顾的");
  const picked = all.slice(0, REVIEW_ITEMS_MAX);
  const gaps: string[] = [];
  if (all.length > picked.length) gaps.push(`这一周存了${all.length > WEEK_ITEMS_MAX ? ` ${WEEK_ITEMS_MAX} 条以上` : ` ${all.length} 条`}，只看了最近存的 ${picked.length} 条`);

  // 自己写的那几条要原文（列表的列里没有）；笔记读不到不拦着，但要说
  const ownText = new Map((await getItemsInOrder(db, user.id, picked.filter((i) => i.source === "own").map((i) => i.id), true)).map((i) => [i.id, i.userText ?? ""]));
  let notesOf = new Map<string, ItemNote[]>();
  try {
    notesOf = (await notesOfItems(db, user.id, picked.map((i) => i.id))).byItem;
  } catch (e) {
    console.error(`回顾：读笔记出错 user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    gaps.push("这次没读到你在这些内容上划的线和写的批注（查询出错），回顾里不会有它们");
  }
  const materials: ReviewMaterial[] = picked.map((item, i) => ({
    label: `S${i + 1}`,
    id: item.id,
    title: displayTitle(item),
    origin: origin(item),
    day: localDayOf(item.createdAt, tz),
    contentType: item.contentType,
    category: item.category,
    tags: item.tags,
    summary: item.summary,
    note: item.note,
    ownText: ownText.get(item.id) ?? "",
    notes: notesOf.get(item.id) ?? [],
  }));

  const counts: Record<string, number> = {};
  let result;
  try {
    result = await meterInto(counts, () => askClaude({ system: REVIEW_SYSTEM, prompt: buildReviewPrompt({ week, materials, gaps }) }));
  } catch (e) {
    if (Object.keys(counts).length > 0) console.error(`回顾：这次调用没有产出回顾，花费没有记到任何地方 user=${user.id}: ${JSON.stringify(counts)}`);
    if (e instanceof ClaudeNotConfiguredError) throw new VaultError("没配 ANTHROPIC_API_KEY，没法写回顾");
    if (e instanceof Error && /Claude|ANTHROPIC|模型拒绝/.test(e.message)) throw new VaultError(e.message.replace("处理这条内容", "写这一周的回顾"), 502);
    throw e;
  }
  const parsed = parseAskReply(result.text, materials.map(asAskMaterial));
  if (!parsed.text) {
    console.error(`回顾：模型没有给出能用的回顾，花费没有记到任何地方 user=${user.id}: ${JSON.stringify(counts)}`);
    throw new VaultError("AI 这次没有写出能用的回顾，再试一次", 502);
  }
  const notes = [...gaps];
  if (result.truncated) notes.push("回顾太长，被截断了：后面的没写完");
  if (parsed.dropped > 0) notes.push(`回顾里有 ${parsed.dropped} 处出处的编号对不上这一周的内容，已经去掉：那几句话没有出处`);
  if (parsed.cites.length === 0) notes.push("这篇回顾没有标出处");

  const now = new Date().toISOString();
  const { count } = await db.from("items").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "ready");
  const reply: AskMessage = { role: "assistant", text: parsed.text, at: now, cites: parsed.cites.map((c) => ({ id: c.id, title: c.title, origin: c.origin })), notes, seen: materials.length, total: count ?? null };
  const id = await createAsk(db, user.id, {
    title: reviewTitle(week),
    chat: [{ role: "user", text: `回顾 ${weekLabel(week)} 这一周存的和写的`, at: now }, reply],
    sources: parsed.cites.map((c) => c.id).slice(-SOURCES_KEEP),
    usage: counts,
    costUsd: estimateUsd(counts),
  });
  return { id, existing: false };
}
