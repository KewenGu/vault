import type { Metadata } from "next";
import Link from "next/link";
import { LocalDate } from "@/components/local-date";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { listMyMaps } from "@/lib/vault/map-service";
import { mapTitle } from "@/lib/vault/map-store";
import { NewMapForm } from "./new-map-form";

export const metadata: Metadata = { title: "导图" };

/** 自己建的思维导图：新建一张（空白，或者让 AI 按主题从收藏库里起草），下面列出已有的。 */
export default async function MapsPage() {
  const session = await requireSession();
  let maps;
  try {
    maps = await listMyMaps(session);
  } catch (e) {
    // 表还没建（迁移没推）：告诉他要做什么，不是整页报错
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">导图</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-warning">
          {e.message}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">导图</h1>
        <p className="text-sm leading-relaxed text-ink-muted">自己建的思维导图：围绕一个主题，把想法和收藏库里的内容整理成一棵树。自己在大纲里写，也可以跟 AI 说话让它帮着改、从你的收藏里补内容。</p>
        <NewMapForm />
      </section>

      <section className="flex flex-col gap-3" aria-label="已有的导图">
        {maps.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-muted">还没有导图。上面写一个主题开始；或者打开收藏库里的一条内容，点底部的「做成导图」。</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {maps.map((m) => (
              <li key={m.id}>
                <Link href={`/maps/${m.id}`} className="panel flex flex-col gap-1.5 px-4 py-3 transition-colors hover:border-edge-strong">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{mapTitle(m)}</span>
                    <span className="shrink-0 text-xs text-ink-faint">
                      {m.nodeCount} 个节点 · <LocalDate iso={m.updatedAt} />
                    </span>
                  </span>
                  {m.branches.length > 0 && <span className="truncate text-sm text-ink-muted">{m.branches.join(" · ")}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
