"use server";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { addNote, editNote, removeNote, type NoteSaved } from "@/lib/vault/note-service";

/**
 * 划线和批注的动作（详情页上的那一块直接调）。逻辑都在 lib/vault/note-service.ts，接口 /api/v1/…/notes 调的是同一套。
 * 返回这条内容现在所有的笔记，或者一句给用户看的错。
 */

export type NoteResult = { error: string } | { saved: NoteSaved };

const run = async (work: () => Promise<NoteSaved>): Promise<NoteResult> => {
  try {
    const saved = await work();
    revalidatePath("/notes");
    return { saved };
  } catch (e) {
    if (e instanceof VaultError) return { error: e.message };
    console.error("笔记操作出错:", e);
    return { error: "出错了，请稍后重试" };
  }
};

export async function addNoteAction(itemId: string, input: { quote?: string; body?: string; at?: number | null }): Promise<NoteResult> {
  const session = await requireSession();
  return run(() => addNote(session, itemId, input));
}

export async function editNoteAction(noteId: string, body: string): Promise<NoteResult> {
  const session = await requireSession();
  return run(() => editNote(session, noteId, { body }));
}

export async function removeNoteAction(noteId: string): Promise<NoteResult> {
  const session = await requireSession();
  return run(() => removeNote(session, noteId));
}
