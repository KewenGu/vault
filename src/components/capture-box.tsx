"use client";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useSyncExternalStore } from "react";
import { saveAction, type ActionState } from "@/app/(app)/actions";
import { UPLOAD_ACCEPT, UPLOAD_STATUS_TEXT, uploadKey, uploadOne, type UploadState } from "./upload-files";

/**
 * 存入框：贴链接（含 App 里「复制链接」得到的那段话）或文字，或者选 / 拖 / 粘贴文件（图片、截图、视频、音频、文字文件）。
 * 「粘贴」按钮直接读剪贴板，手机上不用先点输入框、再长按出菜单。
 * 文件怎么传见 upload-files.ts。
 */

/**
 * 读剪贴板：图片（截图）当文件传，其余取文字。必须在点击里直接调用。
 * iOS 对别的 App 复制来的内容会先弹一个系统的「粘贴」气泡，点了才给内容，不点就按「没给权限」报错——这一步网页绕不开。
 */
async function readClipboard(): Promise<{ text: string; files: File[] }> {
  if (!navigator.clipboard.read) return { text: await navigator.clipboard.readText(), files: [] };
  const texts: string[] = [];
  const files: File[] = [];
  for (const item of await navigator.clipboard.read()) {
    const image = item.types.find((t) => t.startsWith("image/"));
    if (image) {
      const ext = image.slice("image/".length).split("+")[0];
      // 上传进度按文件名区分，名字里带上时间和序号
      files.push(new File([await item.getType(image)], `粘贴的图片-${Date.now()}-${files.length + 1}.${ext}`, { type: image }));
      continue;
    }
    const type = ["text/plain", "text/uri-list"].find((t) => item.types.includes(t));
    if (type) texts.push(await (await item.getType(type)).text());
  }
  return { text: texts.join("\n"), files };
}

// 剪贴板接口只在安全环境（https / localhost）里有；没有就不显示「粘贴」按钮。服务端先当作有，免得按钮晚一步冒出来把旁边的挤开
const noSubscribe = () => () => {};
const canReadClipboard = () => typeof navigator.clipboard?.readText === "function";

export function CaptureBox() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const showPaste = useSyncExternalStore(noSubscribe, canReadClipboard, () => true);
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
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
    const update = (s: UploadState) => setUploads((list) => [...list.filter((u) => u.key !== s.key), s]);
    for (const file of files) {
      await uploadOne(file, typeof note === "string" ? note : "", uploadKey(), update);
      router.refresh();
    }
  }

  async function pasteFromClipboard() {
    setPasteProblem(null);
    let clip: Awaited<ReturnType<typeof readClipboard>>;
    try {
      clip = await readClipboard();
    } catch (e) {
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      return setPasteProblem(denied ? "没读到剪贴板：要点一下系统弹出的「粘贴」，或者在浏览器里允许读取剪贴板" : "没读到剪贴板，请点输入框手动粘贴");
    }
    const text = clip.text.trim();
    if (!text && clip.files.length === 0) return setPasteProblem("剪贴板里没有文字或图片");
    const input = inputRef.current;
    // 等系统气泡的时候上一条可能刚开始存（存完会清空表单），这时不往里填
    if (text && input && !input.readOnly) input.value = input.value.trim() ? `${input.value.trimEnd()}\n${text}` : text;
    void addFiles(clip.files);
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
        ref={inputRef}
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
        <input ref={fileRef} type="file" multiple hidden accept={UPLOAD_ACCEPT} onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        {showPaste && (
          <button type="button" className="btn" disabled={pending} onClick={() => void pasteFromClipboard()}>
            粘贴
          </button>
        )}
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
      {pasteProblem && (
        <p role="status" className="text-xs text-ink-muted">
          {pasteProblem}
        </p>
      )}
      {state.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {uploads.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-ink-muted" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.key} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <span className={u.status === "error" ? "text-danger" : ""}>{u.status === "error" ? (u.message ?? UPLOAD_STATUS_TEXT.error) : UPLOAD_STATUS_TEXT[u.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
