import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { ItemGrid } from "@/components/item-grid";
import { LocalDate } from "@/components/local-date";
import { PROFILE_ACTORS } from "@/lib/sources/account-apify";
import type { AccountRef } from "@/lib/sources/link";
import { SOURCE_PLATFORM_LABEL, fallbackTitle, formatCount } from "@/lib/sources/types";
import { UNIT_USD } from "@/lib/usage/prices";
import type { CostHint, CreatorDetail, CreatorSummary } from "@/lib/vault/creator-service";
import { creatorBusy, creatorStuck, creatorTitle, type Creator } from "@/lib/vault/creator-store";
import { inProgress, isStuck } from "@/lib/vault/store";
import { AddCreatorForm, FindCreatorForm, RemoveButton, ResumeButton, StopButton, SyncForm } from "./creator-forms";

/** 「博主」三个页面画出来的样子（只管显示；读数据在各自的 page.tsx 里）。 */

/** 一行里写现在是什么情况。 */
function statusLine(c: CreatorSummary): { text: string; tone: "muted" | "danger" | "accent" } {
  if (creatorStuck(c)) return { text: "中断了，点开接着存", tone: "danger" };
  if (c.status === "listing") return { text: "正在列他的作品…", tone: "accent" };
  if (c.status === "saving") return { text: `正在存：已存 ${c.counts.saved} 条，还有 ${c.counts.pending} 条`, tone: "accent" };
  if (c.status === "failed") return { text: c.error ?? "没列成", tone: "danger" };
  return { text: `已存 ${c.counts.saved} 条${c.counts.held > 0 ? `，${c.counts.held} 条列出来了没存` : ""}`, tone: "muted" };
}

const TONE = { muted: "text-ink-muted", danger: "text-danger", accent: "text-accent" } as const;

