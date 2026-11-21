import "server-only";
import { ClaudeNotConfiguredError, askClaude } from "@/lib/ai/claude";
import type { Session } from "@/lib/auth/user";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { VaultError } from "./errors";
import { MAP_CHAT_SYSTEM, buildMapChatPrompt, parseMapChatReply, sameNodes, type Material } from "./map-chat";
import { cleanMapNodes, cleanMapTitle, cleanSources, isUuid, type MapNode } from "./map-nodes";
import { CHAT_KEEP, createMap, deleteMap, getMap, listMaps, updateMap, type ChatMessage, type MapSummary, type VaultMap } from "./map-store";
import { searchItems } from "./search";
import { displayTitle, getItem, getItemsInOrder, sourceLabel, type Item } from "./store";

/**
 * 自己建的思维导图：新建 / 保存 / 跟 AI 对话改图 / 撤销 / 删除。页面的 server action 和 /api/v1/maps 的接口都调这里
 * （和 service.ts 一样：以后的手机 App 走接口，行为和网页一样）。能直接告诉用户的问题抛 VaultError。
 */

/** 一次对话最多带这么多条挂着的收藏、再从收藏库里找这么多条；起草时多找一些 */
export const ATTACHED_MAX = 16;
export const FOUND_MAX = 8;
export const DRAFT_FOUND_MAX = 14;
export const MESSAGE_MAX = 2000;

/** 起草时替用户说的那句话（存进对话里，页面上照常显示） */
export const DRAFT_MESSAGE = "根据我收藏的内容，围绕这张图的标题起草一张思维导图。";

/** 页面上列出来的一条来源 */
export type MapSource = { id: string; title: string; origin: string };
export type MapDetail = { map: VaultMap; sources: MapSource[] };

const NOT_FOUND = "这张导图不在了";

const origin = (item: Item) => [sourceLabel(item), item.author].filter(Boolean).join(" · ");
const toSource = (item: Item): MapSource => ({ id: item.id, title: displayTitle(item), origin: origin(item) });

export async function listMyMaps(session: Session): Promise<MapSummary[]> {
  return listMaps(session.db, session.user.id);
}

/** 一张图和它挂着的收藏（已经删掉的那些不列）。 */
export async function getMapDetail(session: Session, id: string): Promise<MapDetail> {
  const { user, db } = session;
  const map = isUuid(id) ? await getMap(db, user.id, id) : null;
  if (!map) throw new VaultError(NOT_FOUND, 404);
  const items = await getItemsInOrder(db, user.id, map.sources);
  return { map, sources: items.map(toSource) };
}

/**
 * 新建一张图。给了 itemId = 从收藏库里的一条内容开始：标题用它的，它有大纲就把大纲抄过来当起点（第一层分支标上出处），
 * 并把它挂成来源。
 */
export async function createMapFor(session: Session, input: { title?: string; itemId?: string }): Promise<string> {
  const { user, db } = session;
  if (!input.itemId) return createMap(db, user.id, { title: cleanMapTitle(input.title) });
  const item = isUuid(input.itemId) ? await getItem(db, user.id, input.itemId) : null;
  if (!item) throw new VaultError("这条内容不在了", 404);
  const nodes: MapNode[] = (item.understanding?.outline ?? []).map((n) => ({ depth: n.depth, text: n.text, item: n.depth === 1 ? item.id : null }));
  return createMap(db, user.id, { title: cleanMapTitle(input.title) || cleanMapTitle(displayTitle(item)), nodes: cleanMapNodes(nodes), sources: [item.id] });
}

export type MapEdit = { title?: unknown; nodes?: unknown; sources?: unknown };

/** 保存用户自己改的（标题、节点、挂着的收藏）。传进来的东西先收一遍（见 map-nodes.ts）。 */
export async function saveMap(session: Session, id: string, edit: MapEdit): Promise<void> {
  const patch = {
    ...(edit.title !== undefined ? { title: cleanMapTitle(edit.title) } : {}),
    ...(edit.nodes !== undefined ? { nodes: cleanMapNodes(edit.nodes) } : {}),
    ...(edit.sources !== undefined ? { sources: cleanSources(edit.sources) } : {}),
  };
  const ok = isUuid(id) && (await updateMap(session.db, session.user.id, id, patch));
  if (!ok) throw new VaultError(NOT_FOUND, 404);
}

