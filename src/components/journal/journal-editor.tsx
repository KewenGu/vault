"use client";

import { ArrowDown, ArrowUp, AudioLines, ImagePlus, Mic, Square, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ActionState } from "@/app/(app)/actions";
import type { Result } from "@/app/(app)/journal/actions";
import { clock } from "@/lib/media/transcript";
import { createClient } from "@/lib/supabase/client";
import { JOURNAL_MAX, JOURNAL_STYLES, MOODS, SHEET_WIDTH, WEATHERS, cuesText, dayLabel, docMediaIds, type Block, type JournalStyle } from "@/lib/vault/journal-doc";
import { canMove, insertAfter, moveBlock, newBlockId, patchBlock, removeBlock, tidy } from "@/lib/vault/journal-edit";
import type { EntryDetail, EntryEdit, MediaTicket, MediaView } from "@/lib/vault/journal-service";
import { ActionForm } from "../action-form";
import { AudioPlayer } from "./audio-player";
import { useRecorder } from "./recorder";
// 两个风格用到的字体，自己托管（不连 Google Fonts）：按用到的字切成小片，浏览器只下这一页用到的那几片
import "@fontsource/zcool-kuaile/400.css";
import "lxgw-wenkai-lite-webfont/lxgwwenkailite-regular.css";
import "./sheet.css";

/**
 * 一篇日记的编辑页：中间是一页纸，直接在上面写。
 *
 * - 这一页固定 SHEET_WIDTH 宽，按屏幕等比缩放（transform）：手机和电脑上每一行断在同一个地方，以后贴纸、手绘的位置才对得上。
 * - 正文是一块接一块的：文字、照片、录音。页尾永远留着一块文字接着写（lib/vault/journal-edit.ts）。
 * - 照片 / 录音：先登记、浏览器直接传到存储桶、传完通知服务器。照片当场处理好；录音在后台转文字，这边隔几秒问一次，
 *   转好了文字出现在录音下面，点「放进正文」变成能改的一段字。
 * - 自己改的自动保存（停手不到一秒就存；切走、关页面前也存一次）。保存一次只发一个请求，带着上次看到的版本号：
 *   别处改过了就停下来说清楚，不盖掉。
 * - 风格只换纸、字体、配色、照片框（sheet.css），内容不动。
 *
 * 动作从页面传进来：都是 server action，逻辑在 lib/vault/journal-service.ts。
 */

export type JournalApi = {
  save: (id: string, edit: EntryEdit) => Promise<{ rev: number } | { error: string; conflict: boolean }>;
  beginMedia: (entryId: string, file: { name: string; mime: string; size: number }) => Promise<Result<MediaTicket>>;
  finishMedia: (mediaId: string) => Promise<Result<{ media: MediaView }>>;
  retryMedia: (mediaId: string) => Promise<Result<{ media: MediaView }>>;
  removeMedia: (mediaId: string) => Promise<{ error: string | null }>;
  listMedia: (entryId: string) => Promise<Result<{ media: MediaView[] }>>;
  remove: (prev: ActionState, formData: FormData) => Promise<ActionState>;
};

const SAVE_AFTER_MS = 900;
const POLL_MS = 3000;
const STAGE_ID = "jn-stage";

/** 这次打开页面后自己传的文件：还在浏览器手里的那一份（先拿它显示，传失败了拿它重试） */
type LocalFile = { preview: string; state: "uploading" | "error" | "done"; message?: string; file: File; target: MediaTicket["upload"] };

const blockFor = (m: Pick<MediaView, "id" | "kind">): Block => (m.kind === "image" ? { id: newBlockId(), type: "photo", media: m.id, caption: "" } : { id: newBlockId(), type: "audio", media: m.id });

/** 打开时：传上来了、但正文里没有哪一块指着的文件（传完没来得及保存就关了页面）放到页尾，不让它悄悄丢掉。 */
function adopt(detail: EntryDetail): { blocks: Block[]; adopted: number } {
  const used = new Set(docMediaIds(detail.entry.doc));
  const orphans = detail.media.filter((m) => !used.has(m.id));
  let blocks = detail.entry.doc.blocks;
  for (const m of orphans) blocks = insertAfter(blocks, null, blockFor(m));
  return { blocks: tidy(blocks), adopted: orphans.length };
}

