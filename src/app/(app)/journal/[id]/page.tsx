import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { JournalEditor, type JournalApi } from "@/components/journal/journal-editor";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { getEntryDetail, type EntryDetail } from "@/lib/vault/journal-service";
import { beginMediaAction, beginStickerAction, deleteEntryAction, entryMediaAction, finishMediaAction, finishStickerAction, listStickersAction, removeMediaAction, removeStickerAction, retryMediaAction, saveEntryAction, tidyMediaAction } from "../actions";

type Props = { params: Promise<{ id: string }> };

/** 标题和页面各要一次：同一次请求里只读一遍 */
const load = cache(async (id: string): Promise<EntryDetail | null> => {
  const session = await requireSession();
  try {
    return await getEntryDetail(session, id);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return null;
    throw e;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const detail = await load((await params).id);
  return { title: detail ? detail.entry.title || `${detail.entry.day} 的日记` : "不在了" };
}

const api: JournalApi = {
  save: saveEntryAction,
  beginMedia: beginMediaAction,
  finishMedia: finishMediaAction,
  retryMedia: retryMediaAction,
  tidyMedia: tidyMediaAction,
  removeMedia: removeMediaAction,
  listMedia: entryMediaAction,
  remove: deleteEntryAction,
  stickers: { list: listStickersAction, begin: beginStickerAction, finish: finishStickerAction, remove: removeStickerAction },
};

/** 一篇日记：一页纸（components/journal/journal-editor.tsx），直接在上面写。 */
export default async function JournalEntryPage({ params }: Props) {
  const detail = await load((await params).id);
  if (!detail) notFound();
  return <JournalEditor key={detail.entry.id} initial={detail} api={api} />;
}
