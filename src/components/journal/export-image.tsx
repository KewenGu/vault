"use client";
import { Download, Share2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SHEET_WIDTH } from "@/lib/vault/journal-doc";
import { SheetView, type SheetContent } from "./sheet-view";

/**
 * 把一页日记存成图片。在页面外面（看不见的地方）按 360 宽画一份只读的（SheetView），等字体和照片都好了，
 * 用 modern-screenshot 把这块 DOM 画成 PNG（原理：把 DOM 连同样式塞进一张 SVG 的 foreignObject 里，再画到画布上）。
 * 放大 3 倍出图：360 宽的一页是 1080 像素宽。出来之后给一张预览，可以存到本机、可以交给系统的分享（手机上存进相册、发给别的 App）。
 *
 * 照片和「我的贴纸」是从存储桶的签名地址读的（跨域）：读不到的那一张在图上是空的，不会让整张图出不来。
 * 这个库只在点了「存成图片」之后才加载。
 */

const SCALE = 3;

type Made = { url: string; file: File };

async function render(node: HTMLElement, name: string): Promise<Made> {
  const { domToBlob } = await import("modern-screenshot");
  await document.fonts.ready;
  // 照片还在加载的等一等（最多几秒；坏掉的不等）
  await Promise.all(
    Array.from(node.querySelectorAll("img")).map((img) =>
      img.complete
        ? null
        : new Promise<void>((done) => {
            const timer = setTimeout(done, 8000);
            const over = () => {
              clearTimeout(timer);
              done();
            };
            img.addEventListener("load", over, { once: true });
            img.addEventListener("error", over, { once: true });
          })
    )
  );
  const blob = await domToBlob(node, { scale: SCALE, type: "image/png", timeout: 30_000 });
  if (!blob) throw new Error("没有画出来");
  return { url: URL.createObjectURL(blob), file: new File([blob], name, { type: "image/png" }) };
}

export function ExportImage({ content, name, onClose }: { content: SheetContent; name: string; onClose: () => void }) {
  const sheet = useRef<HTMLElement>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    const node = sheet.current;
    if (!node) return;
    let gone = false;
    let url: string | null = null;
    render(node, name)
      .then((m) => {
        url = m.url;
        if (gone) return URL.revokeObjectURL(m.url);
        setMade(m);
        setCanShare(typeof navigator.canShare === "function" && navigator.canShare({ files: [m.file] }));
      })
      .catch((e: unknown) => {
        console.error("存成图片出错:", e);
        if (!gone) setError("没能画成图片。可以换个浏览器试试，或者直接截屏。");
      });
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
    // 打开的那一刻的内容画一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const share = async () => {
    if (!made) return;
    // 取消分享会抛 AbortError：不算出错
    await navigator.share({ files: [made.file] }).catch(() => {});
  };

  return (
    <>
      {/* 画图用的那一份：放在屏幕外面，不缩放 */}
      <div aria-hidden style={{ position: "fixed", left: -10_000, top: 0, width: SHEET_WIDTH, pointerEvents: "none" }}>
        <SheetView content={content} ref={sheet} />
      </div>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label="存成图片" onClick={onClose}>
        <div className="panel flex max-h-full w-full max-w-sm flex-col gap-3 overflow-hidden p-3 shadow-lg" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">存成图片</h2>
            <button type="button" className="btn btn-quiet h-8 w-8 px-0" onClick={onClose} aria-label="关掉">
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="min-h-40 flex-1 overflow-y-auto rounded-md bg-sunken">
            {made ? (
              // 刚画出来的图，在浏览器手里
              // eslint-disable-next-line @next/next/no-img-element
              <img src={made.url} alt="这一页日记的图片" className="block w-full" />
            ) : (
              <p className="px-4 py-14 text-center text-sm text-ink-muted" role={error ? "alert" : "status"}>
                {error ?? "正在画…"}
              </p>
            )}
          </div>
          {made && (
            <div className="flex flex-wrap items-center gap-2">
              <a href={made.url} download={name} className="btn btn-primary">
                <Download size={15} aria-hidden />
                存到本机
              </a>
              {canShare && (
                <button type="button" className="btn" onClick={() => void share()}>
                  <Share2 size={15} aria-hidden />
                  分享 / 存进相册
                </button>
              )}
              <span className="text-xs text-ink-faint">手机上也可以长按图片保存</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
