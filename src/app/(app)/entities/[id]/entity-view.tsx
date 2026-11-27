import Link from "next/link";
import { LocalDate } from "@/components/local-date";
import { clock } from "@/lib/media/transcript";
import type { EntityNeighbor, EntityPage } from "@/lib/vault/entity-service";
import { PAGE_SIZE } from "@/lib/vault/search";
import { displayTitle, sourceLabel } from "@/lib/vault/store";
import { ENTITY_TYPE_INFO, RELATION_INFO } from "@/lib/vault/taxonomy";
import { Aliases, EntityItems, MergeForm, RenameForm, type EntityItemRow } from "./entity-actions";

/**
 * 这个实体和另一个是什么关系，读起来像半句话：它指向对方的写在名字前面（「属于 伯克希尔」），
 * 对方指向它的写在名字后面（「穷查理宝典 关于它」）；只是出现在同一条内容里的写「一起出现」。
 */
function relationWords(n: EntityNeighbor): { before: string; after: string } {
  if (n.relation === "cooccur") return { before: "一起出现", after: "" };
  const label = RELATION_INFO[n.relation].label;
  return n.relation === "related" || n.outgoing ? { before: label, after: "" } : { before: "", after: `${label}它` };
}

/** 实体页画出来的样子（数据由 page.tsx 读好传进来）。 */
export function EntityView({ data, page }: { data: EntityPage; page: number }) {
  const { entity, items, total, capped, neighbors, notes, names, gaps } = data;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listId = "entity-names";
  const rows: EntityItemRow[] = items.map(({ item, about }) => ({
    id: item.id,
    title: displayTitle(item),
    origin: [sourceLabel(item), item.author].filter(Boolean).join(" · "),
    createdAt: item.createdAt,
    about,
    summary: item.summary,
    own: item.source === "own",
  }));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <Link href="/graph" prefetch={false} className="hover:text-ink">
            ← 图谱
          </Link>
          <span>{ENTITY_TYPE_INFO[entity.type].label}</span>
          <span>
            {total}
            {capped ? "+" : ""} 条内容提到它
          </span>
          <Link href={`/?entity=${entity.id}`} prefetch={false} className="text-accent hover:underline" title="回收藏库，只看提到它的：能再加搜索词和筛选">
            在收藏库里筛
          </Link>
        </div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight break-words">{entity.name}</h1>
        {entity.aliases.length > 0 && <Aliases id={entity.id} aliases={entity.aliases} />}
        {entity.summary && <p className="text-[15px] leading-relaxed text-ink-secondary">{entity.summary}</p>}
      </header>

      {gaps.length > 0 && (
        <ul role="status" className="flex list-disc flex-col gap-1 rounded-md bg-warning-soft py-3 pr-3.5 pl-8 text-sm leading-relaxed text-warning">
          {gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}

      {neighbors.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="label">和它有关系的</h2>
          <ul className="flex flex-wrap gap-1.5">
            {neighbors.map((n) => (
              <li key={`${n.id}|${n.relation}|${n.outgoing}`}>
                <Link href={`/entities/${n.id}`} prefetch={false} className="chip" title={`${ENTITY_TYPE_INFO[n.type].label} · ${n.weight} 条内容`}>
                  {relationWords(n).before && <span className="text-ink-faint">{relationWords(n).before}</span>}
                  {n.name}
                  {relationWords(n).after && <span className="text-ink-faint">{relationWords(n).after}</span>}
                  {n.weight > 1 && <span className="text-ink-faint">×{n.weight}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {notes.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="label">我在这些内容上划的线、写的批注</h2>
          <ul className="panel divide-y divide-edge">
            {notes.map(({ note, itemTitle }) => (
              <li key={note.id} className="flex flex-col gap-1.5 px-3.5 py-3">
                {note.quote && (
                  <blockquote className="border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink-secondary">
                    {note.at !== null && <span className="mr-2 font-mono text-xs text-ink-faint">{clock(note.at)}</span>}
                    {note.quote}
                  </blockquote>
                )}
                {note.body && <p className="text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>}
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                  <LocalDate iso={note.createdAt} />
                  <Link href={`/items/${note.itemId}`} prefetch={false} className="min-w-0 truncate hover:text-ink">
                    {itemTitle || "那条内容"}
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="label">
          提到它的内容{pages > 1 ? `（第 ${page} / ${pages} 页）` : ""}
        </h2>
        {rows.length > 0 ? (
          <EntityItems key={`${entity.id}:${page}:${rows.length}`} id={entity.id} name={entity.name} items={rows} listId={listId} />
        ) : (
          <p className="panel px-6 py-10 text-center text-sm text-ink-muted">{page > 1 ? "这一页没有内容了。" : "现在没有处理好的内容提到它。"}</p>
        )}
        {capped && <p className="text-xs text-ink-faint">最多列最近的 200 条，更早的这里看不到。</p>}
        {pages > 1 && (
          <nav className="flex items-center justify-between text-sm" aria-label="翻页">
            {page > 1 ? (
              <Link href={`/entities/${entity.id}${page > 2 ? `?page=${page - 1}` : ""}`} prefetch={false} className="btn">
                ← 上一页
              </Link>
            ) : (
              <span />
            )}
            {page < pages && (
              <Link href={`/entities/${entity.id}?page=${page + 1}`} prefetch={false} className="btn">
                下一页 →
              </Link>
            )}
          </nav>
        )}
      </section>

      <details className="border-t border-edge pt-5">
        <summary className="label cursor-pointer hover:text-ink">整理：改名字、合并</summary>
        <div className="mt-4 flex flex-col gap-6">
          <RenameForm key={`${entity.name}|${entity.summary}`} id={entity.id} name={entity.name} summary={entity.summary} />
          <MergeForm id={entity.id} name={entity.name} listId={listId} />
          <p className="text-xs leading-relaxed text-ink-faint">
            模型把两个不同的东西并成了一个？在上面的内容里勾上说的不是「{entity.name}」的那几条，移到别的实体上。
          </p>
        </div>
      </details>
      <datalist id={listId}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}
