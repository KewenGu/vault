import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/user";
import { listMyCreators } from "@/lib/vault/creator-service";
import { VaultError } from "@/lib/vault/errors";
import { CreatorListView } from "./creator-views";

export const metadata: Metadata = { title: "博主" };

/** 收藏的博主：贴一个主页的链接加一个，下面列出已有的。 */
export default async function CreatorsPage() {
  const session = await requireSession();
  let creators;
  try {
    creators = await listMyCreators(session);
  } catch (e) {
    // 表还没建（迁移没推）：告诉他要做什么，不是整页报错
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">博主</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-warning">
          {e.message}
        </p>
      </div>
    );
  }
  return <CreatorListView creators={creators} />;
}
