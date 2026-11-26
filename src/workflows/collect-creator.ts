import { sleep } from "workflow";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase/service";
import { listAccountStep, type ListState } from "@/lib/sources/account-list";
import { SourceFetchError, readPost } from "@/lib/sources/types";
import { meterInto } from "@/lib/usage/meter";
import { accountRefOf, addPosts, creatorParallel, getCreator, itemRefOf, markSaved, movePost, nextPending, patchRound, type Creator } from "@/lib/vault/creator-store";
import { createItem, getItem, linkDedupeKey, restartItem } from "@/lib/vault/store";
import { processItem } from "./process-item";

/**
 * 存一个博主的作品的后台任务。两段：
 *
 *   ① 列作品（collectCreator）：按平台把他最近的 N 条列出来（lib/sources/account-list.ts），记进 creator_posts，新的排队等存。
 *      要翻很多页 / 等 Apify 的 actor 跑完，所以一步一步来，两步之间 sleep。
 *   ② 一条条存（saveCreatorPosts）：从排着队的里面每次拿几条（默认 2 条，VAULT_CREATOR_PARALLEL 调），每条建成收藏库里
 *      普通的一条内容，走和单独贴链接一样的处理（workflows/process-item.ts：读取、看和听、理解、建索引），处理完再拿下一批。
 *      一条读不到、理解失败是那条内容自己的状态（它的页面上能重试），不影响后面的。
 *
 * - 每一步开头都看这个博主还是不是「这一轮在跑」（状态对、开始时间对得上）：用户点了停、或者又开始了新的一轮，就不往下做。
 *   停的时候正在处理的那一两条会处理完（已经在花钱了，停不下来）。
 * - 几百条作品不放在一次运行里：每存 ROUNDS_PER_RUN 批就另起一次运行接着存（saveCreatorPosts 自己接自己），
 *   一次运行的记录不会越攒越长。
 * - 建内容时用作品清单那一行的 id 当内容的 id：这一步做到一半断了重来，认得出那条内容是自己刚建的（要接着处理），
 *   还是用户以前单独存过的同一条（不动它，只把清单指过去）。
 * - 列作品失败（账号不存在、私密、没配令牌、平台读不动）把原因写回博主那一行（status=failed），不自动重试。
 */

type Counts = Record<string, number>;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 列作品最多走这么多步（X 一步一页，Apify 一步问一次状态）：只防失控，正常到不了 */
const LIST_MAX_STEPS = 400;
/** 一次运行存多少批，之后另起一次运行 */
const ROUNDS_PER_RUN = 20;
/** 网络抖动这类错在一步里先自己重试几次，再不行才算这一轮失败 */
const LIST_TRIES = 3;

const mine = (creator: Creator | null, startedAt: string, status: "listing" | "saving"): creator is Creator =>
  !!creator && creator.status === status && Date.parse(creator.startedAt) === Date.parse(startedAt);

type ListStepResult = { stop: boolean; done: boolean; state: ListState | null; waitS: number };

async function listCreatorStep(creatorId: string, userId: string, startedAt: string, state: ListState | null): Promise<ListStepResult> {
  "use step";
  const db = getServiceClient();
  const creator = await getCreator(db, userId, creatorId);
  if (!mine(creator, startedAt, "listing")) return { stop: true, done: false, state: null, waitS: 0 };
  const counts: Counts = {};
  try {
    let step;
    for (let attempt = 1; ; attempt++) {
      try {
        step = await meterInto(counts, () => listAccountStep(accountRefOf(creator), creator.want, state));
        break;
      } catch (e) {
        if (e instanceof SourceFetchError || attempt >= LIST_TRIES) throw e;
        console.error(`列作品出错，再试 creator=${creatorId} 第 ${attempt} 次: ${messageOf(e)}`);
        await pause(3000 * attempt);
      }
    }
    if (step.posts.length > 0) await addPosts(db, userId, creatorId, step.posts);
    const ok = await patchRound(db, userId, creator, startedAt, {
      ...(step.info ? { info: step.info } : {}),
      counts,
      ...(step.done ? { notes: step.notes, status: "saving" as const, synced: true } : {}),
    });
    return { stop: !ok, done: step.done, state: step.state, waitS: step.waitS };
  } catch (e) {
    console.error(`列作品失败 creator=${creatorId}: ${messageOf(e)}`);
    await patchRound(db, userId, creator, startedAt, { status: "failed", error: messageOf(e).slice(0, 500), counts }).catch((err) => console.error(`标记列作品失败出错 creator=${creatorId}: ${messageOf(err)}`));
    return { stop: true, done: false, state: null, waitS: 0 };
  }
}

type Taken = { postId: string; itemId: string };
type TakeResult = { stop: boolean; taken: Taken[] };

