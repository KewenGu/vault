"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession, type Session } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { addCreator, removeCreator, resolveAccount, resumeCreator, stopCreator, syncCreator } from "@/lib/vault/creator-service";
import type { ActionState } from "../actions";

/** 「博主」页的动作：逻辑都在 lib/vault/creator-service.ts，接口 /api/v1/creators 调的是同一套。 */

const fail = (e: unknown): ActionState => {
  if (e instanceof VaultError) return { error: e.message };
  console.error("博主操作出错:", e);
  return { error: "出错了，请稍后重试" };
};

/** 贴了一个主页的链接：认出是哪个账号，去确认页（选存多少条）。 */
export async function findCreatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  let ref;
  try {
    ref = await resolveAccount(String(formData.get("input") ?? ""));
  } catch (e) {
    return fail(e);
  }
  redirect(`/creators/new?url=${encodeURIComponent(ref.url)}`);
}

/** 确认了：加上这个博主，开始存。 */
export async function addCreatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let saved;
  try {
    saved = await addCreator(session, String(formData.get("url") ?? ""), String(formData.get("want") ?? ""));
  } catch (e) {
    return fail(e);
  }
  redirect(`/creators/${saved.id}`);
}

/** 对一个博主做一件事，做完刷新他的页面。 */
async function onCreator(formData: FormData, run: (session: Session, id: string) => Promise<void>): Promise<ActionState> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  try {
    await run(session, id);
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/creators/${id}`);
  return { error: null };
}

export async function syncCreatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return onCreator(formData, (session, id) => syncCreator(session, id, String(formData.get("want") ?? "")));
}

export async function resumeCreatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return onCreator(formData, resumeCreator);
}

export async function stopCreatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return onCreator(formData, stopCreator);
}

export async function removeCreatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await removeCreator(session, String(formData.get("id") ?? ""));
  } catch (e) {
    return fail(e);
  }
  redirect("/creators");
}
