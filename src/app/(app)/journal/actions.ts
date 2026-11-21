"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { beginMediaUpload, createEntryFor, finishMediaUpload, listEntryMedia, removeEntry, removeMedia, retryMedia, saveEntry, type EntryEdit, type MediaTicket, type MediaView } from "@/lib/vault/journal-service";
import type { ActionState } from "../actions";

/**
 * 日记页的动作。表单提交的（新建、删除）和别的页一样返回 ActionState；编辑器里直接调的（保存、传文件、看转写结果）
 * 返回数据或一句给用户看的错——逻辑都在 lib/vault/journal-service.ts，接口 /api/v1/journal 调的是同一套。
 */

const message = (e: unknown): string => {
  if (e instanceof VaultError) return e.message;
  console.error("日记操作出错:", e);
  return "出错了，请稍后重试";
};

/** 编辑器里直接调的动作：成功是数据本身，失败是 `{ error }`（用 `"error" in res` 分） */
export type Result<T> = { error: string } | T;

async function attempt<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return await run();
  } catch (e) {
    return { error: message(e) };
  }
}

/** 开一篇新的。day 是浏览器算的当地日期（藏在表单里）。 */
export async function createEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let id;
  try {
    id = await createEntryFor(session, { day: String(formData.get("day") ?? "") });
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/journal/${id}`);
}

export async function deleteEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await removeEntry(session, String(formData.get("id") ?? ""));
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath("/journal");
  redirect("/journal");
}

/** 编辑器的自动保存。conflict = 这篇在别处改过了（没有盖掉）。 */
export async function saveEntryAction(id: string, edit: EntryEdit): Promise<{ rev: number } | { error: string; conflict: boolean }> {
  const session = await requireSession();
  try {
    return await saveEntry(session, id, edit);
  } catch (e) {
    return { error: message(e), conflict: e instanceof VaultError && e.status === 409 };
  }
}

export async function beginMediaAction(entryId: string, file: { name: string; mime: string; size: number }): Promise<Result<MediaTicket>> {
  const session = await requireSession();
  return attempt(() => beginMediaUpload(session, entryId, file));
}

export async function finishMediaAction(mediaId: string): Promise<Result<{ media: MediaView }>> {
  const session = await requireSession();
  return attempt(async () => ({ media: await finishMediaUpload(session, mediaId) }));
}

export async function retryMediaAction(mediaId: string): Promise<Result<{ media: MediaView }>> {
  const session = await requireSession();
  return attempt(async () => ({ media: await retryMedia(session, mediaId) }));
}

export async function removeMediaAction(mediaId: string): Promise<{ error: string | null }> {
  const session = await requireSession();
  try {
    await removeMedia(session, mediaId);
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

/** 这篇日记里的文件现在的样子（录音在转文字时页面隔几秒来问一次）。 */
export async function entryMediaAction(entryId: string): Promise<Result<{ media: MediaView[] }>> {
  const session = await requireSession();
  return attempt(async () => ({ media: await listEntryMedia(session, entryId) }));
}
