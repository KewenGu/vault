import Link from "next/link";
import type { Related, RelatedItem } from "@/lib/vault/related";
import { coverOf, displayTitle, itemFileUrl, sourceLabel } from "@/lib/vault/store";
import { CONTENT_TYPE_INFO } from "@/lib/vault/taxonomy";

/** 一行里最多写出这么多个共同提到的名字 */
const SHARED_SHOWN = 3;

/** 为什么相关，写成一句话：「内容相近 · 都提到 亚特兰蒂斯、三亚」 */
function reason(r: RelatedItem): string {
  const names = r.shared.slice(0, SHARED_SHOWN).map((s) => s.name);
  const more = r.shared.length - names.length;
  const shared = names.length > 0 ? `都提到 ${names.join("、")}${more > 0 ? ` 等 ${r.shared.length} 个` : ""}` : "";
  return [r.similarity !== null ? "内容相近" : "", shared].filter(Boolean).join(" · ");
}

/**
 * 详情页的「相关的内容」：收藏库里和这条有关系的其他内容（lib/vault/related.ts），每条写着为什么相关。
 * 一条都没有、也没有要说明的情况时整块不显示；这次没能找的（没有向量、查询出错）列在下面。
 */
export function RelatedItems({ related }: { related: Related }) {
  const { items, notes } = related;
  if (items.length === 0 && notes.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label="相关的内容">
      <h2 className="label">相关的内容</h2>
      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">没找到。</p>
      ) : (
        <ul className="panel divide-y divide-edge">
          {items.map((r) => {
            const cover = coverOf(r.item);
            const type = r.item.contentType && r.item.contentType !== "other" ? CONTENT_TYPE_INFO[r.item.contentType].label : "";
            return (
              <li key={r.item.id}>
                {/* 不预取：一页六条，处理中的页面每隔几秒还会刷新（原因见 (app)/layout.tsx） */}
                <Link href={`/items/${r.item.id}`} prefetch={false} className="flex gap-3 px-3.5 py-3 transition-colors hover:bg-sunken">
                  {cover && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={itemFileUrl(r.item, cover)} alt="" loading="lazy" className="size-14 shrink-0 rounded-md border border-edge bg-sunken object-cover object-top" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="line-clamp-2 text-sm leading-snug font-medium">{displayTitle(r.item)}</span>
                    {r.item.summary && <span className="line-clamp-2 text-xs leading-relaxed text-ink-muted">{r.item.summary}</span>}
                    <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-ink-faint">
                      <span>{[sourceLabel(r.item), type, r.item.author].filter(Boolean).join(" · ")}</span>
                      <span className="text-accent">{reason(r)}</span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="flex list-disc flex-col gap-0.5 rounded-md bg-warning-soft py-1.5 pr-3 pl-7 text-xs text-warning">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
