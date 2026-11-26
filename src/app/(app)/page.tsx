import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { CaptureBox } from "@/components/capture-box";
import { ItemGrid } from "@/components/item-grid";
import { requireSession } from "@/lib/auth/user";
import { SOURCE_PLATFORMS, SOURCE_PLATFORM_LABEL, type SourcePlatform } from "@/lib/sources/types";
import { loadFacets } from "@/lib/vault/facets";
import { PAGE_SIZE, SEARCH_CAP, searchItems } from "@/lib/vault/search";
import { inProgress, tagCounts } from "@/lib/vault/store";
import { CATEGORIES, CATEGORY_LABEL, CONTENT_TYPES, CONTENT_TYPE_INFO, ENTITY_TYPE_INFO, toEntityType } from "@/lib/vault/taxonomy";

type Params = { q?: string; type?: string; category?: string; tag?: string; from?: string; entity?: string; page?: string };

const ORIGIN_LABEL: Record<string, string> = { ...SOURCE_PLATFORM_LABEL, upload: "上传", text: "文字", own: "自己写的" };

/** 当前筛选换掉 / 去掉一项之后的地址（再点一次已选中的那项 = 取消） */
function hrefWith(current: Params, patch: Params): string {
  const next: Record<string, string | undefined> = { ...current, ...patch };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/?${s}` : "/";
}

function FilterRow({ label, current, param, options }: { label: string; current: Params; param: keyof Params; options: { key: string; label: string; n: number }[] }) {
  if (options.length === 0) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className="label w-10 shrink-0">{label}</span>
      <div className="chip-row min-w-0">
        {options.map((o) => {
          const on = current[param] === o.key;
          return (
            <Link key={o.key} href={hrefWith(current, { [param]: on ? undefined : o.key })} aria-current={on ? "true" : undefined} className={`chip ${on ? "chip-on" : ""}`}>
              {o.label}
              <span className="text-ink-faint">{o.n}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default async function VaultPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { user, db } = await requireSession();
  // current 里不带页码：换一个筛选条件、换一个搜索词都回到第一页
  const current: Params = { q: sp.q?.trim() || undefined, type: sp.type, category: sp.category, tag: sp.tag, from: sp.from, entity: sp.entity };
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const isPlatform = (SOURCE_PLATFORMS as readonly string[]).includes(current.from ?? "");
  const [result, facets, tags, entity] = await Promise.all([
    searchItems(db, user.id, {
      q: current.q,
      filters: {
        contentType: current.type,
        category: current.category,
        tag: current.tag,
        platform: isPlatform ? (current.from as SourcePlatform) : undefined,
        source: current.from && !isPlatform ? current.from : undefined,
        entityId: current.entity,
      },
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    loadFacets(db, user.id),
    tagCounts(db, user.id),
    current.entity ? db.from("entities").select("name,type,summary").eq("id", current.entity).eq("user_id", user.id).maybeSingle() : null,
  ]);
  const filtered = Object.values(current).some(Boolean);
  const busy = result.hits.some((h) => inProgress(h.item));
  const options = (keys: readonly string[], counts: Map<string, number>, label: (k: string) => string) =>
    keys.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => ({ key: k, label: label(k), n: counts.get(k) ?? 0 }));
  const entityType = entity?.data ? toEntityType(entity.data.type) : null;
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const pageHref = (n: number) => hrefWith(current, { page: n > 1 ? String(n) : undefined });
  const first = (page - 1) * PAGE_SIZE + 1;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={busy} />
      <CaptureBox />

      <section aria-label="搜索和筛选" className="flex flex-col gap-3">
        <form action="/" className="flex gap-2">
          {(["type", "category", "tag", "from", "entity"] as const).map((k) => (current[k] ? <input key={k} type="hidden" name={k} value={current[k]} /> : null))}
          <label htmlFor="q" className="sr-only">
            搜索
          </label>
          <input id="q" name="q" type="search" defaultValue={current.q ?? ""} placeholder="搜标题、内容、视频里说过的话、图片上的字…" className="field h-10" />
          <button className="btn h-10">搜索</button>
        </form>
        <FilterRow label="类型" current={current} param="type" options={options(CONTENT_TYPES, facets.contentType, (k) => CONTENT_TYPE_INFO[k as keyof typeof CONTENT_TYPE_INFO].label)} />
        <FilterRow label="领域" current={current} param="category" options={options(CATEGORIES, facets.category, (k) => CATEGORY_LABEL[k as keyof typeof CATEGORY_LABEL])} />
        <FilterRow label="来源" current={current} param="from" options={options([...SOURCE_PLATFORMS, "upload", "text", "own"], facets.origin, (k) => ORIGIN_LABEL[k] ?? k)} />
        <FilterRow label="标签" current={current} param="tag" options={tags.slice(0, 30).map((t) => ({ key: t.tag, label: `#${t.tag}`, n: t.n }))} />
      </section>

      {entity?.data && (
        <p className="panel flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm">
          <span className="text-ink-faint">{entityType ? ENTITY_TYPE_INFO[entityType].label : "实体"}</span>
          <span className="font-medium">{entity.data.name}</span>
          {entity.data.summary && <span className="min-w-0 flex-1 text-ink-muted">{entity.data.summary}</span>}
          <Link href={hrefWith(current, { entity: undefined })} className="text-accent hover:underline">
            取消
          </Link>
        </p>
      )}

      <section aria-label="内容">
        <div className="mb-3 flex items-baseline justify-between text-sm text-ink-muted">
          <p>
            {filtered ? (result.capped ? `找到 ${SEARCH_CAP} 条以上，只列最相关的前 ${SEARCH_CAP} 条` : `找到 ${result.total} 条`) : `共 ${result.total} 条`}
            {pages > 1 && result.hits.length > 0 ? `，这一页是第 ${first}–${first + result.hits.length - 1} 条` : ""}
            {current.q && !result.semantic ? "（只按关键词搜；没配语义搜索）" : ""}
          </p>
          <span className="flex shrink-0 gap-4">
            {current.q && (
              <Link href={`/ask?q=${encodeURIComponent(current.q)}`} prefetch={false} className="text-accent hover:underline" title="让 AI 根据收藏库里的内容回答这句话（带出处）">
                拿这句话去问
              </Link>
            )}
            {filtered && (
              <Link href="/" className="text-accent hover:underline">
                清除筛选
              </Link>
            )}
          </span>
        </div>
        {result.hits.length === 0 ? (
          <p className="panel px-6 py-14 text-center text-sm leading-relaxed text-ink-muted">
            {page > 1 && result.total > 0 ? (
              // 地址里的页码超出去了（内容删了、条件换了）：不是没有内容，是这一页没有
              <>
                这一页没有内容了，一共只有 {pages} 页。
                <Link href={pageHref(pages)} className="text-accent hover:underline">
                  去最后一页
                </Link>
              </>
            ) : filtered ? (
              "没有符合的内容。换个说法，或者去掉几个筛选条件。"
            ) : (
              "还没有内容。在上面贴一条链接、一段文字，或者拖一张截图进来试试。"
            )}
          </p>
        ) : (
          <ItemGrid hits={result.hits} />
        )}
        {pages > 1 && result.hits.length > 0 && (
          <nav aria-label="翻页" className="mt-6 flex items-center justify-center gap-3 text-sm">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="btn" rel="prev">
                ← 上一页
              </Link>
            ) : (
              <span className="btn cursor-default opacity-40" aria-disabled="true">
                ← 上一页
              </span>
            )}
            <span className="text-ink-muted">
              第 {page} / {pages} 页
            </span>
            {page < pages ? (
              <Link href={pageHref(page + 1)} className="btn" rel="next">
                下一页 →
              </Link>
            ) : (
              <span className="btn cursor-default opacity-40" aria-disabled="true">
                下一页 →
              </span>
            )}
          </nav>
        )}
        {result.capped && page === pages && (
          <p className="mt-4 text-center text-xs text-ink-faint">搜索和按图谱筛选一次最多列最相关的 {SEARCH_CAP} 条，后面可能还有：把词写具体一点，或者加上类型、领域、标签的筛选。</p>
        )}
      </section>
    </div>
  );
}
