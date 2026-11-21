import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MapEditor, type MapApi } from "@/components/map-editor";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { getMapDetail, type MapDetail } from "@/lib/vault/map-service";
import { mapTitle } from "@/lib/vault/map-store";
import { chatMapAction, deleteMapAction, draftMapAction, saveMapAction, undoMapAction } from "../actions";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ draft?: string }> };

async function load(id: string): Promise<MapDetail | null> {
  const session = await requireSession();
  try {
    return await getMapDetail(session, id);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return null;
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const detail = await load((await params).id);
  return { title: detail ? mapTitle(detail.map) : "不在了" };
}

const api: MapApi = { save: saveMapAction, chat: chatMapAction, draft: draftMapAction, undo: undoMapAction, remove: deleteMapAction };

/** 一张自己建的导图：大纲编辑器 + 思维导图 + 跟 AI 对话（components/map-editor.tsx）。 */
export default async function MapPage({ params, searchParams }: Props) {
  const [{ id }, { draft }] = await Promise.all([params, searchParams]);
  const detail = await load(id);
  if (!detail) notFound();
  // 新建时选了「让 AI 起草」带着 draft=1 过来：图还是空的才起草（刷新、后退回来不重来）
  return <MapEditor key={detail.map.id} initial={detail} api={api} autoDraft={draft === "1" && detail.map.nodes.length === 0 && detail.map.chat.length === 0} />;
}