export async function removeMap(session: Session, id: string): Promise<void> {
  if (!isUuid(id)) throw new VaultError(NOT_FOUND, 404);
  await deleteMap(session.db, session.user.id, id);
}

const usable = (item: Item): item is Item & { understanding: NonNullable<Item["understanding"]> } => item.status === "ready" && item.understanding !== null;

/** 这次对话给模型看的材料：挂着的（最近挂上的 ATTACHED_MAX 条）+ 按这句话从收藏库里找到的。没带上、没找成的记进 notes。 */
async function gatherMaterials(session: Session, map: VaultMap, query: string, foundMax: number): Promise<{ materials: Material[]; notes: string[]; alive: string[] }> {
  const { user, db } = session;
  const notes: string[] = [];
  const attachedAll = await getItemsInOrder(db, user.id, map.sources, true);
  const alive = attachedAll.map((i) => i.id);
  const ready = attachedAll.filter(usable);
  if (ready.length < attachedAll.length) notes.push(`这张图挂着的收藏里有 ${attachedAll.length - ready.length} 条还没处理好（或处理失败），这次没带上`);
  const attached = ready.slice(-ATTACHED_MAX);
  if (ready.length > attached.length) notes.push(`这张图挂了 ${ready.length} 条收藏，这次只带了最近挂上的 ${attached.length} 条`);

  let found: Item[] = [];
  try {
    const result = await searchItems(db, user.id, { q: query.slice(0, 300), limit: foundMax + alive.length });
    const ids = result.hits.map((h) => h.item.id).filter((id) => !alive.includes(id));
    found = (await getItemsInOrder(db, user.id, ids, true)).filter(usable).slice(0, foundMax);
    if (!result.semantic) notes.push("语义搜索这次不可用（没配 VOYAGE_API_KEY 或接口出错），只按字面从收藏库里找了相关内容，意思相近但用词不同的可能没找到");
  } catch (e) {
    console.error(`导图对话：搜索收藏库出错 map=${map.id}: ${e instanceof Error ? e.message : String(e)}`);
    notes.push("这次没能去收藏库里找相关的内容（搜索出错），只用了这张图已经挂着的");
  }
  const materials = [...attached.map((item) => ({ item, attached: true })), ...found.map((item) => ({ item, attached: false }))].map(
    ({ item, attached: isAttached }, i): Material => ({ label: `S${i + 1}`, id: item.id, title: displayTitle(item), origin: origin(item), attached: isAttached, understanding: item.understanding! })
  );
  return { materials, notes, alive };
}

