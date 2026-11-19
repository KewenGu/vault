"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { removeItem, reprocess, saveInput, savePage, VaultError } from "@/lib/vault/service";
import { updateItemMeta } from "@/lib/vault/store";
import { parseTagInput } from "@/lib/vault/taxonomy";

/** 表单动作的结果：出错时带一句给用户看的话（页面用 useActionState 显示）。成功的直接跳转 / 刷新。 */
export type ActionState = { error: string | null };

const fail = (e: unknown): ActionState => {
  if (e instanceof VaultError) return { error: e.message };
  console.error("操作出错:", e);
  return { error: "出错了，请稍后重试" };
};

/** 存一条粘贴的内容（链接 / 文字）。存好后留在当前页（列表刷新，新的一条显示在最前面）。 */
export async function saveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let saved;
  try {
    saved = await saveInput(session, String(formData.get("input") ?? ""), String(formData.get("note") ?? ""));
  } catch (e) {
    return fail(e);
  }
  // 存过的：直接带他去看那条
  if (saved.existing || formData.get("then") === "open") redirect(`/items/${saved.id}`);
  revalidatePath("/");
  return { error: null };
}

/** 存一个在手机的 Safari 里读到的网页（确认页 /share#page=… 提交过来，page 是 JSON）。存好后去看那条。 */
export async function savePageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let saved;
  try {
    let page: unknown = null;
    try {
      page = JSON.parse(String(formData.get("page") ?? ""));
    } catch {
      // 下面按「没收到」报
    }
    saved = await savePage(session, page, String(formData.get("note") ?? ""));
  } catch (e) {
    return fail(e);
  }
  redirect(`/items/${saved.id}`);
}

export async function reprocessAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  try {
    await reprocess(session, id, formData.get("from") === "fetch" ? "fetch" : "analyze", { userText: String(formData.get("text") ?? "") || undefined });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/items/${id}`);
  return { error: null };
}

export async function updateMetaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, db } = await requireSession();
  const id = String(formData.get("id") ?? "");
  try {
    await updateItemMeta(db, user.id, id, { note: String(formData.get("note") ?? ""), tags: parseTagInput(String(formData.get("tags") ?? "")) });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存失败" };
  }
  revalidatePath(`/items/${id}`);
  return { error: null };
}

export async function deleteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await removeItem(session, String(formData.get("id") ?? ""));
  } catch (e) {
    return fail(e);
  }
  redirect("/");
}
