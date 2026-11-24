"use server";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { addWatch, checkAllWatches, checkWatch, editWatch, markSignal, removeWatch, saveSignal } from "@/lib/vault/intel-service";
import type { ActionState } from "../actions";

/**
 * 情报页的动作：都是表单提交，返回 ActionState（出错时一句给用户看的话），做完刷新这一页。
 * 逻辑在 lib/vault/intel-service.ts，接口 /api/v1/intel 调的是同一套。
 */

const fail = (e: unknown): ActionState => {
  if (e instanceof VaultError) return { error: e.message };
  console.error("情报操作出错:", e);
  return { error: "出错了，请稍后重试" };
};

const done = (): ActionState => {
  revalidatePath("/intel");
  return { error: null };
};

const id = (formData: FormData) => String(formData.get("id") ?? "");

/** 加一个来源，加完马上去看一次。来源读不到不算这一步出错：原因显示在那个来源下面。 */
export async function addWatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await addWatch(session, { kind: formData.get("kind"), query: formData.get("query"), minScore: formData.get("minScore") ?? undefined, keywords: formData.get("keywords") ?? undefined });
  } catch (e) {
    return fail(e);
  }
  return done();
}

export async function editWatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    const enabled = formData.get("enabled");
    await editWatch(session, id(formData), {
      ...(enabled !== null ? { enabled: enabled === "true" } : {}),
      ...(formData.has("minScore") ? { minScore: formData.get("minScore") } : {}),
      ...(formData.has("keywords") ? { keywords: formData.get("keywords") } : {}),
    });
  } catch (e) {
    return fail(e);
  }
  return done();
}

export async function removeWatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await removeWatch(session, id(formData));
  } catch (e) {
    return fail(e);
  }
  return done();
}

export async function checkWatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await checkWatch(session, id(formData));
  } catch (e) {
    return fail(e);
  }
  return done();
}

export async function checkAllAction(): Promise<ActionState> {
  const session = await requireSession();
  try {
    await checkAllWatches(session);
  } catch (e) {
    return fail(e);
  }
  return done();
}

/** 存进收藏库：留在这一页（那一条挪到「存了的」里），后台照常读取和理解。 */
export async function saveSignalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await saveSignal(session, id(formData));
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/");
  return done();
}

export async function markSignalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await markSignal(session, id(formData), formData.get("status"));
  } catch (e) {
    return fail(e);
  }
  return done();
}
