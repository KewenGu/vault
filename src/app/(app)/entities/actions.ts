"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { mergeEntity, moveItems, removeAlias, renameEntity } from "@/lib/vault/entity-service";
import { VaultError } from "@/lib/vault/errors";
import type { ActionState } from "../actions";

/** 实体页上的几个动作：逻辑都在 lib/vault/entity-service.ts，这里只是接表单。 */

const fail = (e: unknown): ActionState => {
  if (e instanceof VaultError) return { error: e.message };
  console.error("实体页操作出错:", e);
  return { error: "出错了，请稍后重试" };
};
const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

export async function renameEntityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const id = field(formData, "id");
  try {
    await renameEntity(session, id, { name: field(formData, "name"), summary: field(formData, "summary") });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/entities/${id}`);
  return { error: null };
}

export async function removeAliasAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const id = field(formData, "id");
  try {
    await removeAlias(session, id, field(formData, "alias"));
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/entities/${id}`);
  return { error: null };
}

/** 并进另一个：并完这个实体就没了，带他去并进去的那一页。 */
export async function mergeEntityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let target;
  try {
    target = await mergeEntity(session, field(formData, "id"), field(formData, "into"));
  } catch (e) {
    return fail(e);
  }
  redirect(`/entities/${target.id}`);
}

/** 把勾上的内容移到另一个实体。这个实体上一条都不剩时它也没了，带他去移到的那一页；不然留在这一页。 */
export async function moveItemsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const id = field(formData, "id");
  let moved;
  try {
    moved = await moveItems(session, id, formData.getAll("items").map(String), field(formData, "to"));
  } catch (e) {
    return fail(e);
  }
  if (moved.emptied) redirect(`/entities/${moved.id}`);
  revalidatePath(`/entities/${id}`);
  return { error: null };
}
