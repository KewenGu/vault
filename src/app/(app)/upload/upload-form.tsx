"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { UPLOAD_ACCEPT, UPLOAD_STATUS_TEXT, uploadKey, uploadOne, type UploadState } from "@/components/upload-files";

/** 选文件（可以一次选几个，每个存成一条）→ 一个个传，列出每个的进度，存好的能点进去看。 */
export function UploadForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [busy, setBusy] = useState(false);

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    const note = noteRef.current?.value ?? "";
    const update = (s: UploadState) => setUploads((list) => (list.some((u) => u.key === s.key) ? list.map((u) => (u.key === s.key ? s : u)) : [...list, s]));
    const batch = files.map((file) => ({ file, key: uploadKey() }));
    // 先全部列出来（排队中），再一个个传
    setUploads((list) => [...list, ...batch.map(({ file, key }) => ({ key, name: file.name, status: "hashing" as const }))]);
    for (const { file, key } of batch) await uploadOne(file, note, key, update);
    setBusy(false);
  }

  const finished = uploads.filter((u) => u.status === "done" || u.status === "exists").length;
  const failed = uploads.filter((u) => u.status === "error").length;

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button type="button" className="btn btn-primary h-14 text-base" onClick={() => fileRef.current?.click()}>
        {uploads.length ? "再选一些" : "选择照片或文件"}
      </button>
      <p className="text-sm leading-relaxed text-ink-muted">可以一次选好几个，每个存成一条。照片、截图、视频、音频、.txt / .md 都行。</p>
      <input ref={noteRef} name="note" placeholder="备注：为什么存（可不填，选文件之前写好）" aria-label="备注" maxLength={1000} className="field" />

      {uploads.length > 0 && (
        <section className="panel flex flex-col gap-2 px-4 py-3" aria-live="polite">
          <ul className="flex flex-col gap-1.5 text-sm">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-ink-secondary">{u.name}</span>
                {u.id && (u.status === "done" || u.status === "exists") ? (
                  <Link href={`/items/${u.id}`} className="text-accent hover:underline">
                    {UPLOAD_STATUS_TEXT[u.status]}
                  </Link>
                ) : (
                  <span className={u.status === "error" ? "text-danger" : "text-ink-muted"}>{u.status === "error" ? (u.message ?? UPLOAD_STATUS_TEXT.error) : UPLOAD_STATUS_TEXT[u.status]}</span>
                )}
              </li>
            ))}
          </ul>
          {!busy && (
            <p className="border-t border-edge pt-2 text-sm text-ink-muted">
              {failed ? `存好了 ${finished} 个，${failed} 个没存成。` : `存好了 ${finished} 个，后台正在处理。`}
              <Link href="/" className="ml-1 text-accent hover:underline">
                回收藏库
              </Link>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
