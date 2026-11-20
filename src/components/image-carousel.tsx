"use client";

import { useRef, useState } from "react";

export type CarouselImage = { src: string; width: number | null; height: number | null };

/** 画框的宽高比按第一张图定（像小红书 / Instagram），太竖或太扁的夹在这个范围里，其余的图在框里完整显示 */
const MIN_RATIO = 3 / 4;
const MAX_RATIO = 16 / 9;
/** 圆点多过这个数就只留「3 / 12」的计数 */
const MAX_DOTS = 15;

function frameRatio(images: CarouselImage[]): number {
  const first = images.find((m) => m.width && m.height);
  if (!first?.width || !first.height) return MIN_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, first.width / first.height));
}

/**
 * 详情页的多张图：一次一张，左右滑着看（CSS scroll-snap，手机上是原生的滑动手感），带计数和圆点；
 * 有鼠标的设备显示左右箭头。点图在新标签页打开原图（长图在框里会缩小，要看清点开）。
 */
export function ImageCarousel({ images }: { images: CarouselImage[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const count = images.length;

  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, Math.min(count - 1, i)) * el.clientWidth, behavior: "smooth" });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="group relative overflow-hidden rounded-lg border border-edge bg-sunken">
        <div
          ref={track}
          tabIndex={0}
          role="region"
          aria-roledescription="图片轮播"
          aria-label={`${count} 张图，左右滑动查看`}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.clientWidth > 0) setIndex(Math.round(el.scrollLeft / el.clientWidth));
          }}
          className="flex max-h-[80dvh] snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-scrollbar]:hidden"
          style={{ aspectRatio: frameRatio(images) }}
        >
          {images.map((m, i) => (
            <a
              key={m.src}
              href={m.src}
              target="_blank"
              rel="noreferrer"
              aria-label={`第 ${i + 1} 张图（共 ${count} 张），点开看原图`}
              className="flex h-full w-full shrink-0 snap-center snap-always items-center justify-center"
            >
              {/* 图是存储桶里的私有文件，走 /media 跳签名地址：用普通 img，不经 next/image 的优化服务 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.src}
                alt={`第 ${i + 1} 张图`}
                loading={i < 2 ? "eager" : "lazy"}
                width={m.width ?? undefined}
                height={m.height ?? undefined}
                draggable={false}
                className="h-full w-full object-contain"
              />
            </a>
          ))}
        </div>

        <span className="pointer-events-none absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[11px] text-white tabular-nums">
          {index + 1} / {count}
        </span>

        {index > 0 && (
          <button
            type="button"
            aria-label="上一张"
            onClick={() => go(index - 1)}
            className="absolute top-1/2 left-2 hidden size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-lg leading-none text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-fine:flex"
          >
            ‹
          </button>
        )}
        {index < count - 1 && (
          <button
            type="button"
            aria-label="下一张"
            onClick={() => go(index + 1)}
            className="absolute top-1/2 right-2 hidden size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-lg leading-none text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-fine:flex"
          >
            ›
          </button>
        )}
      </div>

      {count <= MAX_DOTS && (
        <div className="flex justify-center gap-1.5" aria-hidden>
          {images.map((m, i) => (
            <span key={m.src} className={`size-1.5 rounded-full transition-colors ${i === index ? "bg-accent" : "bg-edge-strong"}`} />
          ))}
        </div>
      )}
    </div>
  );
}