/** 列表页：贴一个主页的链接加一个，下面列出已有的。 */
export function CreatorListView({ creators }: { creators: CreatorSummary[] }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <AutoRefresh active={creators.some((c) => creatorBusy(c))} everyMs={8000} />
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">博主</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          觉得一个人讲得好，把他发过的作品整个存下来。支持 X、TikTok、抖音的账号：贴他主页的链接，选存最近的多少条。每一条都和单独存进来的一样读懂、归类，在收藏库里搜得到。
        </p>
        <FindCreatorForm />
      </section>

      <section className="flex flex-col gap-3" aria-label="已经加的博主">
        {creators.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-muted">还没有加博主。在上面贴一个主页的链接开始；在收藏库的存入框里贴主页链接也会带你到这里。</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {creators.map((c) => {
              const line = statusLine(c);
              return (
                <li key={c.id}>
                  <Link href={`/creators/${c.id}`} className="panel flex flex-col gap-1.5 px-4 py-3 transition-colors hover:border-edge-strong">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate font-medium">{creatorTitle(c)}</span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {SOURCE_PLATFORM_LABEL[c.platform]}
                        {c.handle ? ` · ${c.handle}` : ""}
                        {c.syncedAt ? (
                          <>
                            {" · 上次同步 "}
                            <LocalDate iso={c.syncedAt} />
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className={`truncate text-sm ${TONE[line.tone]}`}>{line.text}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 各平台存的是什么、不存什么（确认之前说清楚）。 */
const WHAT: Record<AccountRef["platform"], string[]> = {
  x: ["只存他自己发的帖子：转发别人的不存，回别人的回复不存。", "一串帖子（他接着自己的帖子往下发的）算一条，后面几条读第一条时一起读进来。", "帖子里引用的帖子、贴的链接照常跟着读。"],
  tiktok: ["存他主页「视频」栏里的视频和图集；他转发的别人的视频不存。", "列作品走 Apify（要配 APIFY_TOKEN）。"],
  douyin: ["存他主页上公开的视频和图文。", "列作品、读每一条都走 Apify（要配 APIFY_TOKEN）。"],
};

/** 确认页：是哪个账号、存的是什么、选存最近的多少条、估的花费。 */
export function NewCreatorView({ account: ref, had, hint, parallel }: { account: AccountRef; had: Creator | null; hint: CostHint | null; parallel: number }) {
  const label = SOURCE_PLATFORM_LABEL[ref.platform];
  // 英文的平台名和前后的中文之间留空格
  const spaced = /^[a-z]/i.test(label) ? ` ${label} ` : label;
  const listUsd = ref.platform === "x" ? 0 : (UNIT_USD[PROFILE_ACTORS[ref.platform].countKey] ?? 0);
  // 抖音读每一条也要走 Apify，这笔已经算在「已有内容平均每条」里了
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">存这个博主的作品</h1>
        <p className="panel flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm">
          <span className="text-ink-faint">{label}</span>
          <span className="font-medium">{ref.handle || "主页"}</span>
          <a href={ref.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent hover:underline">
            {ref.url.replace(/^https:\/\/(www\.)?/, "")}
          </a>
        </p>
        {had && (
          <p className="rounded-md bg-accent-soft px-3.5 py-2.5 text-sm leading-relaxed text-accent">
            这个博主已经加过了（
            <Link href={`/creators/${had.id}`} className="underline">
              {creatorTitle(had)}
            </Link>
            ）。{creatorBusy(had) ? "他的作品正在存，这里再点不会重新开始。" : "再存一次会重新列他最近的作品，没存过的存进来；存过的不会重复。"}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2 text-sm leading-relaxed text-ink-secondary">
        <p>从最新的开始往回，一条条存进收藏库。每一条都和单独贴链接存进来的一样处理：读取、视频转文字、理解、归类。以前单独存过的那几条不会重复。</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-muted">
          {WHAT[ref.platform].map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>一次同时处理 {parallel} 条，后台跑，可以关掉页面；中途随时能停，停下之后还没存的不会再花钱。</li>
        </ul>
      </section>

      <AddCreatorForm url={ref.url} perItemUsd={hint?.avgUsd ?? null} listUsd={listUsd} />

      <p className="text-xs leading-relaxed text-ink-muted">
        {hint
          ? `花费是按你库里最近 ${hint.n} 条${spaced}内容估的：平均每条 $${hint.avgUsd.toFixed(3)}（读取、转写、理解都算上）。这个博主的视频更长或更短，实际会不一样；每条花了多少记在它自己的页面底部。`
          : `你还没存过${spaced}的内容，没有可以参考的花费。实测过的数：一段短文字约 $0.04、一篇短文约 $0.06，带画面的视频更高、越长越贵。可以先存 20 条，看看实际花了多少再加。`}
      </p>
    </div>
  );
}

/** 一个博主：账号、现在存到哪了、没存到的、已经存下来的内容。 */
export function CreatorDetailView({ detail }: { detail: CreatorDetail }) {
  const { creator: c, counts, posts, items, page, pages, removed } = detail;
  const busy = creatorBusy(c);
  const stuck = creatorStuck(c);
  const label = SOURCE_PLATFORM_LABEL[c.platform];
  const waiting = posts.filter((p) => p.status !== "saved");
  const failed = items.filter((i) => i.status === "failed" || isStuck(i)).length;
  const working = items.some((i) => inProgress(i));
  const pageHref = (n: number) => (n <= 1 ? `/creators/${c.id}` : `/creators/${c.id}?page=${n}`);

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={busy || working} everyMs={6000} />
      <header className="flex flex-col gap-2">
        <p className="text-sm">
          <Link href="/creators" className="text-ink-muted hover:text-ink">
            ← 博主
          </Link>
        </p>
        <h1 className="text-xl font-semibold tracking-tight">{creatorTitle(c)}</h1>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-ink-muted">
          <span>{label}</span>
          {c.handle && <span>{c.handle}</span>}
          {c.postCount !== null && (
            <span>
              {/* X 的总数里有转发和回复，和存下来的条数对不上是正常的 */}
              {c.platform === "x" ? `帖子总数 ${formatCount(c.postCount)}（含转发和回复）` : `${formatCount(c.postCount)} 个作品`}
            </span>
          )}
          <a href={c.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            打开主页
          </a>
        </p>
        {c.bio && <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-line text-ink-secondary">{c.bio}</p>}
      </header>

      <section aria-label="进度" className="panel flex flex-col gap-3 px-4 py-3.5 text-sm">
        {stuck ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-danger">存到一半中断了（后台任务很久没有动静）。已存 {counts.saved} 条，还有 {counts.pending} 条排着队。</p>
            {counts.pending > 0 ? <ResumeButton id={c.id} label="接着存" /> : <SyncForm id={c.id} defaultWant={c.want} label="重新列" />}
          </div>
        ) : c.status === "listing" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-accent">
              正在列他最近的 {c.want} 条作品…{posts.length > 0 ? `（清单里现在有 ${posts.length} 条）` : ""}
            </p>
            <StopButton id={c.id} />
          </div>
        ) : c.status === "saving" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-accent">
              正在存：已存 {counts.saved} 条，还有 {counts.pending} 条排着队。可以关掉页面，后台接着跑。
            </p>
            <StopButton id={c.id} />
          </div>
        ) : c.status === "failed" ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-danger">
              没列成：{c.error ?? "原因不明"}
            </p>
            <SyncForm id={c.id} defaultWant={c.want} label="再试一次" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-ink-secondary">
              已存 {counts.saved} 条
              {c.syncedAt ? (
                <>
                  ，上次列作品是 <LocalDate iso={c.syncedAt} />
                </>
              ) : null}
              。
            </p>
            {counts.held + counts.pending > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-ink-secondary">还有 {counts.held + counts.pending} 条列出来了没存（上次停下了）。</p>
                <ResumeButton id={c.id} label={`把这 ${counts.held + counts.pending} 条也存了`} />
              </div>
            )}
            <SyncForm id={c.id} defaultWant={c.want} />
            <p className="text-xs leading-relaxed text-ink-muted">找他新发的，选小的数；往回多存一些，选大的。存过的不会重复，列作品{c.platform === "x" ? "不花钱" : "按条数收一点 Apify 的钱"}。</p>
          </div>
        )}
        {failed > 0 && <p className="text-danger">这一页里有 {failed} 条没处理成：点开那一条看原因、重试。</p>}
        {(c.notes.length > 0 || removed > 0) && (
          <div className="flex flex-col gap-1 border-t border-edge pt-3">
            <h2 className="label">没存到的</h2>
            <ul className="flex list-disc flex-col gap-1 pl-5 leading-relaxed text-ink-muted">
              {c.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {removed > 0 && <li>有 {removed} 条存过、后来从收藏库里删掉了：再同步不会重新存它们</li>}
            </ul>
          </div>
        )}
        {c.costUsd > 0 && <p className="text-xs text-ink-faint">列作品累计花了 ${c.costUsd.toFixed(3)}（每条内容自己的花费在它的页面底部）</p>}
      </section>

      {waiting.length > 0 && (
        <details className="panel px-4 py-3 text-sm">
          <summary className="cursor-pointer text-ink-secondary">
            还没存的 {waiting.length} 条{busy ? "（排着队，从最新的开始）" : ""}
          </summary>
          <ul className="mt-3 flex flex-col gap-1.5">
            {waiting.slice(0, 200).map((p) => (
              <li key={p.id} className="flex items-baseline gap-3">
                <span className="w-20 shrink-0 text-xs text-ink-faint">{p.publishedAt ? <LocalDate iso={p.publishedAt} /> : "—"}</span>
                <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">
                  {p.title || fallbackTitle(c.platform, p.kind)}
                </a>
                {p.pinned && <span className="shrink-0 text-xs text-ink-faint">置顶</span>}
              </li>
            ))}
          </ul>
          {waiting.length > 200 && <p className="mt-2 text-xs text-ink-muted">只列了前 200 条。</p>}
        </details>
      )}

      <section aria-label="已经存下来的内容" className="flex flex-col gap-3">
        {items.length === 0 ? (
          <p className="panel px-6 py-12 text-center text-sm leading-relaxed text-ink-muted">{busy ? "还没有存好的内容，存好一条这里出现一条。" : "还没有存下来的内容。"}</p>
        ) : (
          <ItemGrid hits={items.map((item) => ({ item, keywordHits: 0, similarity: null, snippet: null }))} />
        )}
        {pages > 1 && (
          <nav aria-label="翻页" className="flex items-center justify-center gap-4 text-sm">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="text-accent hover:underline">
                ← 更新的
              </Link>
            ) : (
              <span className="text-ink-faint">← 更新的</span>
            )}
            <span className="text-ink-muted">
              第 {page} / {pages} 页
            </span>
            {page < pages ? (
              <Link href={pageHref(page + 1)} className="text-accent hover:underline">
                更早的 →
              </Link>
            ) : (
              <span className="text-ink-faint">更早的 →</span>
            )}
          </nav>
        )}
      </section>

      <footer className="flex justify-end border-t border-edge pt-4">
        <RemoveButton id={c.id} />
      </footer>
    </div>
  );
}
