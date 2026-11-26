import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@/lib/auth/user";
import type { Database, Json } from "@/lib/db/types";
import { embedTexts } from "@/lib/embeddings";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { VaultError } from "./errors";
import { buildEmbeddingText, buildSearchText } from "./indexing";
import { isUuid } from "./map-nodes";
import { countNotesOfItem, createNote, deleteNote, getNote, listNotes, listNotesOfItem, updateNoteBody } from "./note-store";
import { NOTE_MAX, cleanAt, cleanBody, cleanQuote, notesIndexText, type ItemNote } from "./notes";
import { displayTitle, getItem, getItemsInOrder, sourceLabel } from "./store";

/**
 * 划线和批注：在一条收藏的内容上留下自己的东西——划下一段原话，或者写一段自己的想法，或者两样都有。
 * 页面的 server action 和 /api/v1 的接口都调这里。能直接告诉用户的问题抛 VaultError。
 *
 * 笔记要「进库」：写完、改完、删完之后，把这条内容的搜索全文和向量重新算一遍（带上它所有的笔记），
 * 这样首页的搜索、「问」、「相关的内容」都找得到他自己写过的话。向量那一次要调 Voyage（一次不到万分之一美元，记在这条内容的账上）。
 * 重新算没成不影响笔记本身——笔记已经存好了——但要告诉他这条笔记暂时搜不到（warning）。
 */

type Db = SupabaseClient<Database>;

const ITEM_GONE = "这条内容不在了";
const NOTE_GONE = "这条笔记不在了";

/** 存 / 改 / 删之后的结果：warning 是笔记存好了、但索引没更新成时给用户看的话 */
export type NoteSaved = { notes: ItemNote[]; warning: string | null };
/** 「笔记」页的一行：笔记和它挂着的那条内容（内容不在了是 null——正常不会有，内容删了笔记跟着删） */
export type NoteWithItem = { note: ItemNote; item: { id: string; title: string; origin: string } | null };

export async function listItemNotes(session: Session, itemId: string): Promise<ItemNote[]> {
  if (!isUuid(itemId)) throw new VaultError(ITEM_GONE, 404);
  return listNotesOfItem(session.db, session.user.id, itemId);
}

/**
 * 把一条内容的搜索全文和向量按现在的笔记重新算一遍。这条内容还在处理中的不动（处理的最后一步会带着笔记建索引）。
 * 返回没更新成的原因（给用户看的一句话），成了是 null。
 */
export async function reindexItem(db: Db, userId: string, itemId: string): Promise<string | null> {
  try {
    const item = await getItem(db, userId, itemId);
    if (!item || item.status !== "ready") return null;
    const notes = await listNotesOfItem(db, userId, itemId);
    const input = { title: item.title, author: item.author, url: item.url, note: item.note, annotations: notesIndexText(notes), post: item.post, userText: item.userText, transcript: item.transcript, tags: item.tags, understanding: item.understanding };
    const counts: Record<string, number> = {};
    let embedding: number[] | null = null;
    let embedProblem: string | null = null;
    if (process.env.VOYAGE_API_KEY) {
      try {
        [embedding] = await meterInto(counts, () => embedTexts([buildEmbeddingText(input)], "document"));
      } catch (e) {
        console.error(`笔记：向量没更新 item=${itemId}: ${e instanceof Error ? e.message : String(e)}`);
        embedProblem = "笔记存好了，按字面搜得到；但语义搜索的索引这次没更新成（向量服务出错），「问」和意思相近的搜索暂时找不到这条笔记。点这条内容底部的「重新分析」会补上";
      }
    }
    // 向量那一次花的钱记在这条内容的账上
    let bill = {};
    if (Object.keys(counts).length > 0) {
      const { data: row } = await db.from("items").select("usage").eq("id", itemId).eq("user_id", userId).maybeSingle();
      const usage: Record<string, number> = {};
      for (const [k, n] of Object.entries((row?.usage ?? {}) as Record<string, unknown>)) if (typeof n === "number") usage[k] = n;
      for (const [k, n] of Object.entries(counts)) usage[k] = (usage[k] ?? 0) + n;
      bill = { usage: usage as Json, cost_usd: estimateUsd(usage) };
    }
    // 只在还是「处理好了」的时候写：这中间开始重新处理了的话，让处理的那一轮自己建索引
    const { error } = await db
      .from("items")
      .update({ search_text: buildSearchText(input), ...(embedding ? { embedding: JSON.stringify(embedding) } : {}), ...bill })
      .eq("id", itemId)
      .eq("user_id", userId)
      .eq("status", "ready");
    if (error) throw new Error(error.message);
    return embedProblem;
  } catch (e) {
    console.error(`笔记：搜索索引没更新 item=${itemId}: ${e instanceof Error ? e.message : String(e)}`);
    return "笔记存好了，但搜索的索引这次没更新成：暂时搜不到这条笔记。点这条内容底部的「重新分析」会补上";
  }
}

