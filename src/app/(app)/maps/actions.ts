"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { chatOnMap, createMapFor, draftMap, removeMap, saveMap, undoMapChange, type MapDetail, type MapEdit } from "@/lib/vault/map-service";
import type { ActionState } from "../actions";

/**
 * 导图页的动作。表单提交的（新建、删除）和别的页一样返回 ActionState；编辑器里直接调的（保存、对话、撤销）
 * 返回数据或一句给用户看的错——逻辑都在 lib/vault/map-service.ts，接口 /api/v1/maps 调的是同一套。
 */

const message = (e: unknown): string => {
  if (e instanceof VaultError) return e.message;
  console.error("导图操作出错:", e);
  return "出错了，请稍后重试";
};

/** 新建一张图。mode = draft：建好后进去就让 AI 从收藏库里起草（要标题）；blank：空白开始。 */
export async function createMapAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const title = String(formData.get("title") ?? "");
  const draft = formData.get("mode") === "draft";
  if (draft && !title.trim()) return { error: "让 AI 起草要先写一个主题：它按这个主题去你的收藏库里找内容" };
  let id;
  try {
    id = await createMapFor(session, { title });
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/maps/${id}${draft ? "?draft=1" : ""}`);
}

/** 从收藏库里的一条内容新建一张图（抄它的大纲当起点）。 */
export async function createMapFromItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let id;
  try {
    id = await createMapFor(session, { itemId: String(formData.get("itemId") ?? "") });
  } catch (e) {
    return { error: message(e) };
  }
  redirect(`/maps/${id}`);
}

export async function deleteMapAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await removeMap(session, String(formData.get("id") ?? ""));
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath("/maps");
  redirect("/maps");
}

/** 编辑器的自动保存。 */
export async function saveMapAction(id: string, edit: MapEdit): Promise<{ error: string | null }> {
  const session = await requireSession();
  try {
    await saveMap(session, id, edit);
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

export type MapTurnResult = { error: string } | { detail: MapDetail };

const turn = async (run: () => Promise<MapDetail>): Promise<MapTurnResult> => {
  try {
    return { detail: await run() };
  } catch (e) {
    return { error: message(e) };
  }
};

/** 跟 AI 说一句话（edit 是编辑器里当前的标题和节点，先存下再问）。 */
export async function chatMapAction(id: string, text: string, edit: Pick<MapEdit, "title" | "nodes">): Promise<MapTurnResult> {
  const session = await requireSession();
  return turn(() => chatOnMap(session, id, { message: text, ...edit }));
}

/** 让 AI 按标题从收藏库里起草。 */
export async function draftMapAction(id: string, edit: Pick<MapEdit, "title" | "nodes">): Promise<MapTurnResult> {
  const session = await requireSession();
  return turn(() => draftMap(session, id, edit));
}

/** 撤销 AI 最近一次改的图。 */
export async function undoMapAction(id: string): Promise<MapTurnResult> {
  const session = await requireSession();
  return turn(() => undoMapChange(session, id));
}
