import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { ImageCarousel } from "@/components/image-carousel";
import { ItemNotes, type NotesApi } from "@/components/item-notes";
import { LocalDate } from "@/components/local-date";
import { MindMap } from "@/components/mind-map";
import { RelatedItems } from "@/components/related-items";
import { PLAYER_ID, SeekTime } from "@/components/seek-time";
import { requireSession } from "@/lib/auth/user";
import { entitiesOfItem } from "@/lib/graph/data";
import { clock, parseTranscript } from "@/lib/media/transcript";
import { POST_STAT_KEYS, formatCount, postNotes, statLabel, type ItemMedia } from "@/lib/sources/types";
import { audioOf, displayTitle, getItem, imagesOf, inProgress, isStuck, itemFileUrl, sheetsOf, sourceLabel, videoOf } from "@/lib/vault/store";
import { creatorOfItem, creatorTitle } from "@/lib/vault/creator-store";
import { VaultError } from "@/lib/vault/errors";
import { listNotesOfItem } from "@/lib/vault/note-store";
import type { ItemNote } from "@/lib/vault/notes";
import { findRelated, type Related } from "@/lib/vault/related";
import { CATEGORY_LABEL, CONTENT_TYPE_INFO, ENTITY_TYPE_INFO } from "@/lib/vault/taxonomy";
import { hasTraceMaterial } from "@/lib/vault/trace";
import { getTrace, traceRunning, type ItemTrace } from "@/lib/vault/trace-store";
import { DeleteButton, EditOwnForm, MakeMapButton, MarkOwnButton, MetaForm, PasteTextForm, ReprocessButton } from "./item-actions";
import { addNoteAction, editNoteAction, removeNoteAction } from "../../notes/actions";
import { TraceSection } from "./trace-section";

type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadItem(id: string) {
  const { user, db } = await requireSession();
  const item = UUID.test(id) ? await getItem(db, user.id, id) : null;
  return { user, db, item };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { item } = await loadItem((await params).id);
  return { title: item ? displayTitle(item) : "不在了" };
}

const notesApi: NotesApi = { add: addNoteAction, edit: editNoteAction, remove: removeNoteAction };

const STATUS_TEXT = { uploading: "等文件传上来…", fetching: "正在读取内容、转存文件…", analyzing: "正在看画面、转写、理解内容…" } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="label">{title}</h2>
      {children}
    </section>
  );
}

/**
 * 全片画面一览的标题里写几格、盖哪一段（「13 格，0:00–0:12」）：用户看到的是一格一格的画面，不是拼成的几张帧格图。
 * 2026-11-20 以前存的帧格没记格数：只写有几张帧格（重新处理就有了）。
 */
function sheetSummary(sheets: ItemMedia[]): string {
  const first = sheets[0]?.at;
  const last = sheets[sheets.length - 1]?.to;
  const range = first !== undefined && last !== undefined ? `，${clock(first)}–${clock(last)}` : "";
  const tiles = sheets.every((s) => typeof s.tiles === "number") ? sheets.reduce((n, s) => n + (s.tiles ?? 0), 0) : null;
  return tiles !== null ? `${tiles} 格${range}` : `${sheets.length} 张帧格${range}`;
}

