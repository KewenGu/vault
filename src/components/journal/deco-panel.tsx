"use client";
import { BringToFront, Eraser, Highlighter, PenLine, Plus, RotateCcw, RotateCw, Trash2, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState } from "react";
import type { Result } from "@/app/(app)/journal/actions";
import { WORD_MAX, cleanWord, type DecoPatch } from "@/lib/vault/journal-deco";
import { JOURNAL_STYLES, type Deco, type JournalStyle } from "@/lib/vault/journal-doc";
import type { StickerTicket, StickerView } from "@/lib/vault/journal-service";
import { createClient } from "@/lib/supabase/client";
import { DecoView } from "./deco-layer";
import { COMMON_PENS, EMOJI, PACKS, PENS, PEN_WIDTHS } from "./stickers";

/**
 * 页面底下那一栏在「贴纸」「画笔」两种模式下的内容。
 * 贴纸：选中了一件就是它的操作（转、放大缩小、拿到最上面、拿掉；艺术字能改字换样子），下面是贴纸盘——
 * 一个风格一包（先开当前风格的）、表情、我的贴纸（自己传的透明底图片）、胶带、艺术字。点一下就贴到页面上看得见的地方的中间。
 * 画笔：钢笔 / 荧光笔 / 橡皮、颜色、粗细、撤销。
 */

export type StickerApi = {
  list: () => Promise<Result<{ stickers: StickerView[] }>>;
  begin: (file: { name: string; mime: string; size: number }) => Promise<Result<StickerTicket>>;
  finish: (id: string) => Promise<Result<{ sticker: StickerView }>>;
  remove: (id: string) => Promise<{ error: string | null }>;
};

type Tab = JournalStyle | "emoji" | "mine" | "tape" | "word";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const OFFLINE = { error: "没连上服务器，请稍后重试" };

/** 把一张图片传成「我的贴纸」。出错返回 `{ error }`。 */
export async function uploadSticker(api: StickerApi, file: File): Promise<Result<{ sticker: StickerView }>> {
  const ticket = await api.begin({ name: file.name, mime: file.type, size: file.size }).catch(() => OFFLINE);
  if ("error" in ticket) return ticket;
  const { error } = await createClient().storage.from(ticket.upload.bucket).uploadToSignedUrl(ticket.upload.path, ticket.upload.token, file, { contentType: file.type || undefined });
  if (error) {
    void api.remove(ticket.id).catch(() => {});
    return { error: `没传上去：${error.message}` };
  }
  return api.finish(ticket.id).catch(() => OFFLINE);
}

