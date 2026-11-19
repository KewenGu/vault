"use client";
import Link from "next/link";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { savePageAction } from "@/app/(app)/actions";
import { ActionForm } from "@/components/action-form";
import { decodeCaptureHash, type HashCapture } from "@/lib/vault/page-capture";

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/**
 * 快捷指令「存入 Vault（网页）」打开的是 `/share#page=…`：内容在 # 片段里，服务器看不到，只能在这里解开（见 lib/vault/page-capture.ts）。
 * 片段里没有网页内容时显示 fallback（「没有收到要存的内容」）。
 */
export function CaptureForm({ fallback }: { fallback: ReactNode }) {
  // null = 服务器渲染（看不到片段）
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const got: HashCapture | undefined = useMemo(() => (hash === null ? undefined : decodeCaptureHash(hash)), [hash]);

  // undefined = 还没在浏览器里读到片段
  if (got === undefined) return <p className="panel px-5 py-10 text-center text-sm text-ink-muted">读取中…</p>;
  if (got === null) return <>{fallback}</>;
  if (got.kind !== "page") {
    return (
      <p role="alert" className="panel px-5 py-10 text-center text-sm text-danger">
        {got.kind === "error" ? `在 Safari 里读这个网页时出错了：${got.message}` : "收到了网页的内容，但不完整，解不开（文章太长时地址可能被截断）。把正文复制下来贴进来存。"}
        <Link href="/" className="ml-1 text-accent hover:underline">
          回收藏库
        </Link>
      </p>
    );
  }

  const { capture } = got;
  const host = new URL(capture.url).hostname;
  const chars = Array.from(capture.text).length;
  return (
    <ActionForm action={savePageAction} className="flex flex-col gap-3">
      {(pending) => (
        <>
          <input type="hidden" name="page" value={JSON.stringify(capture)} />
          <div className="panel flex flex-col gap-1.5 px-4 py-3">
            <p className="text-sm font-medium">{capture.title || host}</p>
            <p className="text-xs text-ink-muted">
              {[capture.site || host, capture.author && capture.author !== capture.site ? capture.author : "", capture.publishedAt ? capture.publishedAt.slice(0, 10) : ""].filter(Boolean).join(" · ")}
            </p>
            <p className="line-clamp-4 text-sm leading-relaxed text-ink-secondary">{capture.text || capture.description}</p>
            <p className="text-xs text-ink-faint">
              在 Safari 里读到正文 {chars.toLocaleString("en-US")} 字{capture.images.length ? `、配图 ${capture.images.length} 张` : ""}
              {!capture.text && "（没读到正文，只有简介）"}
            </p>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="label">备注</span>
            <input name="note" placeholder="为什么存（可不填）" maxLength={1000} className="field" autoFocus />
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={pending}>
              {pending ? "存入中…" : "存入"}
            </button>
            <Link href="/" className="btn btn-quiet">
              取消
            </Link>
          </div>
        </>
      )}
    </ActionForm>
  );
}
