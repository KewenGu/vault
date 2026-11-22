"use client";
import { memo, type PointerEvent } from "react";
import { strokePath } from "@/lib/vault/journal-deco";
import type { Deco, Stroke } from "@/lib/vault/journal-doc";
import { STICKERS, myStickerUrl } from "./stickers";

/**
 * 手帐层画在页面上的样子。每一块正文（含页眉）里放一个 <Hung>：挂在这一块上的笔画和贴纸，位置相对这一块的左上角，
 * 所以正文改长了它们自己跟着走，不用算。叠放：笔画在正文上面，贴纸在笔画上面（sheet.css 里的 z-index）。
 */

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 一件贴纸 / 胶带 / 艺术字本身（不管放在哪）。贴纸盘里的预览也用它。 */
export function DecoView({ kind, data }: Pick<Deco, "kind" | "data">) {
  if (kind === "sticker") {
    const emoji = str(data.emoji);
    if (emoji) return <span className="jn-emoji">{emoji}</span>;
    const sticker = STICKERS[str(data.name)];
    // 贴纸的画法是这个文件夹里写死的 SVG，不是用户给的内容
    return sticker ? <svg className="jn-sticker" viewBox="0 0 64 64" role="img" aria-label={sticker.label} dangerouslySetInnerHTML={{ __html: sticker.svg }} /> : null;
  }
  if (kind === "mine") {
    // 要先确认登录再跳转的签名地址：走不了 next/image
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="jn-mine" src={myStickerUrl(str(data.sticker))} alt="我的贴纸" draggable={false} />;
  }
  if (kind === "tape") return <span className="jn-tape" data-look={str(data.look)} role="img" aria-label="胶带" />;
  if (kind === "word")
    return (
      <span className="jn-word" data-look={str(data.look)}>
        {str(data.text)}
      </span>
    );
  return null;
}

const StrokePath = memo(function StrokePath({ stroke }: { stroke: Stroke }) {
  return <path d={strokePath(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeOpacity={stroke.opacity} strokeLinecap="round" strokeLinejoin="round" />;
});

export type HungProps = {
  anchor: string;
  decos: Deco[];
  strokes: Stroke[];
  /** 能不能碰（贴纸模式）；不能碰时只是画在那里 */
  active: boolean;
  selected: string | null;
  onGrab: (e: PointerEvent<HTMLDivElement>, deco: Deco) => void;
  onHandle: (e: PointerEvent<HTMLSpanElement>, deco: Deco) => void;
  onKey: (e: React.KeyboardEvent<HTMLDivElement>, deco: Deco) => void;
};

const what = (d: Deco) => (d.kind === "word" ? `艺术字：${str(d.data.text)}` : d.kind === "tape" ? "胶带" : d.kind === "mine" ? "我的贴纸" : `贴纸：${STICKERS[str(d.data.name)]?.label ?? str(d.data.emoji)}`);

/** 挂在一块正文上的东西。没有就什么都不画。 */
export function Hung({ anchor, decos, strokes, active, selected, onGrab, onHandle, onKey }: HungProps) {
  const mine = decos.filter((d) => d.anchor === anchor);
  const drawn = strokes.filter((s) => s.anchor === anchor);
  return (
    <>
      {drawn.length > 0 && (
        <svg className="jn-strokes" aria-hidden>
          {drawn.map((s) => (
            <StrokePath key={s.id} stroke={s} />
          ))}
        </svg>
      )}
      {mine.map((d) => (
        <div
          key={d.id}
          className="jn-deco"
          data-deco={d.id}
          data-selected={selected === d.id}
          style={{ left: d.x, top: d.y, ["--r" as string]: `${d.r}deg`, ["--s" as string]: d.s }}
          {...(active ? { tabIndex: 0, role: "button", "aria-label": what(d), "aria-pressed": selected === d.id, onPointerDown: (e: PointerEvent<HTMLDivElement>) => onGrab(e, d), onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => onKey(e, d) } : { "aria-hidden": true })}
        >
          <DecoView kind={d.kind} data={d.data} />
          {active && selected === d.id && <span className="jn-handle" onPointerDown={(e) => onHandle(e, d)} title="拖着转、放大缩小" />}
        </div>
      ))}
    </>
  );
}