/** 整页加载时在第一次画出来之前就把这一页缩放好（等 React 接手再缩会闪一下）；站内跳转时不会执行，由 useLayoutEffect 做。 */
function FitScript() {
  const html = `(function(){var st=document.getElementById(${JSON.stringify(STAGE_ID)}),sh=st&&st.firstElementChild;if(!sh)return;var s=st.clientWidth/${SHEET_WIDTH};sh.style.transform="scale("+s+")";st.style.height=sh.offsetHeight*s+"px"})()`;
  return <script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 跟着内容长高的输入框：背后垫一份一样的字撑高度（换风格、换字体不用重新量）。 */
function Grow({ value, onChange, className = "", ...rest }: { value: string; onChange: (v: string) => void; className?: string } & Omit<React.ComponentProps<"textarea">, "value" | "onChange" | "className">) {
  return (
    <div className={`jn-grow ${className}`} data-value={value || rest.placeholder || ""}>
      <textarea rows={1} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

function Tools({ up, down, onMove, onRemove, what }: { up: boolean; down: boolean; onMove: (dir: -1 | 1) => void; onRemove: () => void; what: string }) {
  return (
    <div className="jn-tools">
      <button type="button" disabled={!up} onClick={() => onMove(-1)} aria-label={`${what}往上挪`} title="往上挪">
        <ArrowUp size={15} aria-hidden />
      </button>
      <button type="button" disabled={!down} onClick={() => onMove(1)} aria-label={`${what}往下挪`} title="往下挪">
        <ArrowDown size={15} aria-hidden />
      </button>
      <button type="button" onClick={onRemove} aria-label={`删掉${what}`} title="删掉">
        <Trash2 size={15} aria-hidden />
      </button>
    </div>
  );
}

export function JournalEditor({ initial, api }: { initial: EntryDetail; api: JournalApi }) {
  const id = initial.entry.id;
  const [start] = useState(() => adopt(initial));
  const [title, setTitle] = useState(initial.entry.title);
  const [day, setDay] = useState(initial.entry.day);
  const [style, setStyle] = useState<JournalStyle>(initial.entry.style);
  const [mood, setMood] = useState(initial.entry.mood);
  const [weather, setWeather] = useState(initial.entry.weather);
  const [blocks, setBlocks] = useState<Block[]>(start.blocks);
  const [media, setMedia] = useState<Record<string, MediaView>>(() => Object.fromEntries(initial.media.map((m) => [m.id, m])));
  const [local, setLocal] = useState<Record<string, LocalFile>>({});
  const [picker, setPicker] = useState<"mood" | "weather" | null>(null);
  const [notice, setNotice] = useState<string | null>(start.adopted > 0 ? `有 ${start.adopted} 个传上来了、但没放进正文的文件，放到页尾了` : null);
  const [preparing, setPreparing] = useState(0);

  /** 自己改了多少次 / 存到了第几次：不相等就是有没存上的 */
  const [version, setVersion] = useState(start.adopted > 0 ? 1 : 0);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const rev = useRef(initial.entry.rev);
  const latest = useRef({ title, day, style, mood, weather, blocks, version, conflict });
  useEffect(() => {
    latest.current = { title, day, style, mood, weather, blocks, version, conflict };
  });
  const saver = useRef<{ timer: ReturnType<typeof setTimeout> | null; running: boolean; saved: number }>({ timer: null, running: false, saved: 0 });
  /** 过一会儿再存一次（saveNow 自己要用，所以经一个 ref 绕一下） */
  const again = useRef<(ms: number) => void>(() => {});

  /** 把现在的样子存上去。一次只发一个请求：上一个还没回来就等它回来再看要不要补一次（两个请求带同一个版本号，后一个会被当成「别处改过了」）。 */
  const saveNow = useCallback(async () => {
    const s = saver.current;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const snap = latest.current;
    if (s.running || snap.conflict || snap.version === s.saved) return;
    s.running = true;
    setSaving(true);
    const edit: EntryEdit = { title: snap.title, day: snap.day, style: snap.style, mood: snap.mood, weather: snap.weather, doc: { v: 1, blocks: snap.blocks, decos: initial.entry.doc.decos, strokes: initial.entry.doc.strokes }, rev: rev.current };
    const res = await api.save(id, edit).catch(() => ({ error: "没连上服务器，过一会儿自动再试", conflict: false }));
    s.running = false;
    setSaving(false);
    if ("rev" in res) {
      rev.current = res.rev;
      s.saved = snap.version;
      setSavedVersion(snap.version);
      setSaveError(null);
      // 存的这会儿又改了：补一次
      if (latest.current.version !== snap.version) again.current(SAVE_AFTER_MS);
      return;
    }
    setSaveError(res.error);
    if (res.conflict) setConflict(true);
    else again.current(8000);
  }, [api, id, initial.entry.doc.decos, initial.entry.doc.strokes]);
  useEffect(() => {
    again.current = (ms) => {
      const s = saver.current;
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => void saveNow(), ms);
    };
  }, [saveNow]);

  /** 改了：停手一会儿就存。soon = 马上存（放进 / 拿掉一个文件这种，不想等） */
  const edited = useCallback(
    (soon = false) => {
      setVersion((v) => v + 1);
      again.current(soon ? 150 : SAVE_AFTER_MS);
    },
    []
  );

  // 打开时往页尾放了没人指着的文件：存一次。切到后台（手机上切 App、关标签页）和离开这一页时：有没存的马上存
  useEffect(() => {
    if (start.adopted > 0) again.current(SAVE_AFTER_MS);
    const flush = () => {
      if (document.visibilityState === "hidden") void saveNow();
    };
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      void saveNow();
    };
  }, [saveNow, start.adopted]);

  // 这一页的缩放：宽度跟着外面的容器，高度跟着内容
  const stage = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const st = stage.current;
    const sh = sheet.current;
    if (!st || !sh) return;
    let w = -1;
    let h = -1;
    const fit = () => {
      if (st.clientWidth === w && sh.offsetHeight === h) return;
      w = st.clientWidth;
      h = sh.offsetHeight;
      const s = w / SHEET_WIDTH;
      sh.style.transform = `scale(${s})`;
      st.style.height = `${h * s}px`;
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(st);
    watch.observe(sh);
    return () => watch.disconnect();
  }, []);

  // 有录音在转文字：隔几秒问一次
  const waiting = Object.values(media).some((m) => m.status === "processing");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      const res = await api.listMedia(id).catch(() => null);
      if (res && "media" in res) setMedia((prev) => ({ ...prev, ...Object.fromEntries(res.media.map((m) => [m.id, m])) }));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, api, id]);

  // 离开时放掉浏览器手里的预览
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  /** 光标最后在哪一块：新放进来的照片 / 录音跟在它后面 */
  const focused = useRef<string | null>(null);

  const setLocalState = (mediaId: string, patch: Partial<LocalFile>) => setLocal((prev) => (prev[mediaId] ? { ...prev, [mediaId]: { ...prev[mediaId], ...patch } } : prev));

  /** 把文件传到存储桶，传完通知服务器。出错的留在页面上，可以重试。 */
  const upload = async (mediaId: string, file: File, target: MediaTicket["upload"]) => {
    setLocalState(mediaId, { state: "uploading", message: undefined });
    try {
      const { error } = await createClient().storage.from(target.bucket).uploadToSignedUrl(target.path, target.token, file, { contentType: file.type || undefined });
      if (error) throw new Error(`没传上去：${error.message}`);
      const done = await api.finishMedia(mediaId);
      if ("error" in done) throw new Error(done.error);
      setMedia((prev) => ({ ...prev, [mediaId]: done.media }));
      setLocalState(mediaId, { state: "done" });
    } catch (e) {
      setLocalState(mediaId, { state: "error", message: e instanceof Error ? e.message : "没传上去，请重试" });
    }
  };

  /** 放进几个文件（选的照片、粘贴的图、录好的音、选的音频文件）：一个一块，跟在光标所在的那一块后面。 */
  async function addFiles(files: File[]) {
    if (files.length === 0 || latest.current.conflict) return;
    setNotice(null);
    let after = focused.current;
    for (const file of files) {
      setPreparing((n) => n + 1);
      const ticket = await api.beginMedia(id, { name: file.name, mime: file.type, size: file.size }).catch(() => ({ error: "没连上服务器，请稍后重试" }));
      setPreparing((n) => n - 1);
      if ("error" in ticket) {
        setNotice(`${file.name}：${ticket.error}`);
        continue;
      }
      const m = ticket.media;
      const preview = URL.createObjectURL(file);
      previews.current.push(preview);
      const block = blockFor(m);
      const anchor = after;
      setMedia((prev) => ({ ...prev, [m.id]: m }));
      setLocal((prev) => ({ ...prev, [m.id]: { preview, state: "uploading", file, target: ticket.upload } }));
      setBlocks((prev) => insertAfter(prev, anchor, block));
      after = block.id;
      focused.current = block.id;
      edited(true);
      void upload(m.id, file, ticket.upload);
    }
  }

  const recorder = useRecorder((file) => void addFiles([file]));
  const uploading = Object.values(local).some((f) => f.state === "uploading");
  const dirty = version !== savedVersion;

  // 还有没存上的、没传完的、正在录的时候关页面 / 刷新：让浏览器问一句
  useEffect(() => {
    if (!dirty && !uploading && recorder.status === "idle") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, uploading, recorder.status]);

  const change = (run: () => void) => {
    run();
    edited();
  };

  const removeMediaBlock = async (block: Exclude<Block, { type: "text" }>, what: string) => {
    if (!window.confirm(`删掉${what}？删了找不回来。`)) return;
    const res = await api.removeMedia(block.media).catch(() => ({ error: "没连上服务器，请稍后重试" }));
    if (res.error) return setNotice(res.error);
    setBlocks((prev) => removeBlock(prev, block.id));
    setMedia((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== block.media)));
    edited(true);
  };

  const move = (blockId: string, dir: -1 | 1) => {
    setBlocks((prev) => moveBlock(prev, blockId, dir));
    edited();
  };

  const retryTranscript = async (mediaId: string) => {
    const res = await api.retryMedia(mediaId).catch(() => ({ error: "没连上服务器，请稍后重试" }));
    if ("error" in res) return setNotice(res.error);
    setMedia((prev) => ({ ...prev, [mediaId]: res.media }));
  };

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>, block: Block, index: number) => {
    // 夹在两个文件中间的空白文字块：退格拿掉它
    if (e.key === "Backspace" && block.type === "text" && block.text === "" && index < blocks.length - 1) {
      e.preventDefault();
      setBlocks((prev) => removeBlock(prev, block.id));
      edited();
    }
  };

  const tools = (block: Block, what: string): ReactNode => (
    <Tools up={canMove(blocks, block.id, -1)} down={canMove(blocks, block.id, 1)} onMove={(dir) => move(block.id, dir)} onRemove={() => block.type !== "text" && void removeMediaBlock(block, what)} what={what} />
  );

  /** 一个文件现在是什么情况，要不要给个按钮。照片和录音共用。 */
  const status = (m: MediaView | undefined, lf: LocalFile | undefined): { text: string; tone: "info" | "bad"; action?: ReactNode } | null => {
    if (lf?.state === "uploading") return { text: "上传中…", tone: "info" };
    if (lf?.state === "error")
      return {
        text: lf.message ?? "没传上去",
        tone: "bad",
        action: m && (
          <button type="button" className="jn-link" onClick={() => void upload(m.id, lf.file, lf.target)}>
            重试
          </button>
        ),
      };
    if (!m) return { text: "这个文件不在了（可能在别处删掉了）：把这一块删掉就好", tone: "bad" };
    if (m.status === "uploading") return { text: "文件还没传完（在别的设备上传的话，等它传完再刷新）", tone: "info" };
    if (m.status === "processing") return { text: "正在转成文字…可以先接着写", tone: "info" };
    if (m.status === "failed") {
      const canRetry = m.kind === "audio" && m.error !== "文件没有传完";
      return {
        text: `${m.error ?? "没处理成"}${canRetry ? "" : "：把这一块删掉重新传"}`,
        tone: "bad",
        action: canRetry && (
          <button type="button" className="jn-link" onClick={() => void retryTranscript(m.id)}>
            重新转文字
          </button>
        ),
      };
    }
    return null;
  };

  const saveText = conflict ? "没保存" : saveError ? "没保存上" : saving ? "保存中…" : dirty ? "有改动…" : "已保存";

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <Link href="/journal" prefetch={false} className="text-ink-muted hover:text-ink">
          ← 日记
        </Link>
        <input
          type="date"
          aria-label="这一篇是哪一天的"
          value={day}
          max="2199-12-31"
          onChange={(e) => {
            // 清空日期框时浏览器给的是空的：不动
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) change(() => setDay(e.target.value));
          }}
          className="field h-9 w-auto py-0"
        />
        <span className={`ml-auto text-xs ${saveError ? "text-danger" : "text-ink-faint"}`} role="status">
          {saveText}
        </span>
      </div>

      <div className="chip-row" role="group" aria-label="风格">
        {JOURNAL_STYLES.map((s) => (
          <button key={s.id} type="button" aria-pressed={style === s.id} onClick={() => style !== s.id && change(() => setStyle(s.id))} className={`chip cursor-pointer ${style === s.id ? "chip-on" : ""}`}>
            {s.label}
          </button>
        ))}
      </div>

      {(conflict || saveError) && (
        <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-danger-soft px-3 py-2 text-sm leading-relaxed text-danger">
          <span className="min-w-0 flex-1">{saveError}</span>
          {conflict && (
            <button type="button" className="btn h-8" onClick={() => window.location.reload()}>
              载入最新的
            </button>
          )}
        </p>
      )}

      <div className="-mx-4 sm:mx-0">
        <div id={STAGE_ID} ref={stage} className="jn-stage" suppressHydrationWarning>
          <article
            ref={sheet}
            className="jn-sheet"
            data-style={style}
            suppressHydrationWarning
            onPaste={(e) => {
              const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (images.length === 0) return;
              e.preventDefault();
              void addFiles(images);
            }}
          >
            <header className="jn-head">
              <div className="jn-date">{dayLabel(day, style)}</div>
              <Grow
                className="jn-title"
                value={title}
                maxLength={JOURNAL_MAX.title}
                placeholder="标题（可以不写）"
                aria-label="标题"
                onChange={(v) => change(() => setTitle(v.replace(/\n/g, " ")))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  sheet.current?.querySelector<HTMLTextAreaElement>(".jn-text textarea")?.focus();
                }}
              />
              <div className="jn-chips">
                <button type="button" className="jn-chip" data-empty={!mood} aria-expanded={picker === "mood"} onClick={() => setPicker(picker === "mood" ? null : "mood")}>
                  {mood ? `心情 ${mood}` : "＋ 心情"}
                </button>
                <button type="button" className="jn-chip" data-empty={!weather} aria-expanded={picker === "weather"} onClick={() => setPicker(picker === "weather" ? null : "weather")}>
                  {weather ? `天气 ${weather}` : "＋ 天气"}
                </button>
              </div>
              {picker && (
                <div className="jn-options" role="group" aria-label={picker === "mood" ? "选心情" : "选天气"}>
                  {(picker === "mood" ? MOODS : WEATHERS).map((option) => {
                    const on = (picker === "mood" ? mood : weather) === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        className="jn-chip"
                        aria-pressed={on}
                        onClick={() => {
                          change(() => (picker === "mood" ? setMood(on ? "" : option) : setWeather(on ? "" : option)));
                          setPicker(null);
                        }}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              )}
            </header>

            {blocks.map((block, index) => {
              if (block.type === "text") {
                return (
                  <Grow
                    key={block.id}
                    className="jn-blk jn-text"
                    value={block.text}
                    maxLength={JOURNAL_MAX.text}
                    aria-label="正文"
                    placeholder={index === blocks.length - 1 ? (blocks.length === 1 ? "今天发生了什么…" : "接着写…") : ""}
                    onFocus={() => (focused.current = block.id)}
                    onKeyDown={(e) => onTextKey(e, block, index)}
                    onChange={(v) => change(() => setBlocks((prev) => patchBlock(prev, block.id, { text: v })))}
                  />
                );
              }
              const m = media[block.media];
              const lf = local[block.media];
              const st = status(m, lf);
              if (block.type === "photo") {
                const src = lf?.preview ?? (m && m.status === "ready" ? m.url : null);
                return (
                  <div key={block.id} className="jn-blk jn-media" onFocus={() => (focused.current = block.id)}>
                    <figure className="jn-photo">
                      <div className="jn-photo-img" data-dim={st !== null}>
                        {src ? (
                          // 浏览器手里的预览、要先确认登录再跳转的签名地址：都走不了 next/image
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src} alt={block.caption || "照片"} width={m?.width ?? undefined} height={m?.height ?? undefined} />
                        ) : (
                          <div className="jn-photo-missing" />
                        )}
                        {st && (
                          <p className="jn-photo-state" data-tone={st.tone} role={st.tone === "bad" ? "alert" : "status"}>
                            {st.text} {st.action}
                          </p>
                        )}
                      </div>
                      <figcaption>
                        <Grow value={block.caption} maxLength={JOURNAL_MAX.caption} placeholder="写一句说明" aria-label="照片说明" onChange={(v) => change(() => setBlocks((prev) => patchBlock(prev, block.id, { caption: v.replace(/\n/g, " ") })))} />
                      </figcaption>
                    </figure>
                    {tools(block, "这张照片")}
                  </div>
                );
              }
              // 服务器转好了就用服务器那份（能拖进度）；还没好先放浏览器手里刚录的
              const src = m?.status === "ready" || !lf ? (m && m.status !== "uploading" ? m.url : null) : lf.preview;
              return (
                <div key={block.id} className="jn-blk jn-media" onFocus={() => (focused.current = block.id)}>
                  <div className="jn-audio">
                    {src && <AudioPlayer key={src} src={src} durationS={m?.durationS ?? null} cues={m?.cues ?? []} />}
                    {st && (
                      <p className="jn-state" data-tone={st.tone} role={st.tone === "bad" ? "alert" : "status"}>
                        {st.text} {st.action}
                      </p>
                    )}
                    {m?.status === "ready" && m.notes.length > 0 && (
                      <ul className="jn-notes">
                        {m.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                    {m?.status === "ready" && (
                      <div className="jn-audio-actions">
                        {m.cues.length > 0 && (
                          <button
                            type="button"
                            className="jn-chip"
                            onClick={() => {
                              setBlocks((prev) => insertAfter(prev, block.id, { id: newBlockId(), type: "text", text: cuesText(m.cues) }));
                              edited();
                            }}
                          >
                            放进正文
                          </button>
                        )}
                        {m.cues.length === 0 && lf?.state !== "uploading" && (
                          <button type="button" className="jn-chip" onClick={() => void retryTranscript(m.id)}>
                            重新转文字
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {tools(block, "这段录音")}
                </div>
              );
            })}
          </article>
        </div>
        <FitScript />
      </div>

      {(notice || recorder.error) && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm leading-relaxed text-warning">
          <span className="min-w-0 flex-1">{notice ?? recorder.error}</span>
          {notice && (
            <button type="button" onClick={() => setNotice(null)} aria-label="知道了" className="cursor-pointer rounded-sm p-0.5 hover:bg-surface">
              <X size={15} aria-hidden />
            </button>
          )}
        </p>
      )}

      <div className="panel sticky bottom-3 z-10 flex flex-wrap items-center gap-2 px-2.5 py-2 shadow-lg">
        {recorder.status === "recording" ? (
          <>
            <span className="flex items-center gap-2 px-1.5 text-sm tabular-nums" role="status">
              <span className="size-2.5 animate-pulse rounded-full bg-danger" aria-hidden />
              正在录 {clock(recorder.seconds)}
            </span>
            <button type="button" className="btn btn-primary ml-auto" onClick={recorder.stop}>
              <Square size={14} aria-hidden />
              录完了
            </button>
            <button type="button" className="btn btn-quiet" onClick={recorder.cancel}>
              不要了
            </button>
          </>
        ) : (
          <>
            <label className={`btn ${conflict ? "pointer-events-none opacity-50" : ""}`}>
              <ImagePlus size={15} aria-hidden />
              照片
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={conflict}
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
            <button type="button" className="btn" onClick={recorder.start} disabled={conflict || recorder.status === "starting"}>
              <Mic size={15} aria-hidden />
              {recorder.status === "starting" ? "等麦克风…" : "录音"}
            </button>
            <label className={`btn ${conflict ? "pointer-events-none opacity-50" : ""}`} title="传一个已经录好的音频文件">
              <AudioLines size={15} aria-hidden />
              音频文件
              <input
                type="file"
                accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac,.amr"
                className="sr-only"
                disabled={conflict}
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
            {preparing > 0 && <span className="text-xs text-ink-muted">准备中…</span>}
          </>
        )}
      </div>

      <nav className="flex justify-between text-sm" aria-label="翻日记">
        {initial.older ? (
          <Link href={`/journal/${initial.older}`} prefetch={false} className="btn btn-quiet">
            ← 更早的一篇
          </Link>
        ) : (
          <span />
        )}
        {initial.newer && (
          <Link href={`/journal/${initial.newer}`} prefetch={false} className="btn btn-quiet">
            更新的一篇 →
          </Link>
        )}
      </nav>

      <ActionForm action={api.remove} confirm="删掉这篇日记？照片和录音会一起删掉，找不回来。" className="self-end">
        {(pending) => (
          <>
            <input type="hidden" name="id" value={id} />
            <button className="btn btn-danger" disabled={pending}>
              {pending ? "删除中…" : "删除这篇"}
            </button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
