import { LocalDate } from "@/components/local-date";
import { TRACE_BUDGET, TRACE_KIND_LABEL, TRACE_ORIGIN_LABEL, TRACE_VERDICT_LABEL, URL_SEEN_LABEL, type TraceSource, type TraceVerdict } from "@/lib/vault/trace";
import { traceRunning, traceStuck, type ItemTrace } from "@/lib/vault/trace-store";
import { SaveSourceButton, TraceButton } from "./item-actions";

/**
 * 详情页的「溯源」：这条内容引用的东西的第一手出处在哪、原文是不是这么说的（lib/vault/trace.ts）。
 * 没溯源过时是一段说明和一个按钮（用户点了才查：要联网，要花钱）；查的时候页面自己刷新；查完列出每一样东西。
 * 没查到 / 没读到的（notes）摆在结果前面：下面的结论只基于查到的东西。
 */

const VERDICT_STYLE: Record<TraceVerdict, string> = {
  confirmed: "bg-accent-soft text-accent",
  differs: "bg-warning-soft text-warning",
  unsupported: "bg-danger-soft text-danger",
  unread: "bg-sunken text-ink-muted",
  not_found: "bg-sunken text-ink-muted",
};

function Source({ source, itemTitle }: { source: TraceSource; itemTitle: string }) {
  const found = source.url !== null && source.verdict !== "not_found";
  // 读过原文才叫「原文」怎么说；没读到 / 没找到时那一栏写的是查的经过
  const checked = source.verdict === "confirmed" || source.verdict === "differs" || source.verdict === "unsupported";
  return (
    <li className="panel flex flex-col gap-2.5 p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex h-6 items-center rounded-full border border-edge px-2 text-xs text-ink-muted">{TRACE_KIND_LABEL[source.kind]}</span>
        <span className={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${VERDICT_STYLE[source.verdict]}`}>{TRACE_VERDICT_LABEL[source.verdict]}</span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm leading-snug font-medium">{source.name}</p>
        {(source.by || source.date) && <p className="text-xs text-ink-muted">{[source.by, source.date].filter(Boolean).join(" · ")}</p>}
      </div>
      {source.url && (
        <div className="flex min-w-0 flex-col gap-1">
          <a href={source.url} target="_blank" rel="noreferrer noopener" className="truncate text-sm text-accent hover:underline">
            {source.url}
          </a>
          <p className={`text-xs ${source.seen === "unseen" ? "text-warning" : "text-ink-faint"}`}>
            {found ? "" : "只是找到的线索，不是第一手出处。"}
            {URL_SEEN_LABEL[source.seen]}
          </p>
        </div>
      )}
      <dl className="flex flex-col gap-2 text-sm leading-relaxed">
        {source.claim && (
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
            <dt className="text-ink-muted">这条内容说</dt>
            <dd className="whitespace-pre-wrap">{source.claim}</dd>
          </div>
        )}
        {source.finding && (
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
            <dt className="text-ink-muted">{checked ? "原文" : "查到的"}</dt>
            <dd className="whitespace-pre-wrap">{source.finding}</dd>
          </div>
        )}
      </dl>
      {source.quote && <blockquote className="border-l-2 border-edge-strong pl-3 text-sm leading-relaxed text-ink-secondary">{source.quote}</blockquote>}
      {found && source.url && <SaveSourceButton url={source.url} note={`从「${itemTitle}」溯源来的出处`} />}
    </li>
  );
}

export function TraceSection({
  itemId,
  itemTitle,
  trace,
  unavailable,
  processedAt,
}: {
  itemId: string;
  itemTitle: string;
  trace: ItemTrace | null;
  unavailable: string | null;
  /** 这条内容最近一次处理完的时间：比溯源晚，说明结果是按之前读到的内容查的 */
  processedAt: string | null;
}) {
  const running = !!trace && traceRunning(trace);
  const failed = !!trace && (trace.status === "failed" || traceStuck(trace));
  const result = trace?.result ?? null;
  const stale = !!result && !!processedAt && Date.parse(result.at) < Date.parse(processedAt);
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="label">溯源</h2>
      {unavailable && (
        <p role="status" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm break-words text-warning">
          {unavailable}
        </p>
      )}
      {!unavailable && !trace && (
        <div className="panel flex flex-col gap-3 p-3.5">
          <p className="text-sm leading-relaxed text-ink-secondary">
            这条内容引用了别人的论文、文章、代码库、公告？去网上找第一手的出处，读原文对一对是不是这么说的。要联网搜索和读网页，一般一两分钟；比处理一条内容贵（最多搜 {TRACE_BUDGET.searches} 次、读 {TRACE_BUDGET.fetches} 个网页，花了多少查完会写在这里）。
          </p>
          <div>
            <TraceButton id={itemId} label="溯源" />
          </div>
        </div>
      )}
      {running && (
        <p role="status" className="rounded-md bg-accent-soft px-3.5 py-3 text-sm text-accent">
          正在找这条内容引用的东西的第一手出处、读原文核对… 一般一两分钟，页面会自己刷新。
        </p>
      )}
      {failed && trace && (
        <div className="flex flex-col gap-3 rounded-md bg-danger-soft px-3.5 py-3">
          <p role="alert" className="text-sm break-words text-danger">
            {trace.status === "failed" ? `这次溯源没成：${(trace.error ?? "原因不明").replace(/[。.]+$/, "")}。` : "溯源中断了（后台任务没跑完）。"}
            {result ? "下面是上一次查到的。" : ""}
          </p>
          <div>
            <TraceButton id={itemId} label="再试一次" />
          </div>
        </div>
      )}
      {result && (
        <>
          {stale && !running && <p className="text-sm text-ink-muted">这条内容在这次溯源之后重新处理过：下面是按之前读到的内容查的，想按现在的再查一遍点「重新溯源」。</p>}
          {result.notes.length > 0 && (
            <div role="note" className="flex flex-col gap-2 rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning">
              <p className="font-medium">这次溯源时：</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {(result.overview || result.origin !== "unknown") && (
            <p className="text-sm leading-relaxed text-ink-secondary">
              {result.origin !== "unknown" && <span className="font-medium text-ink">{TRACE_ORIGIN_LABEL[result.origin]}。</span>}
              {result.overview}
            </p>
          )}
          {result.sources.length > 0 ? (
            <ul className="flex flex-col gap-2.5">
              {result.sources.map((s, i) => (
                <Source key={`${i}-${s.name}`} source={s} itemTitle={itemTitle} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">没有列出引用的东西。</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-faint">
            <span>
              查于 <LocalDate iso={result.at} />
            </span>
            <span>
              搜了 {result.searches} 次、读了 {result.fetches} 个网页
            </span>
            {trace && trace.costUsd > 0 && <span>溯源一共花了约 ${trace.costUsd.toFixed(3)}</span>}
            {!running && !failed && <TraceButton id={itemId} label="重新溯源" quiet />}
          </div>
          <p className="text-xs leading-relaxed text-ink-faint">结论是模型读了之后写的，可能有错；每个地址下面写着它这次有没有真的打开过。要紧的点开原文自己看一眼。出处会变（论文出新版、网页改了），这里只是查的那一天的样子。</p>
        </>
      )}
    </section>
  );
}
