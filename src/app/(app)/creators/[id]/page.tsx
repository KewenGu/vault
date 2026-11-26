import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { getCreatorDetail, type CreatorDetail } from "@/lib/vault/creator-service";
import { creatorTitle } from "@/lib/vault/creator-store";
import { VaultError } from "@/lib/vault/errors";
import { CreatorDetailView } from "../creator-views";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> };

async function load(id: string, page = 1): Promise<CreatorDetail | { error: string } | null> {
  const session = await requireSession();
  try {
    return await getCreatorDetail(session, id, page);
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    return e.status === 404 ? null : { error: e.message };
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const detail = await load((await params).id);
  return { title: detail && "creator" in detail ? creatorTitle(detail.creator) : "博主" };
}

/** 一个博主：账号、现在存到哪了、没存到的、已经存下来的内容。 */
export default async function CreatorPage({ params, searchParams }: Props) {
  const { id } = await params;
  const detail = await load(id, Number((await searchParams).page) || 1);
  if (!detail) notFound();
  if ("error" in detail) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">博主</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-warning">
          {detail.error}
        </p>
      </div>
    );
  }
  return <CreatorDetailView detail={detail} />;
}
