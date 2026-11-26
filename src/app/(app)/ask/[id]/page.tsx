import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AskThread, type AskApi } from "@/components/ask-thread";
import { requireSession } from "@/lib/auth/user";
import { QUESTION_MAX, getAskDetail, type AskDetail } from "@/lib/vault/ask-service";
import { askTitle } from "@/lib/vault/ask-store";
import { VaultError } from "@/lib/vault/errors";
import { deleteAskAction, followUpAction } from "../actions";

type Props = { params: Promise<{ id: string }> };

async function load(id: string): Promise<AskDetail | null> {
  const session = await requireSession();
  try {
    return await getAskDetail(session, id);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return null;
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const detail = await load((await params).id);
  return { title: detail ? askTitle(detail.ask) : "不在了" };
}

const api: AskApi = { followUp: followUpAction, remove: deleteAskAction };

/** 一次提问：一问一答、每个回答的出处，下面可以接着追问（components/ask-thread.tsx）。 */
export default async function AskThreadPage({ params }: Props) {
  const detail = await load((await params).id);
  if (!detail) notFound();
  return <AskThread key={detail.ask.id} initial={detail} api={api} max={QUESTION_MAX} />;
}
