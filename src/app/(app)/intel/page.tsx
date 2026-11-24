import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import { INTEL_SOURCE_LABEL, agoLabel } from "@/lib/intel/candidate";
import { formatCount } from "@/lib/sources/types";
import { VaultError } from "@/lib/vault/errors";
import { intelEveryMinutes, listMySignals, listMyWatches, watchLabel, SIGNAL_LIST } from "@/lib/vault/intel-service";
import { SIGNAL_STATUSES, type Signal, type SignalStatus, type Watch } from "@/lib/vault/intel-store";
import { AddWatchForm, CheckAllButton, SignalButtons, WatchControls } from "./watch-forms";

export const metadata: Metadata = { title: "情报" };

const TAB_LABEL: Record<SignalStatus, string> = { new: "新的", saved: "存了的", dismissed: "不要的" };
const EMPTY: Record<SignalStatus, string> = {
  new: "现在没有新的。分数过线的内容出现了会列在这里。",
  saved: "还没有从这里存过内容。",
  dismissed: "没有标成「不要」的。",
};

/**
 * 情报：盯几个来源（Reddit 的版块、Hacker News 上的关键词），有分数过线的新内容就列在这里，挑着存进收藏库。
 * 上半页是盯着的来源，下半页是发现的内容（`?show=saved|dismissed` 看存了的 / 不要的）。
 */
export default async function IntelPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const session = await requireSession();
  const { show: wanted } = await searchParams;
  const show = SIGNAL_STATUSES.find((s) => s === wanted) ?? "new";
  let watches, page;
  try {
    [watches, page] = await Promise.all([listMyWatches(session), listMySignals(session, show)]);
  } catch (e) {
    // 表还没建（迁移没推）：告诉他要做什么，不是整页报错
    if (!(e instanceof VaultError)) throw e;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">情报</h1>
        <p role="alert" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-warning">
          {e.message}
        </p>
      </div>
    );
  }
  const now = new Date();
  const every = intelEveryMinutes();
  const byId = new Map(watches.map((w) => [w.id, w]));
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">情报</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          盯几个地方，有热起来的新内容就列在下面，你挑着存进收藏库。这里只留标题和一小段开头，不交给 AI、不花钱；点「存入」才和自己贴链接一样去读、去理解。
          {every > 0 ? `后台每 ${every >= 60 && every % 60 === 0 ? `${every / 60} 小时` : `${every} 分钟`}把每个来源看一遍。` : "后台的定时检查关着（VAULT_INTEL_EVERY_MIN=0），要看得手动点。"}
        </p>
        <AddWatchForm />
        <p className="text-xs leading-relaxed text-ink-faint">
          Reddit 的帖子是从第三方存档读的，赞数比 Reddit 上的晚几个小时：一条帖子要等存档回头记过、赞数过了线才会出现。Hacker News 的分数是当时的。
        </p>
      </section>

      <section className="flex flex-col gap-3" aria-label="盯着的来源">
        <div className="flex items-center justify-between gap-3">
          <h2 className="label">盯着的来源（{watches.length}）</h2>
          {watches.some((w) => w.enabled) && <CheckAllButton />}
        </div>
        {watches.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-muted">还没有盯着的来源。上面加一个 Reddit 的版块，或者 Hacker News 上的一组关键词。</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {watches.map((w) => (
              <WatchRow key={w.id} watch={w} now={now} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="发现的内容">
        <nav className="chip-row" aria-label="看哪一类">
          {SIGNAL_STATUSES.map((s) => (
            <Link key={s} href={s === "new" ? "/intel" : `/intel?show=${s}`} prefetch={false} aria-current={s === show ? "page" : undefined} className={`chip ${s === show ? "chip-on" : ""}`}>
              {TAB_LABEL[s]} {page.counts[s]}
            </Link>
          ))}
        </nav>
        {page.signals.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-muted">{watches.length === 0 && show === "new" ? "加了来源之后，发现的内容列在这里。" : EMPTY[show]}</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {page.signals.map((s) => (
              <SignalRow key={s.id} signal={s} from={byId.get(s.watchId)} now={now} />
            ))}
          </ul>
        )}
        {page.counts[show] > page.signals.length && (
          <p className="text-xs text-ink-faint">
            一共 {page.counts[show]} 条，这里列了最新的 {Math.min(SIGNAL_LIST, page.signals.length)} 条。
          </p>
        )}
      </section>
    </div>
  );
}

function WatchRow({ watch: w, now }: { watch: Watch; now: Date }) {
  const label = watchLabel(w);
  return (
    <li className={`panel flex flex-col gap-2 px-4 py-3 ${w.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium break-words">{label}</span>
          <span className="text-xs text-ink-faint">
            至少 {w.minScore} 分{w.kind === "subreddit" && w.keywords ? ` · 只要带：${w.keywords}` : ""} · {w.enabled ? (w.lastCheckedAt ? `${agoLabel(w.lastCheckedAt, now)}看过` : "还没看过") : "停着"}
          </span>
        </div>
        <WatchControls id={w.id} enabled={w.enabled} minScore={w.minScore} keywords={w.keywords} withKeywords={w.kind === "subreddit"} label={label} />
      </div>
      {w.lastError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
          上次没看成：{w.lastError}
        </p>
      )}
      {w.lastNotes.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
          {w.lastNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SignalRow({ signal: s, from, now }: { signal: Signal; from: Watch | undefined; now: Date }) {
  const meta = [
    s.channel || INTEL_SOURCE_LABEL[s.source],
    s.score !== null ? `${formatCount(s.score)} ${s.source === "reddit" ? "赞" : "分"}` : "",
    s.comments !== null ? `${formatCount(s.comments)} 评论` : "",
    agoLabel(s.publishedAt, now),
    // HN 的一条是哪组关键词找到的（Reddit 的版块名已经写在前面了）
    s.source === "hackernews" && from ? `搜「${from.query}」` : "",
  ].filter(Boolean);
  return (
    <li className="panel flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-col gap-1">
        <a href={s.url} target="_blank" rel="noreferrer noopener" className="font-medium break-words hover:underline">
          {s.title}
        </a>
        <span className="text-xs text-ink-faint">{meta.join(" · ")}</span>
      </div>
      {s.excerpt && <p className="line-clamp-3 text-sm leading-relaxed break-words text-ink-muted">{s.excerpt}</p>}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {s.status === "saved" ? (
          s.itemId ? (
            <Link href={`/items/${s.itemId}`} prefetch={false} className="btn h-8 px-3 text-xs">
              看存下的那条
            </Link>
          ) : (
            <span className="text-xs text-ink-faint">存过，那条内容后来删了</span>
          )
        ) : (
          <SignalButtons id={s.id} status={s.status} />
        )}
        {s.discussionUrl && s.discussionUrl !== s.url && (
          <a href={s.discussionUrl} target="_blank" rel="noreferrer noopener" className="btn btn-quiet h-8 px-2 text-xs">
            看讨论
          </a>
        )}
      </div>
    </li>
  );
}