function Looks({ value, onPick, kind }: { value: string; onPick: (look: JournalStyle) => void; kind: "tape" | "word" }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={kind === "tape" ? "胶带的样子" : "艺术字的样子"}>
      {JOURNAL_STYLES.map((s) => (
        <button key={s.id} type="button" aria-pressed={value === s.id} onClick={() => onPick(s.id)} className={`chip cursor-pointer ${value === s.id ? "chip-on" : ""}`}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

function Selected({ deco, onPatch, onRemove, onRaise, onDone }: { deco: Deco; onPatch: (patch: DecoPatch) => void; onRemove: () => void; onRaise: () => void; onDone: () => void }) {
  const icon = "btn h-9 w-9 px-0";
  return (
    <div className="flex flex-col gap-2 border-b border-edge pb-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={icon} onClick={() => onPatch({ r: deco.r - 15 })} aria-label="向左转" title="向左转">
          <RotateCcw size={15} aria-hidden />
        </button>
        <button type="button" className={icon} onClick={() => onPatch({ r: deco.r + 15 })} aria-label="向右转" title="向右转">
          <RotateCw size={15} aria-hidden />
        </button>
        <button type="button" className={icon} onClick={() => onPatch({ s: deco.s / 1.2 })} aria-label="缩小" title="缩小">
          <ZoomOut size={15} aria-hidden />
        </button>
        <button type="button" className={icon} onClick={() => onPatch({ s: deco.s * 1.2 })} aria-label="放大" title="放大">
          <ZoomIn size={15} aria-hidden />
        </button>
        <button type="button" className={icon} onClick={onRaise} aria-label="拿到最上面" title="拿到最上面">
          <BringToFront size={15} aria-hidden />
        </button>
        <button type="button" className="btn btn-danger h-9" onClick={onRemove}>
          <Trash2 size={15} aria-hidden />
          拿掉
        </button>
        <button type="button" className="btn btn-quiet ml-auto h-9" onClick={onDone}>
          好了
        </button>
      </div>
      {deco.kind === "word" && (
        <>
          <input className="field" aria-label="艺术字的字" maxLength={WORD_MAX} value={str(deco.data.text)} onChange={(e) => onPatch({ data: { text: cleanWord(e.target.value) } })} />
          <Looks kind="word" value={str(deco.data.look)} onPick={(look) => onPatch({ data: { look } })} />
        </>
      )}
      {deco.kind === "tape" && <Looks kind="tape" value={str(deco.data.look)} onPick={(look) => onPatch({ data: { look } })} />}
    </div>
  );
}

export function DecoPanel({
  style,
  selected,
  onAdd,
  onPatch,
  onRemove,
  onRaise,
  onDone,
  stickers,
  onNotice,
}: {
  style: JournalStyle;
  selected: Deco | null;
  onAdd: (kind: Deco["kind"], data: Deco["data"]) => void;
  onPatch: (patch: DecoPatch) => void;
  onRemove: () => void;
  onRaise: () => void;
  onDone: () => void;
  stickers: StickerApi;
  onNotice: (text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(style);
  const [emoji, setEmoji] = useState("");
  const [word, setWord] = useState("");
  const [look, setLook] = useState<JournalStyle>(style);
  /** 我的贴纸：null = 还没读 */
  const [mine, setMine] = useState<StickerView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);

  // 第一次点开「我的」才去读
  useEffect(() => {
    if (tab !== "mine" || mine !== null) return;
    let gone = false;
    void stickers
      .list()
      .catch(() => OFFLINE)
      .then((res) => {
        if (gone) return;
        if ("error" in res) return onNotice(res.error);
        setMine(res.stickers);
      });
    return () => {
      gone = true;
    };
  }, [tab, mine, stickers, onNotice]);

  const addMine = async (files: File[]) => {
    setBusy(true);
    for (const file of files) {
      const res = await uploadSticker(stickers, file);
      if ("error" in res) onNotice(`${file.name}：${res.error}`);
      else {
        setMine((prev) => [res.sticker, ...(prev ?? []).filter((s) => s.id !== res.sticker.id)]);
        onAdd("mine", { sticker: res.sticker.id });
      }
    }
    setBusy(false);
  };

  const removeMine = async (id: string) => {
    if (!window.confirm("从「我的贴纸」里删掉这张？已经贴在日记上的也会看不到。")) return;
    const res = await stickers.remove(id).catch(() => OFFLINE);
    if (res.error) return onNotice(res.error);
    setMine((prev) => (prev ?? []).filter((s) => s.id !== id));
  };

  const tabs: { id: Tab; label: string }[] = [...[...PACKS].sort((a, b) => Number(b.id === style) - Number(a.id === style)).map((p) => ({ id: p.id as Tab, label: p.label })), { id: "emoji", label: "表情" }, { id: "mine", label: "我的" }, { id: "tape", label: "胶带" }, { id: "word", label: "艺术字" }];
  const pack = PACKS.find((p) => p.id === tab);
  const cell = "jn-tray-cell";

  return (
    <div className="flex w-full flex-col gap-2">
      {selected && <Selected deco={selected} onPatch={onPatch} onRemove={onRemove} onRaise={onRaise} onDone={onDone} />}
      <div className="chip-row" role="tablist" aria-label="贴纸盘">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`chip cursor-pointer ${tab === t.id ? "chip-on" : ""}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="jn-tray" role="tabpanel">
        {pack?.names.map((name) => (
          <button key={name} type="button" className={cell} onClick={() => onAdd("sticker", { name })} aria-label={`贴一张`}>
            <DecoView kind="sticker" data={{ name }} />
          </button>
        ))}
        {tab === "emoji" && (
          <>
            {EMOJI.map((e) => (
              <button key={e} type="button" className={cell} onClick={() => onAdd("sticker", { emoji: e })} aria-label={`贴 ${e}`}>
                <DecoView kind="sticker" data={{ emoji: e }} />
              </button>
            ))}
            <form
              className="flex shrink-0 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const one = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji.trim()), (s) => s.segment)[0];
                if (!one) return;
                onAdd("sticker", { emoji: one });
                setEmoji("");
              }}
            >
              <input className="field h-9 w-24" aria-label="别的表情" placeholder="别的表情" value={emoji} maxLength={16} onChange={(e) => setEmoji(e.target.value)} />
              <button className="btn h-9">贴</button>
            </form>
          </>
        )}
        {tab === "mine" && (
          <>
            <label className={`${cell} cursor-pointer border-dashed ${busy ? "pointer-events-none opacity-50" : ""}`} title="传一张图片当贴纸（透明底的 PNG 最好）">
              <Plus size={18} aria-hidden />
              <span className="sr-only">传一张贴纸</span>
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  void addMine(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
            {mine === null && <span className="self-center text-xs text-ink-muted">读取中…</span>}
            {mine?.length === 0 && !busy && <span className="self-center text-xs leading-relaxed text-ink-muted">还没有。点左边传一张图片（透明底的 PNG 最好；iPhone 相册里长按抠出来的主体，也可以直接粘贴到页面上）。</span>}
            {busy && <span className="self-center text-xs text-ink-muted">上传中…</span>}
            {mine?.map((s) => (
              <span key={s.id} className="relative shrink-0">
                <button type="button" className={cell} onClick={() => onAdd("mine", { sticker: s.id })} aria-label="贴这张我的贴纸">
                  <DecoView kind="mine" data={{ sticker: s.id }} />
                </button>
                {managing && (
                  <button type="button" onClick={() => void removeMine(s.id)} aria-label="从我的贴纸里删掉" className="absolute -top-1 -right-1 grid size-5 cursor-pointer place-items-center rounded-full bg-danger text-on-accent">
                    <X size={12} aria-hidden />
                  </button>
                )}
              </span>
            ))}
            {(mine?.length ?? 0) > 0 && (
              <button type="button" className="btn btn-quiet h-9 shrink-0 self-center" onClick={() => setManaging(!managing)}>
                {managing ? "好了" : "整理"}
              </button>
            )}
          </>
        )}
        {tab === "tape" &&
          JOURNAL_STYLES.map((s) => (
            <button key={s.id} type="button" className={`${cell} w-28`} onClick={() => onAdd("tape", { look: s.id })} aria-label={`贴一段${s.label}的胶带`}>
              <DecoView kind="tape" data={{ look: s.id }} />
            </button>
          ))}
        {tab === "word" && (
          <form
            className="flex w-full flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = cleanWord(word).trim();
              if (!text) return;
              onAdd("word", { text, look });
              setWord("");
            }}
          >
            <div className="flex gap-2">
              <input className="field min-w-0 flex-1" aria-label="艺术字写什么" placeholder="写几个字，比如「今日份的风」" maxLength={WORD_MAX} value={word} onChange={(e) => setWord(e.target.value)} />
              <button className="btn btn-primary" disabled={!word.trim()}>
                贴上
              </button>
            </div>
            <Looks kind="word" value={look} onPick={setLook} />
          </form>
        )}
      </div>
    </div>
  );
}

export type Pen = { tool: "pen" | "marker" | "eraser"; color: string; width: (typeof PEN_WIDTHS)[number]["id"] };

export function DrawPanel({ style, pen, onPen, canUndo, onUndo }: { style: JournalStyle; pen: Pen; onPen: (pen: Pen) => void; canUndo: boolean; onUndo: () => void }) {
  const tools = [
    { id: "pen", label: "钢笔", Icon: PenLine },
    { id: "marker", label: "荧光笔", Icon: Highlighter },
    { id: "eraser", label: "橡皮", Icon: Eraser },
  ] as const;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label="笔">
          {tools.map(({ id, label, Icon }) => (
            <button key={id} type="button" aria-pressed={pen.tool === id} onClick={() => onPen({ ...pen, tool: id })} className={`chip h-9 cursor-pointer ${pen.tool === id ? "chip-on" : ""}`}>
              <Icon size={14} aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn ml-auto h-9" onClick={onUndo} disabled={!canUndo}>
          <Undo2 size={15} aria-hidden />
          撤销一笔
        </button>
      </div>
      {pen.tool !== "eraser" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex gap-2" role="group" aria-label="颜色">
            {[...PENS[style], ...COMMON_PENS].map((color) => (
              <button key={color} type="button" aria-pressed={pen.color === color} aria-label={`颜色 ${color}`} onClick={() => onPen({ ...pen, color })} className="jn-swatch" style={{ background: color }} />
            ))}
          </div>
          <div className="flex gap-1.5" role="group" aria-label="粗细">
            {PEN_WIDTHS.map((w) => (
              <button key={w.id} type="button" aria-pressed={pen.width === w.id} onClick={() => onPen({ ...pen, width: w.id })} className={`chip cursor-pointer ${pen.width === w.id ? "chip-on" : ""}`}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-ink-faint">{pen.tool === "eraser" ? "在一笔上划过去就擦掉这一笔。" : "直接在页面上画。"}手机上用两根手指滑动来翻页；用手写笔时手指只翻页、不会画上去。</p>
    </div>
  );
}
