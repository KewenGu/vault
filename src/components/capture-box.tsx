"use client";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import { saveAction, type ActionState } from "@/app/(app)/actions";
import { createClient } from "@/lib/supabase/client";

/**
 * 存入框：贴链接（含 App 里「复制链接」得到的那段话）或文字，或者选 / 拖 / 粘贴文件（图片、截图、视频、音频、文字文件）。
 * 文件不经过这台服务器：先向接口要一个签名上传地址，浏览器直接传到存储桶，传完再通知开始处理。
 */

type UploadState = { name: string; status: "hashing" | "uploading" | "done" | "exists" | "error"; message?: string };

async function sha256Hex(file: File): Promise<string> {
  // crypto.subtle 只在安全环境（https / localhost）里有；局域网 http 调试时退回一个随机值（就不去重了）
  if (!globalThis.crypto?.subtle) return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadOne(file: File, note: string, onState: (s: UploadState) => void): Promise<void> {
  onState({ name: file.name, status: "hashing" });
  const sha256 = await sha256Hex(file);
  const res = await fetch("/api/v1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, mime: file.type, size: file.size, sha256, note }),
  });
  const ticket = (await res.json().catch(() => ({}))) as { id?: string; upload?: { bucket: string; path: string; token: string } | null; error?: string };
  if (!res.ok || !ticket.id) throw new Error(ticket.error ?? "上传没开始，请重试");
  if (!ticket.upload) return onState({ name: file.name, status: "exists" });
  onState({ name: file.name, status: "uploading" });
  const { error } = await createClient().storage.from(ticket.upload.bucket).uploadToSignedUrl(ticket.upload.path, ticket.upload.token, file, { contentType: file.type || undefined });
  if (error) throw new Error(`文件没传上去：${error.message}`);
  const done = await fetch(`/api/v1/uploads/${ticket.id}/complete`, { method: "POST" });
  if (!done.ok) throw new Error(((await done.json().catch(() => ({}))) as { error?: string }).error ?? "文件传上去了，但处理没开始");
  onState({ name: file.name, status: "done" });
}

const STATUS_TEXT: Record<UploadState["status"], string> = { hashing: "准备中…", uploading: "上传中…", done: "已存入，正在处理", exists: "之前存过了", error: "没存成" };

export function CaptureBox() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  // 备注默认收着：两格都摆出来时，带边框的备注格比上面的内容格更像「输入框」，分享文案会被贴错地方
  const [showNote, setShowNote] = useState(false);
  const [state, formAction, pending] = useActionState(async (prev: ActionState, formData: FormData) => {
    const next = await saveAction(prev, formData);
    if (!next.error) {
      formRef.current?.reset();
      setShowNote(false);
    }
    return next;
  }, { error: null });

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const note = new FormData(formRef.current ?? undefined).get("note");
    for (const file of files) {
      const update = (s: UploadState) => setUploads((list) => [...list.filter((u) => u.name !== s.name), s]);
      try {
        await uploadOne(file, typeof note === "string" ? note : "", update);
      } catch (e) {
        update({ name: file.name, status: "error", message: e instanceof Error ? e.message : String(e) });
      }
      router.refresh();
    }
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor="capture-input" className="sr-only">
        存入内容
      </label>
      <textarea
        id="capture-input"
        name="input"
        rows={3}
        autoFocus
        // 上一条还在存的时候不让改：存完表单会清空，这时候贴进来的下一条会被一起清掉
        readOnly={pending}
        placeholder="在这里贴链接或文字，也可以把图片 / 视频 / 音频拖进来"
        className={`field resize-y px-3.5 py-3 text-[15px] leading-relaxed transition-colors ${dragging ? "border-accent bg-accent-soft" : ""}`}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length > 0) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) formRef.current?.requestSubmit();
        }}
      />
      {showNote && <input name="note" autoFocus placeholder="备注：为什么存、打算怎么用" aria-label="备注" className="field" maxLength={1000} />}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" multiple hidden accept="image/*,video/*,audio/*,.txt,.md" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          选文件
        </button>
        <button type="button" className="btn btn-quiet" aria-expanded={showNote} onClick={() => setShowNote((v) => !v)}>
          {showNote ? "不写备注" : "加备注"}
        </button>
        <button className="btn btn-primary ml-auto min-w-20" disabled={pending}>
          {pending ? "存入中…" : "存入"}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {uploads.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-ink-muted" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.name} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <span className={u.status === "error" ? "text-danger" : ""}>{u.status === "error" ? (u.message ?? STATUS_TEXT.error) : STATUS_TEXT[u.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