export default async function ItemPage({ params }: Props) {
  const { id } = await params;
  const { user, db, item } = await loadItem(id);
  if (!item) notFound();
  // 从哪个博主那里存进来的（不是的、表还没建的都是 null）
  const [entities, creator] = await Promise.all([entitiesOfItem(db, user.id, id), item.source === "link" ? creatorOfItem(db, user.id, id) : null]);
  const u = item.understanding;
  // 溯源的表可能还没建（应用更新了、迁移没推）：只有那一块说明原因，别的照常显示
  let trace: ItemTrace | null = null;
  let traceUnavailable: string | null = null;
  try {
    trace = await getTrace(db, user.id, id);
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    traceUnavailable = e.message;
  }
  // 划线和批注的表可能还没建（迁移没推）：只有那一块说明原因
  let itemNotes: ItemNote[] = [];
  let notesUnavailable: string | null = null;
  try {
    itemNotes = await listNotesOfItem(db, user.id, id);
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    notesUnavailable = e.message;
  }
  const video = videoOf(item);
  const audio = audioOf(item);
  const images = imagesOf(item);
  const sheets = sheetsOf(item);
  const busy = inProgress(item);
  const stuck = isStuck(item);
  const failed = item.status === "failed" || stuck;
  // 相关的内容：这条处理好了才找（不调模型）。找的时候出错只影响这一块，别的照常显示
  let related: Related = { items: [], notes: [] };
  if (item.status === "ready") {
    try {
      related = await findRelated(db, user.id, item, entities);
    } catch (e) {
      console.error(`详情页：找相关内容出错 item=${id}: ${e instanceof Error ? e.message : String(e)}`);
      related = { items: [], notes: ["这次没能找相关的内容（出错了），刷新再试"] };
    }
  }
  const canSeek = !!(video || audio);
  const transcript = item.transcript ? parseTranscript(item.transcript) : [];
  const body = item.userText || item.post.text;
  const stats = item.platform ? POST_STAT_KEYS.filter((k) => item.post.stats[k] !== null) : [];
  const notes = [...postNotes(item.post), ...(u?.gaps ?? [])].filter((n, i, all) => all.indexOf(n) === i);

  // 这些情况是这台机器没配齐造成的（配好就能补上）；别的只是告知（平台不给评论、原片太大没存档）
  const fixable = notes.some((n) => /ffmpeg|没配|没有转写|没有口播|whisper|没下载|没导出/i.test(n));
  // 左栏放原内容；什么都没有（链接没读到、还在读）时不留一栏空白
  const hasOriginal = !!(video || audio || images.length > 0 || body);

  return (
    // data-notes-scope：这一块里选中的字能划线（components/item-notes.tsx）
    <div data-notes-scope="" className={hasOriginal ? "grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" : "mx-auto max-w-2xl"}>
      <AutoRefresh active={busy || (!!trace && traceRunning(trace))} />

      {/* 左栏：原内容 */}
      <div className={hasOriginal ? "flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start" : "hidden"}>
        {video && (
          <video id={PLAYER_ID} controls playsInline preload="metadata" poster={images[0] ? itemFileUrl(item, images[0]) : undefined} className="max-h-[70dvh] w-full rounded-lg bg-black">
            <source src={itemFileUrl(item, video)} type={video.mime} />
          </video>
        )}
        {video?.compressed && <p className="-mt-2 text-xs text-ink-faint">这是压缩过的副本（原片太大存不下）。要看原画质去原链接。</p>}
        {video?.local && <p className="-mt-2 text-xs text-ink-faint">原片太大，没有存进 Supabase，在这台服务器的磁盘上。</p>}
        {audio && (
          <audio id={PLAYER_ID} controls preload="metadata" className="w-full">
            <source src={itemFileUrl(item, audio)} type={audio.mime} />
          </audio>
        )}
        {!video && images.length === 1 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={itemFileUrl(item, images[0])} alt="图" width={images[0].width ?? undefined} height={images[0].height ?? undefined} className="w-full rounded-lg border border-edge" />
        )}
        {/* 多张图不往下铺开，做成左右滑的轮播，不然图多时要滑很久才到正文 */}
        {!video && images.length > 1 && <ImageCarousel images={images.map((m) => ({ src: itemFileUrl(item, m), width: m.width ?? null, height: m.height ?? null }))} />}
        {video && sheets.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-ink-muted hover:text-ink">全片画面一览（{sheetSummary(sheets)}）</summary>
            <div className="mt-3 flex flex-col gap-3">
              {sheets.map((m) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={m.path} src={itemFileUrl(item, m)} alt="帧格" loading="lazy" className="w-full rounded-md border border-edge" />
              ))}
            </div>
          </details>
        )}
        {!video && !audio && images.length === 0 && body && <p className="panel max-h-[60dvh] overflow-y-auto p-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">{body}</p>}
      </div>

      {/* 右栏：读懂之后的样子 */}
      <div className="flex min-w-0 flex-col gap-7">
        <header className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {/* 不预取，原因见 (app)/layout.tsx */}
            <Link href="/" prefetch={false} className="hover:text-ink">
              ← 收藏库
            </Link>
            <span>{sourceLabel(item)}</span>
            {item.author && <span>{item.author}</span>}
            {creator && (
              <Link href={`/creators/${creator.id}`} prefetch={false} className="text-accent hover:underline">
                博主：{creatorTitle(creator)}
              </Link>
            )}
            {item.post.publishedAt && (
              <span>
                发布于 <LocalDate iso={item.post.publishedAt} />
              </span>
            )}
            <span>
              存于 <LocalDate iso={item.createdAt} />
            </span>
            {item.post.durationS ? <span>{clock(item.post.durationS)}</span> : null}
          </div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance">{displayTitle(item)}</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            {item.contentType && (
              <Link href={`/?type=${item.contentType}`} className="chip chip-on">
                {CONTENT_TYPE_INFO[item.contentType].label}
              </Link>
            )}
            {item.category && (
              <Link href={`/?category=${item.category}`} className="chip">
                {CATEGORY_LABEL[item.category]}
              </Link>
            )}
            {item.tags.map((t) => (
              <Link key={t} href={`/?tag=${encodeURIComponent(t)}`} className="chip">
                #{t}
              </Link>
            ))}
          </div>
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener" className="truncate text-sm text-accent hover:underline">
              {item.url}
            </a>
          )}
          {stats.length > 0 && item.platform && <p className="text-xs text-ink-faint">{stats.map((k) => `${statLabel(item.platform!, k)} ${formatCount(item.post.stats[k])}`).join(" · ")}</p>}
        </header>

        {busy && (
          <p role="status" className="rounded-md bg-accent-soft px-3.5 py-3 text-sm text-accent">
            {STATUS_TEXT[item.status as keyof typeof STATUS_TEXT]}
            视频一般要一两分钟，页面会自己刷新。
          </p>
        )}
        {failed && (
          <div className="flex flex-col gap-3 rounded-md bg-danger-soft px-3.5 py-3">
            <p role="alert" className="text-sm text-danger">
              {stuck ? "处理中断了（后台任务没跑完）。" : (item.error ?? "没处理成。")}
            </p>
            <div className="flex flex-wrap gap-2">
              {item.status !== "uploading" && <ReprocessButton id={item.id} from={item.source === "link" ? "fetch" : "analyze"} label="重试" primary />}
              <DeleteButton id={item.id} />
            </div>
            {item.source === "link" && <PasteTextForm id={item.id} />}
          </div>
        )}
        {!failed && item.error && (
          <p role="status" className="rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning">
            {item.error}
          </p>
        )}

        {!busy && !failed && notes.length > 0 && (
          // 读取时的情况摆在结果前面：下面的概括和要点只基于读到的东西，读者得先知道这一点
          <div role="note" className="flex flex-col gap-2 rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning">
            <p className="font-medium">读这条内容时：</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {fixable && (
              <p>
                <Link href="/status" className="underline">
                  看看这台机器缺什么
                </Link>
                ，补上之后点页面底部的「重新读取链接」或「重新分析」。
              </p>
            )}
          </div>
        )}

        {u && (
          <>
            <p className="text-[15px] leading-relaxed text-ink-secondary">{u.summary}</p>

            {u.card.length > 0 && (
              <Section title={CONTENT_TYPE_INFO[u.contentType].label}>
                <dl className="panel divide-y divide-edge">
                  {u.card.map((f) => (
                    <div key={f.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3.5 py-2.5 text-sm">
                      <dt className="text-ink-muted">{f.label}</dt>
                      <dd className="leading-relaxed whitespace-pre-wrap">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            )}

            {/* 换了一份大纲（重新分析）就整个重来，不留着旧大纲的折叠状态 */}
            {u.outline.length > 0 && <MindMap key={item.processedAt} title={displayTitle(item)} nodes={u.outline} canSeek={canSeek} />}

            {u.points.length > 0 && (
              <Section title="内容要点">
                <ol className="flex flex-col gap-2.5">
                  {u.points.map((p, i) => (
                    <li key={i} data-at={p.at ?? undefined} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 text-sm leading-relaxed">
                      <span className="pt-px font-mono text-xs text-ink-faint">{p.at !== null ? <SeekTime at={p.at} label={clock(p.at)} enabled={canSeek} /> : String(i + 1).padStart(2, "0")}</span>
                      <span>{p.text}</span>
                    </li>
                  ))}
                </ol>
              </Section>
            )}

            {u.quotes.length > 0 && (
              <Section title="原话">
                <ul className="flex flex-col gap-2">
                  {u.quotes.map((q, i) => (
                    <li key={i} className="border-l-2 border-edge-strong pl-3 text-sm leading-relaxed text-ink-secondary">
                      {q}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}

        {u && !busy && !failed && (trace || hasTraceMaterial(item)) && <TraceSection itemId={item.id} itemTitle={displayTitle(item)} trace={trace} unavailable={traceUnavailable} processedAt={item.processedAt} />}

        {entities.length > 0 && (
          <Section title="提到的">
            <ul className="flex flex-wrap gap-1.5">
              {entities.map((e) => (
                <li key={e.id}>
                  <Link href={`/entities/${e.id}`} prefetch={false} title={e.about || undefined} className="chip">
                    <span className="text-ink-faint">{ENTITY_TYPE_INFO[e.type].label}</span>
                    {e.name}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <RelatedItems related={related} />

        {/* 换了一条内容就整个重来（不带着上一条没写完的批注） */}
        <ItemNotes key={item.id} itemId={item.id} initial={itemNotes} unavailable={notesUnavailable} canSeek={canSeek} api={notesApi} />

        <MetaForm id={item.id} note={item.note} tags={item.tags} />

        {transcript.length > 0 && (
          <details>
            <summary className="label cursor-pointer hover:text-ink">说的话（{item.post.transcriptFrom === "captions" ? "平台字幕" : "语音识别，可能有错字"}）</summary>
            <div className="mt-3 flex flex-col gap-2 text-sm leading-relaxed text-ink-secondary">
              {transcript.map((line, i) => (
                <p key={i} data-at={line.at ?? undefined} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                  <span className="pt-px font-mono text-xs text-ink-faint">{line.at !== null ? <SeekTime at={line.at} label={clock(line.at)} enabled={canSeek} /> : ""}</span>
                  <span>{line.text}</span>
                </p>
              ))}
            </div>
          </details>
        )}
        {u?.ocr && (
          <details>
            <summary className="label cursor-pointer hover:text-ink">图上的文字</summary>
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">{u.ocr}</p>
          </details>
        )}
        {body && (video || audio || images.length > 0) && (
          <details>
            <summary className="label cursor-pointer hover:text-ink">原文</summary>
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">{body}</p>
          </details>
        )}
        {!busy && !failed && item.source === "own" && item.userText && <EditOwnForm key={item.startedAt} id={item.id} text={item.userText} />}
        {!busy && !failed && (
          <footer className="flex flex-wrap items-center gap-2 border-t border-edge pt-5">
            <ReprocessButton id={item.id} from="analyze" label="重新分析" />
            {(item.source === "text" || item.source === "own") && <MarkOwnButton id={item.id} own={item.source !== "own"} />}
            {item.source === "link" && <ReprocessButton id={item.id} from="fetch" label="重新读取链接" />}
            {u && <MakeMapButton id={item.id} />}
            <DeleteButton id={item.id} />
            {item.costUsd > 0 && <span className="ml-auto text-xs text-ink-faint">处理花费约 ${item.costUsd.toFixed(3)}</span>}
          </footer>
        )}
      </div>
    </div>
  );
}