const done = async (session: Session, itemId: string): Promise<NoteSaved> => {
  const warning = await reindexItem(session.db, session.user.id, itemId);
  return { notes: await listNotesOfItem(session.db, session.user.id, itemId), warning };
};

/** 在一条内容上加一条笔记：划线（quote）、批注（body），至少要有一样。at 是那段话在视频 / 音频里的秒数。 */
export async function addNote(session: Session, itemId: string, input: { quote?: unknown; body?: unknown; at?: unknown }): Promise<NoteSaved> {
  const { user, db } = session;
  const quote = cleanQuote(input.quote);
  const body = cleanBody(input.body);
  if (!quote && !body) throw new VaultError("划一段话，或者写点什么");
  const item = isUuid(itemId) ? await getItem(db, user.id, itemId) : null;
  if (!item) throw new VaultError(ITEM_GONE, 404);
  if ((await countNotesOfItem(db, user.id, itemId)) >= NOTE_MAX.perItem) throw new VaultError(`一条内容上最多 ${NOTE_MAX.perItem} 条笔记`);
  await createNote(db, user.id, { itemId, quote, body, at: quote ? cleanAt(input.at) : null });
  return done(session, itemId);
}

/** 改一条笔记里自己写的那段话（划下来的原话不能改）。改成空的：只划了线的留着划线，本来就只有这段话的要用删除。 */
export async function editNote(session: Session, noteId: string, input: { body?: unknown }): Promise<NoteSaved> {
  const { user, db } = session;
  const note = isUuid(noteId) ? await getNote(db, user.id, noteId) : null;
  if (!note) throw new VaultError(NOTE_GONE, 404);
  const body = cleanBody(input.body);
  if (!body && !note.quote) throw new VaultError("这条笔记只有这段话：不想要了就删掉它");
  if (!(await updateNoteBody(db, user.id, noteId, body))) throw new VaultError(NOTE_GONE, 404);
  return done(session, note.itemId);
}

export async function removeNote(session: Session, noteId: string): Promise<NoteSaved> {
  const { user, db } = session;
  const note = isUuid(noteId) ? await getNote(db, user.id, noteId) : null;
  if (!note) throw new VaultError(NOTE_GONE, 404);
  await deleteNote(db, user.id, noteId);
  return done(session, note.itemId);
}

/** 所有的笔记，新写的在前，带着各自挂着的那条内容的标题（「笔记」页用）。q = 按字面找。 */
export async function listMyNotes(session: Session, input: { q?: string } = {}): Promise<{ notes: NoteWithItem[]; more: boolean }> {
  const { user, db } = session;
  const { notes, more } = await listNotes(db, user.id, input);
  const items = new Map((await getItemsInOrder(db, user.id, [...new Set(notes.map((n) => n.itemId))])).map((i) => [i.id, i]));
  return {
    notes: notes.map((note) => {
      const item = items.get(note.itemId);
      return { note, item: item ? { id: item.id, title: displayTitle(item), origin: [sourceLabel(item), item.author].filter(Boolean).join(" · ") } : null };
    }),
    more,
  };
}
