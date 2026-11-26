import "server-only";
import { start } from "workflow/api";
import type { Session } from "@/lib/auth/user";
import { LinkError, extractShareUrl, resolveTarget, type AccountPlatform, type AccountRef } from "@/lib/sources/link";
import { collectCreator, saveCreatorPosts } from "@/workflows/collect-creator";
import { VaultError } from "./errors";
import {
  CREATOR_MAX_POSTS,
  beginRound,
  countPosts,
  creatorBusy,
  deleteCreator,
  findCreator,
  getCreator,
  insertCreator,
  listCreators,
  listPosts,
  movePosts,
  patchRound,
  stopRound,
  type Creator,
  type CreatorPost,
  type PostCounts,
} from "./creator-store";
import { getItemsInOrder, type Item } from "./store";

/**
 * 博主：把一个账号（X / TikTok / 抖音 / 小红书 / Instagram / YouTube / B 站 / 微博）发过的作品整个存下来。页面的 server action 和 /api/v1/creators 的接口都调这里。
 *
 * 一个博主的每一条作品，存进来就是收藏库里普通的一条内容（搜索、图谱、导图照常），和单独贴那条链接存进来的是同一条。
 * 这里管的是「哪个账号、要最近的多少条、列出了哪些、存到哪了」：
 *
 * - 加一个博主（addCreator）：贴他主页的链接，说要最近的多少条。后台先列作品、再一条条存（workflows/collect-creator.ts）。
 *   每条都要花读取和理解的钱，所以页面上先让用户选条数、看估的花费，确认了才开始。
 * - 再同步（syncCreator）：重新列最近的 N 条，清单里没有的排队存。「看看有没有新发的」和「再往回多存一些」都是它，N 不一样。
 * - 停（stopCreator）：正在处理的那一两条会处理完；还排着队的搁下（清单上标成「没存」），以后可以接着存（resumeCreator）。
 * - 移除（removeCreator）：只删这个博主和他的作品清单，已经存进收藏库的内容留着。
 *
 * 能直接告诉用户的问题抛 VaultError（message 给用户看）。
 */

