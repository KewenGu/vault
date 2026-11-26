import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import type { AccountRef } from "@/lib/sources/link";
import { costHint, resolveAccount, type CostHint } from "@/lib/vault/creator-service";
import { creatorParallel, findCreator, type Creator } from "@/lib/vault/creator-store";
import { VaultError } from "@/lib/vault/errors";
import { NewCreatorView } from "../creator-views";

export const metadata: Metadata = { title: "存一个博主的作品" };

/** 确认页：认出是哪个账号，选存最近的多少条，看估的花费，确认了才开始（每条都要花读取和理解的钱）。 */
export default async function NewCreatorPage({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  const session = await requireSession();
  const url = (await searchParams).url ?? "";
  let ref: AccountRef;
  let had: Creator | null = null;
  let hint: CostHint | null = null;
  try {
    ref = await resolveAccount(url);
    [had, hint] = await Promise.all([findCreator(session.db, session.user.id, ref), costHint(session, ref.platform)]);
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">存一个博主的作品</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-warning">
          {e.message}
        </p>
        <Link href="/creators" className="text-sm text-accent hover:underline">
          回「博主」页重新贴
        </Link>
      </div>
    );
  }
  return <NewCreatorView account={ref} had={had} hint={hint} parallel={creatorParallel()} />;
}
