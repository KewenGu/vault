import "server-only";
import { ClaudeNotConfiguredError, askClaude } from "@/lib/ai/claude";
import type { Session } from "@/lib/auth/user";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { ASK_SYSTEM, buildAskPrompt, parseAskReply, type AskMaterial } from "./ask";
import { ASK_CHAT_KEEP, ASK_TITLE_MAX, asksReady, createAsk, deleteAsk, getAsk, listAsks, updateAsk, type Ask, type AskMessage, type AskSummary } from "./ask-store";
import { VaultError } from "./errors";
import { isUuid } from "./map-nodes";
import { searchItems, type SearchHit, type Snippet } from "./search";
import { displayTitle, getItemsInOrder, sourceLabel, type Item } from "./store";

/**
 * 「问 Vault」：对着收藏库问一个问题，回答带出处；可以接着追问。页面的 server action 和 /api/v1/asks 的接口都调这里
 * （和 service.ts 一样：以后的手机 App 走接口，行为和网页一样）。能直接告诉用户的问题抛 VaultError。
 *
 * 一次提问 = 搜一次收藏库（关键词 + 语义，和首页的搜索是同一个）+ 一次 Claude 调用。只给模型看找出来的那几条的整理结果，
 * 不是整个收藏库，也不是原文全文——所以回答里「没提到」不等于「没存过」，页面上写着这次看了几条。
 * 日记不在收藏库里，这里读不到（见 AGENTS.md）。
 */

/** 一次最多从收藏库里找这么多条给模型看；追问时再带上之前的回答引用过的最近这么多条 */
export const FOUND_MAX = 12;
export const CARRIED_MAX = 6;
export const QUESTION_MAX = 2000;
/** 一次提问记着的「引用过的收藏」最多这么多条（再早的丢掉） */
const SOURCES_KEEP = 40;

/** gone = 回答引用过、现在已经不在收藏库里的内容（页面上不给链接） */
export type AskDetail = { ask: Ask; gone: string[] };

const NOT_FOUND = "这次提问不在了";

const origin = (item: Item) => [sourceLabel(item), item.author].filter(Boolean).join(" · ");
const usable = (item: Item): item is Item & { understanding: NonNullable<Item["understanding"]> } => item.status === "ready" && item.understanding !== null;

export async function listMyAsks(session: Session): Promise<AskSummary[]> {
  return listAsks(session.db, session.user.id);
}

/** 一次提问的全部对话，和它引用的内容里哪些已经删了。 */
export async function getAskDetail(session: Session, id: string): Promise<AskDetail> {
  const { user, db } = session;
  const ask = isUuid(id) ? await getAsk(db, user.id, id) : null;
  if (!ask) throw new VaultError(NOT_FOUND, 404);
  const cited = [...new Set(ask.chat.flatMap((m) => (m.role === "assistant" ? m.cites.map((c) => c.id) : [])))];
  const alive = new Set((await getItemsInOrder(db, user.id, cited)).map((i) => i.id));
  return { ask, gone: cited.filter((c) => !alive.has(c)) };
}

export async function removeAsk(session: Session, id: string): Promise<void> {
  if (!isUuid(id)) throw new VaultError(NOT_FOUND, 404);
  await deleteAsk(session.db, session.user.id, id);
}

/** 收藏库里处理好的内容一共几条（告诉模型和用户「这次只看了其中几条」）。数不出来不拦着回答。 */
async function countReady(session: Session): Promise<number | null> {
  const { count, error } = await session.db.from("items").select("id", { count: "exact", head: true }).eq("user_id", session.user.id).eq("status", "ready");
  if (error) {
    console.error(`问 Vault：数收藏库的条数出错: ${error.message}`);
    return null;
  }
  return count ?? null;
}

/**
 * 这次给模型看的材料：之前的回答引用过的（最近 CARRIED_MAX 条）+ 按这句话从收藏库里找到的。没带上的记进 notes。
 * 搜索本身出错时不回答（抛 502）：拿不到材料还让模型答，只会得到一句误导人的「没找到」。
 */