export { VaultError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const NOT_AN_ACCOUNT = "没认出这是哪个账号的主页。能整个存的是 X、TikTok、抖音、小红书、Instagram、YouTube、B 站、微博的账号：打开他的主页，点「分享 → 复制链接」，把复制到的内容贴进来（x.com/用户名、tiktok.com/@用户名、douyin.com/user/…、xiaohongshu.com/user/profile/…、instagram.com/用户名、youtube.com/@频道名、space.bilibili.com/数字、weibo.com/u/数字）";

/** 贴进来的内容（链接，或者 App 分享出来的那段话）是哪个账号的主页。认不出、或者是一条帖子的链接，抛 VaultError。 */
export async function resolveAccount(input: string): Promise<AccountRef> {
  const url = extractShareUrl(input.trim());
  if (!url) throw new VaultError(NOT_AN_ACCOUNT);
  let target;
  try {
    target = await resolveTarget(url);
  } catch (e) {
    if (e instanceof LinkError) throw new VaultError(NOT_AN_ACCOUNT);
    throw e;
  }
  if (target.kind !== "account") throw new VaultError("这是一条帖子的链接，不是账号的主页：要存这一条，在收藏库的存入框里贴它；要存这个博主的全部作品，贴他主页的链接");
  return target.ref;
}

/** 要存多少条：1 到 CREATOR_MAX_POSTS 之间的整数，不是就报错。 */
export function cleanWant(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new VaultError("要存多少条：填一个 1 以上的整数");
  if (n > CREATOR_MAX_POSTS) throw new VaultError(`一次最多列 ${CREATOR_MAX_POSTS} 条：先存这么多，存完再往回加`);
  return n;
}

export type CostHint = { avgUsd: number; n: number };

/** 这个人在这个平台上已经存过的内容平均一条花了多少（最近 50 条处理好的），给「存 N 条大概多少钱」当参考。没存过返回 null。 */
export async function costHint(session: Session, platform: AccountPlatform): Promise<CostHint | null> {
  let query = session.db.from("items").select("cost_usd").eq("user_id", session.user.id).eq("status", "ready");
  // B 站的视频是按网页存的：只看 B 站视频页的那些，别的网页（文章）便宜得多，不能拿来估
  query = platform === "bilibili" ? query.eq("platform", "web").like("url", "https://www.bilibili.com/video/%") : query.eq("platform", platform);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(`读取收藏库失败: ${error.message}`);
  const costs = (data ?? []).map((r) => Number(r.cost_usd) || 0).filter((c) => c > 0);
  return costs.length > 0 ? { avgUsd: costs.reduce((a, b) => a + b, 0) / costs.length, n: costs.length } : null;
}

/** 后台任务起不来（Workflow 运行时没连上）：标成失败并带上原因，不让它挂在「正在列」。 */
async function startRound(session: Session, creator: Creator, startedAt: string, what: "list" | "save"): Promise<void> {
  try {
    await start(what === "list" ? collectCreator : saveCreatorPosts, [creator.id, session.user.id, startedAt]);
  } catch (e) {
    console.error(`博主的后台任务没启动 creator=${creator.id}: ${messageOf(e)}`);
    await patchRound(session.db, session.user.id, creator, startedAt, { status: "failed", error: `后台任务没启动：${messageOf(e).slice(0, 300)}` });
  }
}

async function mustGet(session: Session, id: string): Promise<Creator> {
  const creator = UUID.test(id) ? await getCreator(session.db, session.user.id, id) : null;
  if (!creator) throw new VaultError("这个博主不在了", 404);
  return creator;
}

export type SavedCreator = { id: string; existing: boolean };

/**
 * 加一个博主，开始存他最近的 want 条作品。已经加过的：没在跑就按这次的条数再同步一遍，正在跑就不动；都回到那一个（existing: true）。
 */
export async function addCreator(session: Session, input: string, rawWant: unknown): Promise<SavedCreator> {
  const want = cleanWant(rawWant);
  const ref = await resolveAccount(input);
  const { user, db } = session;
  let had = await findCreator(db, user.id, ref);
  if (!had) {
    const created = await insertCreator(db, user.id, ref, want);
    if (created) {
      await startRound(session, created, created.startedAt, "list");
      return { id: created.id, existing: false };
    }
    // 两次提交撞在一起：唯一索引拦下后面那次，回到先建好的那个
    had = await findCreator(db, user.id, ref);
    if (!had) throw new Error("保存博主失败: 刚建的那一行读不到");
  }
  if (!creatorBusy(had)) await syncCreator(session, had.id, want);
  return { id: had.id, existing: true };
}

/** 重新列最近的 want 条，清单里没有的排队存。 */
export async function syncCreator(session: Session, id: string, rawWant: unknown): Promise<void> {
  const want = cleanWant(rawWant);
  const creator = await mustGet(session, id);
  if (creatorBusy(creator)) throw new VaultError("正在存，等它结束（或者先停下）再试", 409);
  const startedAt = await beginRound(session.db, session.user.id, id, "listing", want);
  if (!startedAt) throw new VaultError("这个博主不在了", 404);
  await startRound(session, { ...creator, notes: [] }, startedAt, "list");
}

/** 接着存：上次停下搁着的、中断时还排着队的，不重新列作品。 */
export async function resumeCreator(session: Session, id: string): Promise<void> {
  const { user, db } = session;
  const creator = await mustGet(session, id);
  if (creatorBusy(creator)) throw new VaultError("正在存，不用再点", 409);
  await movePosts(db, user.id, id, "held", "pending");
  const counts = await countPosts(db, user.id, id);
  if (counts.pending === 0) throw new VaultError("清单里没有还没存的作品。要找新发的、或者往回多存一些，用「再同步」");
  const startedAt = await beginRound(db, user.id, id, "saving");
  if (!startedAt) throw new VaultError("这个博主不在了", 404);
  await startRound(session, creator, startedAt, "save");
}

/** 停：还排着队的搁下。正在处理的那一两条会处理完。 */
export async function stopCreator(session: Session, id: string): Promise<void> {
  const { user, db } = session;
  await mustGet(session, id);
  await stopRound(db, user.id, id);
  await movePosts(db, user.id, id, "pending", "held");
}

/** 移除这个博主和他的作品清单；已经存进收藏库的内容留着。 */
export async function removeCreator(session: Session, id: string): Promise<void> {
  if (!UUID.test(id) || !(await deleteCreator(session.db, session.user.id, id))) throw new VaultError("这个博主不在了", 404);
}

export type CreatorSummary = Creator & { counts: PostCounts };

export async function listMyCreators(session: Session): Promise<CreatorSummary[]> {
  const { user, db } = session;
  const creators = await listCreators(db, user.id);
  return Promise.all(creators.map(async (c) => ({ ...c, counts: await countPosts(db, user.id, c.id) })));
}

export const CREATOR_PAGE_SIZE = 60;

export type CreatorDetail = {
  creator: Creator;
  counts: PostCounts;
  /** 整份清单（从新到旧） */
  posts: CreatorPost[];
  /** 这一页的内容（已存的里面，从新到旧的第 page 页） */
  items: Item[];
  page: number;
  pages: number;
  /** 存过、后来从收藏库里删掉了的有几条 */
  removed: number;
};

/** 一个博主的页面要的全部：账号、清单、已经存下来的内容（分页）。 */
export async function getCreatorDetail(session: Session, id: string, rawPage = 1): Promise<CreatorDetail> {
  const { user, db } = session;
  const creator = await mustGet(session, id);
  const [counts, posts] = await Promise.all([countPosts(db, user.id, id), listPosts(db, user.id, id)]);
  const savedIds = posts.flatMap((p) => (p.status === "saved" && p.itemId ? [p.itemId] : []));
  const pages = Math.max(1, Math.ceil(savedIds.length / CREATOR_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(rawPage) || 1), pages);
  const items = await getItemsInOrder(db, user.id, savedIds.slice((page - 1) * CREATOR_PAGE_SIZE, page * CREATOR_PAGE_SIZE));
  return { creator, counts, posts, items, page, pages, removed: posts.filter((p) => p.status === "saved" && !p.itemId).length };
}