/** 拿接下来要存的几条，各建成一条内容。返回的是要处理的（自己建的）；以前单独存过的同一条只把清单指过去。 */
async function takePostsStep(creatorId: string, userId: string, startedAt: string): Promise<TakeResult> {
  "use step";
  const db = getServiceClient();
  const creator = await getCreator(db, userId, creatorId);
  if (!mine(creator, startedAt, "saving")) return { stop: true, taken: [] };
  const posts = await nextPending(db, userId, creatorId, creatorParallel());
  if (posts.length === 0) {
    await patchRound(db, userId, creator, startedAt, { status: "ready" });
    return { stop: true, taken: [] };
  }
  const taken: Taken[] = [];
  for (const post of posts) {
    const ref = itemRefOf(creator.platform, post);
    if (!ref) {
      // 链接整理不出来：搁下，不卡住后面的
      await movePost(db, userId, post.id, "held");
      continue;
    }
    const saved = await createItem(db, userId, {
      id: post.id,
      source: "link",
      dedupeKey: linkDedupeKey(ref),
      status: "fetching",
      platform: ref.platform,
      externalId: ref.externalId,
      url: ref.url,
      ...(post.kind ? { kind: post.kind } : {}),
      ...(post.title ? { title: post.title } : {}),
      // X：一串帖子的后几条读第一条时并进来（清单里只有每一串的第一条）
      ...(creator.platform === "x" ? { post: readPost({ withThread: true }) } : {}),
    });
    if (saved.id !== post.id) {
      // 用户以前单独存过这一条：不重新处理
      await markSaved(db, userId, post.id, saved.id);
      continue;
    }
    if (saved.existing) {
      // 自己上一次建的（这一步重跑了，或者上一轮断在处理中）：处理好了的不重做，没处理完的重新来
      const had = await getItem(db, userId, saved.id);
      if (!had || had.status === "ready") {
        await markSaved(db, userId, post.id, saved.id);
        continue;
      }
      await restartItem(db, userId, saved.id, "fetch");
    }
    taken.push({ postId: post.id, itemId: saved.id });
  }
  // 碰一下这一行：页面按它判断这一轮还活着
  await patchRound(db, userId, creator, startedAt, {});
  return { stop: false, taken };
}

/** 这一批处理完了：清单上标成已存（哪怕中途用户点了停——内容已经在收藏库里了）。 */
async function donePostsStep(userId: string, taken: Taken[]): Promise<void> {
  "use step";
  const db = getServiceClient();
  for (const t of taken) await markSaved(db, userId, t.postId, t.itemId);
}

/** 另起一次运行接着存。起不来：把原因写回去，页面上能点「接着存」。 */
async function continueStep(creatorId: string, userId: string, startedAt: string): Promise<void> {
  "use step";
  try {
    await start(saveCreatorPosts, [creatorId, userId, startedAt]);
  } catch (e) {
    console.error(`接着存的后台任务没启动 creator=${creatorId}: ${messageOf(e)}`);
    const db = getServiceClient();
    const creator = await getCreator(db, userId, creatorId);
    if (mine(creator, startedAt, "saving")) await patchRound(db, userId, creator, startedAt, { status: "failed", error: `存到一半后台任务没接上：${messageOf(e).slice(0, 300)}` });
  }
}

/** 列作品走满了步数还没列完（正常到不了）：标成失败，不让它挂在「正在列」。 */
async function giveUpListingStep(creatorId: string, userId: string, startedAt: string): Promise<void> {
  "use step";
  const db = getServiceClient();
  const creator = await getCreator(db, userId, creatorId);
  if (mine(creator, startedAt, "listing")) await patchRound(db, userId, creator, startedAt, { status: "failed", error: "列作品花的步数太多，停下了。少列一些再试" });
}

/** ② 一条条存。 */
export async function saveCreatorPosts(creatorId: string, userId: string, startedAt: string) {
  "use workflow";
  for (let round = 0; round < ROUNDS_PER_RUN; round++) {
    const batch = await takePostsStep(creatorId, userId, startedAt);
    if (batch.stop) return;
    if (batch.taken.length === 0) continue;
    await Promise.all(batch.taken.map((t) => processItem(t.itemId)));
    await donePostsStep(userId, batch.taken);
  }
  await continueStep(creatorId, userId, startedAt);
}

/** ① 列作品，列完接着存。 */
export async function collectCreator(creatorId: string, userId: string, startedAt: string) {
  "use workflow";
  let state: ListState | null = null;
  for (let i = 0; i < LIST_MAX_STEPS; i++) {
    const step = await listCreatorStep(creatorId, userId, startedAt, state);
    if (step.stop) return;
    if (step.done) {
      await saveCreatorPosts(creatorId, userId, startedAt);
      return;
    }
    state = step.state;
    if (step.waitS > 0) await sleep(`${step.waitS}s`);
  }
  await giveUpListingStep(creatorId, userId, startedAt);
}