async function gatherMaterials(session: Session, ask: Ask | null, question: string): Promise<{ materials: AskMaterial[]; notes: string[]; alive: string[] }> {
  const { user, db } = session;
  const notes: string[] = [];
  const carriedAll = ask ? await getItemsInOrder(db, user.id, ask.sources, true) : [];
  const alive = carriedAll.map((i) => i.id);
  const carried = carriedAll.filter(usable).slice(-CARRIED_MAX);

  // 追问往往只有半句（「那第二个呢」）：把上一句问的也带上一起搜
  const previous = ask?.chat.findLast((m) => m.role === "user")?.text ?? "";
  const query = `${question} ${previous}`.trim().slice(0, 400);
  let hits: SearchHit[];
  let semantic: boolean;
  try {
    const result = await searchItems(db, user.id, { q: query, limit: FOUND_MAX + carried.length + 4 });
    hits = result.hits.filter((h) => !carried.some((c) => c.id === h.item.id));
    semantic = result.semantic;
  } catch (e) {
    console.error(`问 Vault：搜索收藏库出错 user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    throw new VaultError("搜索收藏库出错了，这次没法回答。过一会儿再试", 502);
  }
  if (!semantic) notes.push("语义搜索这次不可用（没配 VOYAGE_API_KEY 或接口出错），只按字面从收藏库里找了相关内容：问题里的词要原样出现在内容里才找得到，意思相近但用词不同的没找到");
  const snippets = new Map<string, Snippet | null>(hits.map((h) => [h.item.id, h.snippet]));
  const foundAll = await getItemsInOrder(db, user.id, hits.map((h) => h.item.id), true);
  const found = foundAll.filter(usable).slice(0, FOUND_MAX);
  const unready = foundAll.filter((i) => !usable(i)).length;
  if (unready > 0) notes.push(`找到的内容里有 ${unready} 条还没处理好（或处理失败），这次没带上`);

  const materials = [...carried.map((item) => ({ item, carried: true })), ...found.map((item) => ({ item, carried: false }))].map(
    ({ item, carried: isCarried }, i): AskMaterial => ({
      label: `S${i + 1}`,
      id: item.id,
      title: displayTitle(item),
      origin: origin(item),
      savedAt: item.createdAt,
      note: item.note,
      tags: item.tags,
      carried: isCarried,
      understanding: item.understanding!,
      snippet: snippets.get(item.id) ?? null,
    })
  );
  return { materials, notes, alive };
}

function addCounts(into: Record<string, number>, counts: Record<string, number>): Record<string, number> {
  const out = { ...into };
  for (const [k, n] of Object.entries(counts)) out[k] = (out[k] ?? 0) + n;
  return out;
}

const cleanTitle = (question: string) => Array.from(question.replace(/\s+/g, " ").trim()).slice(0, ASK_TITLE_MAX).join("");

/**
 * 问一个问题。给了 id = 在那次提问里接着追问（带着之前的一问一答和引用过的内容）；没给 = 新开一次。
 * 要等模型，一般十几秒到一分钟。收藏库里什么都没找到时不调模型，直接说没找到。
 */
export async function askVault(session: Session, input: { question: string; id?: string }): Promise<AskDetail> {
  const { user, db } = session;
  const question = input.question.trim();
  if (!question) throw new VaultError("写下想问的问题");
  if (question.length > QUESTION_MAX) throw new VaultError(`问题太长了（最多 ${QUESTION_MAX.toLocaleString("en-US")} 字）`);
  let ask: Ask | null = null;
  if (input.id !== undefined) {
    ask = isUuid(input.id) ? await getAsk(db, user.id, input.id) : null;
    if (!ask) throw new VaultError(NOT_FOUND, 404);
  } else {
    // 新开的：先确认存得下（表在不在），免得等完模型、花了钱才发现没地方放
    await asksReady(db, user.id);
  }

  const [{ materials, notes, alive }, total] = await Promise.all([gatherMaterials(session, ask, question), countReady(session)]);
  const counts: Record<string, number> = {};
  let text: string;
  let cites: AskMaterial[] = [];
  if (materials.length === 0) {
    text = total === 0 ? "收藏库里还没有处理好的内容。先存几条，再来问。" : "这次没在收藏库里找到和这个问题相关的内容。换个说法再问一次，或者去收藏库里直接搜关键词。";
  } else {
    const prompt = buildAskPrompt({ materials, total, history: ask?.chat ?? [], question, notes, now: new Date() });
    const lostCost = async () => {
      if (Object.keys(counts).length === 0) return;
      if (ask) {
        const usage = addCounts(ask.usage, counts);
        await updateAsk(db, user.id, ask.id, { usage, costUsd: estimateUsd(usage) });
      } else console.error(`问 Vault：这次调用没有产出回答，花费没有记到任何一次提问上 user=${user.id}: ${JSON.stringify(counts)}`);
    };
    let result;
    try {
      result = await meterInto(counts, () => askClaude({ system: ASK_SYSTEM, prompt }));
    } catch (e) {
      await lostCost();
      // askClaude 自己抛的错都是给用户看的话（限流、密钥不对、拒答）；别的（网络断了…）往上抛
      if (e instanceof ClaudeNotConfiguredError) throw new VaultError("没配 ANTHROPIC_API_KEY，没法回答问题");
      if (e instanceof Error && /Claude|ANTHROPIC|模型拒绝/.test(e.message)) throw new VaultError(e.message.replace("处理这条内容", "回答这个问题"), 502);
      throw e;
    }
    const parsed = parseAskReply(result.text, materials);
    if (!parsed.text) {
      await lostCost();
      throw new VaultError("AI 这次没有给出能用的回答，再问一次", 502);
    }
    text = parsed.text;
    cites = parsed.cites;
    if (result.truncated) notes.push("回答太长，被截断了：后面的没写完。把问题问得小一点再试");
    if (parsed.dropped > 0) notes.push(`回答里有 ${parsed.dropped} 处出处的编号对不上这次找到的内容，已经去掉：那几句话没有出处`);
    if (cites.length === 0) notes.push("这个回答没有标出处：不是从你的收藏里来的，或者这次找到的内容都用不上");
  }

  const now = new Date().toISOString();
  const reply: AskMessage = { role: "assistant", text, at: now, cites: cites.map((c) => ({ id: c.id, title: c.title, origin: c.origin })), notes, seen: materials.length, total };
  const chat = [...(ask?.chat ?? []), { role: "user" as const, text: question, at: now }, reply].slice(-ASK_CHAT_KEEP);
  // 引用过的内容记下来（追问时还带着）；已经删掉的从里面去掉
  const sources = [...new Set([...alive, ...cites.map((c) => c.id)])].slice(-SOURCES_KEEP);
  const usage = addCounts(ask?.usage ?? {}, counts);
  const patch = { chat, sources, usage, costUsd: estimateUsd(usage) };
  let id: string;
  if (ask) {
    if (!(await updateAsk(db, user.id, ask.id, patch))) throw new VaultError(NOT_FOUND, 404);
    id = ask.id;
  } else id = await createAsk(db, user.id, { title: cleanTitle(question), ...patch });
  return getAskDetail(session, id);
}
