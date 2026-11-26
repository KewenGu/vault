"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { askVault, removeAsk, type AskDetail } from "@/lib/vault/ask-service";
import { VaultError } from "@/lib/vault/errors";
import type { ActionState } from "../actions";

/**
 * 「问」页的动作。逻辑都在 lib/vault/ask-service.ts，接口 /api/v1/asks 调的是同一套。
 * 表单提交的（新问一个、删除）和别的页一样返回 ActionState；对话页里直接调的（追问）返回数据或一句给用户看的错。
 */

const message = (e: unknown): string => {
  if (e instanceof VaultError) return e.message;
  console.error("问 Vault 出错:", e);
  return "出错了，请稍后重试";
};

/** 新问一个问题：等模型答完，去看那次提问。 */
export async function askAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let detail;
  try {
    detail = await askVault(session, { question: String(formData.get("question") ?? "") });
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath("/ask");
  redirect(`/ask/${detail.ask.id}`);
}

export type AskTurnResult = { error: string } | { detail: AskDetail };

/** 在一次提问里接着追问。 */
export async function followUpAction(id: string, question: string): Promise<AskTurnResult> {
  const session = await requireSession();
  try {
    return { detail: await askVault(session, { id, question }) };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function deleteAskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  try {
    await removeAsk(session, String(formData.get("id") ?? ""));
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath("/ask");
  redirect("/ask");
}
