"use client";
import { Mic } from "lucide-react";
import type { Ref } from "react";
import { clock } from "@/lib/media/transcript";
import { HEAD } from "@/lib/vault/journal-deco";
import { dayLabel, type Block, type Deco, type JournalStyle, type Stroke } from "@/lib/vault/journal-doc";
import type { MediaView } from "@/lib/vault/journal-service";
import { Hung } from "./deco-layer";

/**
 * 一页日记只读的样子（存成图片时画的就是它）：和编辑器里的那一页同一套样式、同一个宽度，只是输入框换成了文字，
 * 挪和删的按钮、提示的灰字都没有。
 *
 * 每一块的高度要和编辑器里的一样——贴纸和笔画的位置是相对各块算的，哪一块矮了一截，挂在它上面的东西就对不上了。
 * 所以空着的标题、空着的照片说明、没选的心情天气、右边那一小列按钮，在这里都留着它们占的地方（只是不画东西）。
 */

export type SheetContent = {
  day: string;
  title: string;
  style: JournalStyle;
  mood: string;
  weather: string;
  blocks: Block[];
  decos: Deco[];
  strokes: Stroke[];
  media: Record<string, MediaView>;
  /** 这次打开页面后自己传的照片：浏览器手里的那一份（服务器那份可能还没好） */
  previews: Record<string, string>;
};

/** 录音在图上最多列这么多句（和编辑器里没展开时一样） */
const CUES_SHOWN = 8;
const noop = () => {};
/** 占一行的高度、不画东西 */
const BLANK = "​";

export function SheetView({ content, ref }: { content: SheetContent; ref?: Ref<HTMLElement> }) {
  const { day, title, style, mood, weather, blocks, decos, strokes, media, previews } = content;
  const hung = (anchor: string) => <Hung anchor={anchor} decos={decos} strokes={strokes} active={false} selected={null} onGrab={noop} onHandle={noop} onKey={noop} />;
  return (
    <article ref={ref} className="jn-sheet jn-still" data-style={style} data-mode="write">
      <header className="jn-head" data-block={HEAD}>
        <div className="jn-date">{dayLabel(day, style)}</div>
        <div className="jn-title jn-still-text">{title || BLANK}</div>
        <div className="jn-chips">
          {mood && <span className="jn-chip">心情 {mood}</span>}
          {weather && <span className="jn-chip">天气 {weather}</span>}
          {!mood && !weather && <span className="jn-chip jn-hidden">{BLANK}</span>}
        </div>
        {hung(HEAD)}
      </header>
      {blocks.map((block) => {
        if (block.type === "text") {
          return (
            <div key={block.id} className="jn-blk" data-block={block.id}>
              <div className="jn-text jn-still-text" data-blank={block.text.trim() === ""}>
                {block.text || BLANK}
                {/* 以换行结尾的字：输入框里最后还有一个空行，这里也留一行 */}
                {block.text.endsWith("\n") && BLANK}
              </div>
              {hung(block.id)}
            </div>
          );
        }
        const m = media[block.media];
        if (block.type === "photo") {
          const src = previews[block.media] ?? (m?.status === "ready" ? m.url : null);
          return (
            <div key={block.id} className="jn-blk jn-media" data-block={block.id}>
              <figure className="jn-photo">
                <div className="jn-photo-img">
                  {src ? (
                    // 浏览器手里的预览、要先确认登录再跳转的签名地址：都走不了 next/image
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={block.caption || "照片"} width={m?.width ?? undefined} height={m?.height ?? undefined} />
                  ) : (
                    <div className="jn-photo-missing" />
                  )}
                </div>
                <figcaption className="jn-still-text">{block.caption || BLANK}</figcaption>
              </figure>
              <div className="jn-tools" />
              {hung(block.id)}
            </div>
          );
        }
        const cues = m?.cues ?? [];
        return (
          <div key={block.id} className="jn-blk jn-media" data-block={block.id}>
            <div className="jn-audio">
              <div className="jn-player">
                <div className="jn-player-row">
                  <span className="jn-play">
                    <Mic size={16} aria-hidden />
                  </span>
                  <span className="jn-seek jn-still-seek" />
                  <span className="jn-time">{m?.durationS ? clock(m.durationS) : "录音"}</span>
                </div>
                {cues.length > 0 && (
                  <ul className="jn-cues">
                    {cues.slice(0, CUES_SHOWN).map((cue, i) => (
                      <li key={i}>
                        {cue.at !== null && <span className="jn-cue-at">{clock(cue.at)}</span>}
                        {cue.text}
                      </li>
                    ))}
                    {cues.length > CUES_SHOWN && <li className="jn-link">…一共 {cues.length} 句</li>}
                  </ul>
                )}
              </div>
            </div>
            <div className="jn-tools" />
            {hung(block.id)}
          </div>
        );
      })}
    </article>
  );
}