function addCounts(into: Record<string, number>, counts: Record<string, number>): Record<string, number> {
  const out = { ...into };
  for (const [k, n] of Object.entries(counts)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** draft = 起草：只按标题去收藏库里找（那句话是替用户说的套话，拿去搜没有意义），多找一些 */
type Turn = { message: string; draft: boolean; title?: unknown; nodes?: unknown };

async function runTurn(session: Session, id: string, turn: Turn): Promise<MapDetail> {
  const { user, db } = session;
  const had = isUuid(id) ? await getMap(db, user.id, id) : null;
  if (!had) throw new VaultError(NOT_FOUND, 404);
  // 编辑器里还没存上的改动跟着这次请求一起来：先存下，模型看到的是最新的图；模型那边失败了这些改动也不丢
  const map: VaultMap = { ...had, ...(turn.title !== undefined ? { title: cleanMapTitle(turn.title) } : {}), ...(turn.nodes !== undefined ? { nodes: cleanMapNodes(turn.nodes) } : {}) };
  if (turn.title !== undefined || turn.nodes !== undefined) await updateMap(db, user.id, id, { title: map.title, nodes: map.nodes });

  if (turn.draft && !map.title) throw new VaultError("先给这张图起个标题（主题），才知道去收藏库里找什么");
  const { materials, notes, alive } = await gatherMaterials(session, map, turn.draft ? map.title : `${map.title} ${turn.message}`.trim(), turn.draft ? DRAFT_FOUND_MAX : FOUND_MAX);
  const prompt = buildMapChatPrompt({ title: map.title, nodes: map.nodes, materials, history: map.chat, message: turn.message, notes });
  const counts: Record<string, number> = {};
  const saveUsage = async () => {
    if (Object.keys(counts).length === 0) return map.usage;
    const usage = addCounts(map.usage, counts);
    await updateMap(db, user.id, id, { usage, costUsd: estimateUsd(usage) });
    return usage;
  };
  let result;
  try {
    result = await meterInto(counts, () => askClaude({ system: MAP_CHAT_SYSTEM, prompt, maxTokens: 16_000 }));
  } catch (e) {
    // askClaude 自己抛的错都是给用户看的话（限流、密钥不对、拒答）；别的（网络断了…）往上抛
    if (e instanceof ClaudeNotConfiguredError) throw new VaultError("没配 ANTHROPIC_API_KEY，没法跟 AI 对话");
    if (e instanceof Error && /Claude|ANTHROPIC|模型拒绝/.test(e.message)) throw new VaultError(e.message.replace("处理这条内容", "回答"), 502);
    throw e;
  }
  if (result.truncated) {
    await saveUsage();
    throw new VaultError("这次的回答太长，被截断了，图没有改。换一个小一点的要求再试（比如只改一个分支）", 502);
  }
  const itemOf = new Map(materials.map((m) => [m.label, m.id]));
  const parsed = parseMapChatReply(result.text, map.title, (label) => itemOf.get(label) ?? null);
  if (!parsed.reply && !parsed.nodes) {
    await saveUsage();
    throw new VaultError("AI 这次没有给出能用的回答，再试一次", 502);
  }
  const changed = parsed.nodes !== null && !sameNodes(parsed.nodes, map.nodes);
  const nodes = changed ? parsed.nodes! : map.nodes;
  // 图里用到的、这次才从收藏库里找到的内容，挂到这张图上（下次对话还带着）；已经删掉的内容从挂着的里去掉
  const used = new Set(nodes.flatMap((n) => (n.item ? [n.item] : [])));
  const sources = cleanSources([...alive, ...materials.filter((m) => !m.attached && used.has(m.id)).map((m) => m.id)]);
  const now = new Date().toISOString();
  const reply: ChatMessage = { role: "assistant", text: parsed.reply || "改好了。", at: now, changed, notes, ...(changed ? { before: map.nodes } : {}) };
  // 只有最近一次改图能撤销：这次改了，之前那条带着的「改之前的图」就不留了
  const earlier = changed ? map.chat.map((m) => (m.role === "assistant" && m.before ? { ...m, before: undefined } : m)) : map.chat;
  const chat = [...earlier, { role: "user" as const, text: turn.message, at: now }, reply].slice(-CHAT_KEEP);
  const usage = addCounts(map.usage, counts);
  await updateMap(db, user.id, id, { nodes, sources, chat, usage, costUsd: estimateUsd(usage) });
  return getMapDetail(session, id);
}

/**
 * 跟 AI 说一句话。它可能改图（改之前的图留在这条回复上，能撤销），也可能只回答。
 * title / nodes：编辑器里当前的样子（还没来得及自动保存的改动），给了就先存下再问。
 */
export async function chatOnMap(session: Session, id: string, input: { message: string; title?: unknown; nodes?: unknown }): Promise<MapDetail> {
  const message = input.message.trim();
  if (!message) throw new VaultError("说点什么：想怎么改这张图，或者问一个问题");
  if (message.length > MESSAGE_MAX) throw new VaultError(`这句话太长了（最多 ${MESSAGE_MAX.toLocaleString("en-US")} 字）`);
  return runTurn(session, id, { message, draft: false, title: input.title, nodes: input.nodes });
}

/** 让 AI 从收藏库里起草：按标题去找相关的收藏（比平时多找一些），照着起一张图。要先有标题。 */
export async function draftMap(session: Session, id: string, input: { title?: unknown; nodes?: unknown } = {}): Promise<MapDetail> {
  return runTurn(session, id, { message: DRAFT_MESSAGE, draft: true, title: input.title, nodes: input.nodes });
}

/** 撤销 AI 最近一次改的图：换回改之前的样子（那之后自己手动改的也一起回去）。没有能撤销的抛 409。 */
export async function undoMapChange(session: Session, id: string): Promise<MapDetail> {
  const { user, db } = session;
  const map = isUuid(id) ? await getMap(db, user.id, id) : null;
  if (!map) throw new VaultError(NOT_FOUND, 404);
  const index = map.chat.findLastIndex((m) => m.role === "assistant" && m.before !== undefined);
  const target = map.chat[index];
  if (!target || target.role !== "assistant" || !target.before) throw new VaultError("没有能撤销的修改", 409);
  const chat = map.chat.map((m, i) => (i === index ? { ...target, before: undefined, undone: true } : m));
  await updateMap(db, user.id, id, { nodes: target.before, chat });
  return getMapDetail(session, id);
}
