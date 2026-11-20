import Link from "next/link";
import { clock } from "@/lib/media/transcript";
import type { SearchHit } from "@/lib/vault/search";
import { coverOf, displayTitle, inProgress, isStuck, itemFileUrl, sourceLabel, videoOf, audioOf } from "@/lib/vault/store";
import { CONTENT_TYPE_INFO } from "@/lib/vault/taxonomy";

const STATUS_TEXT = { uploading: "等待上传", fetching: "读取中…", analyzing: "理解中…" } as const;

/** 收藏库里的一张卡片：封面、标题、概括、类型和标签；处理中 / 失败的显示状态。搜索命中了卡片上看不到的地方时带出那句话。 */
export function ItemCard({ hit }: { hit: SearchHit }) {
  const { item, snippet } = hit;
  const cover = coverOf(item);
  const busy = inProgress(item);
  const failed = item.status === "failed" || isStuck(item);
  const duration = (videoOf(item) ?? audioOf(item))?.durationS ?? null;
  return (
    <article className="panel overflow-hidden transition-colors hover:border-edge-strong">
      <Link href={`/items/${item.id}`} className="block">
        {cover && (
          <div className="relative bg-sunken">
            {/* 封面是存储桶里的私有文件，走 /media 跳签名地址：用普通 img，不经 next/image 的优化服务 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={itemFileUrl(item, cover)}
              alt=""
              loading="lazy"
              width={cover.width ?? undefined}
              height={cover.height ?? undefined}
              className="max-h-80 w-full object-cover object-top"
            />
            {duration ? <span className="absolute right-2 bottom-2 rounded-sm bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white">{clock(duration)}</span> : null}
          </div>
        )}
        <div className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <span>{sourceLabel(item)}</span>
            {item.contentType && item.contentType !== "other" && <span className="text-accent">{CONTENT_TYPE_INFO[item.contentType].label}</span>}
            {item.author && <span className="min-w-0 truncate">{item.author}</span>}
          </div>
          <h2 className="text-[15px] leading-snug font-medium text-pretty">{displayTitle(item)}</h2>
          {busy && <p className="text-sm text-ink-muted">{STATUS_TEXT[item.status as keyof typeof STATUS_TEXT] ?? "处理中…"}</p>}
          {failed && <p className="text-sm text-danger">{isStuck(item) ? "处理中断了，点开重试" : (item.error ?? "没处理成")}</p>}
          {!busy && !failed && item.summary && <p className="line-clamp-4 text-sm leading-relaxed text-ink-secondary">{item.summary}</p>}
          {snippet && (
            <p className="rounded-md bg-sunken px-2.5 py-2 text-xs leading-relaxed text-ink-secondary">
              <span className="text-ink-faint">
                {snippet.where}
                {snippet.at !== null ? ` ${clock(snippet.at)}` : ""}：
              </span>
              {snippet.text}
            </p>
          )}
          {item.note && <p className="border-l-2 border-accent pl-2 text-xs leading-relaxed text-ink-muted">{item.note}</p>}
          {item.tags.length > 0 && (
            <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
              {item.tags.slice(0, 6).map((t) => (
                <span key={t}>#{t}</span>
              ))}
            </p>
          )}
        </div>
      </Link>
    </article>
  );
}
