"use client";
import { createClient } from "@/lib/supabase/client";

/**
 * 浏览器上传文件（存入框和上传页共用）：文件不经过这台服务器——先向接口要一个签名上传地址，
 * 浏览器直接传到存储桶，传完再通知开始处理。同一个文件（按 SHA-256）存过的回到那条。
 */

export type UploadStatus = "hashing" | "uploading" | "done" | "exists" | "error";
/** key：这一次上传里的编号。不用文件名区分——iPhone 从相册一次选几张，名字常常都是 image.jpg */
export type UploadState = { key: number; name: string; status: UploadStatus; id?: string; message?: string };

export const UPLOAD_STATUS_TEXT: Record<UploadStatus, string> = { hashing: "准备中…", uploading: "上传中…", done: "已存入，正在处理", exists: "之前存过了", error: "没存成" };

/** 选文件时认的类型（和 lib/vault/capture.ts 的 planUpload 对得上） */
export const UPLOAD_ACCEPT = "image/*,video/*,audio/*,.txt,.md";

let nextKey = 0;
export const uploadKey = () => ++nextKey;

async function sha256Hex(file: File): Promise<string> {
  // crypto.subtle 只在安全环境（https / localhost）里有；局域网 http 调试时退回一个随机值（就不去重了）
  if (!globalThis.crypto?.subtle) return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 传一个文件，进度通过 onState 报出来；出错的也报成 error（不抛）。 */
export async function uploadOne(file: File, note: string, key: number, onState: (s: UploadState) => void): Promise<void> {
  const base = { key, name: file.name };
  try {
    onState({ ...base, status: "hashing" });
    const sha256 = await sha256Hex(file);
    const res = await fetch("/api/v1/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, mime: file.type, size: file.size, sha256, note }),
    });
    const ticket = (await res.json().catch(() => ({}))) as { id?: string; upload?: { bucket: string; path: string; token: string } | null; error?: string };
    if (!res.ok || !ticket.id) throw new Error(ticket.error ?? "上传没开始，请重试");
    const id = ticket.id;
    if (!ticket.upload) return onState({ ...base, id, status: "exists" });
    onState({ ...base, id, status: "uploading" });
    const { error } = await createClient().storage.from(ticket.upload.bucket).uploadToSignedUrl(ticket.upload.path, ticket.upload.token, file, { contentType: file.type || undefined });
    if (error) throw new Error(`文件没传上去：${error.message}`);
    const done = await fetch(`/api/v1/uploads/${id}/complete`, { method: "POST" });
    if (!done.ok) throw new Error(((await done.json().catch(() => ({}))) as { error?: string }).error ?? "文件传上去了，但处理没开始");
    onState({ ...base, id, status: "done" });
  } catch (e) {
    onState({ ...base, status: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
