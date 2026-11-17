import "server-only";
import { start } from "workflow/api";
import type { Session } from "@/lib/auth/user";
import { LinkError, resolveLink } from "@/lib/sources/link";
import { getServiceClient } from "@/lib/supabase/service";
import { processItem } from "@/workflows/process-item";
import { classifyCapture, fileDedupeKey, planUpload, textDedupeKey, titleFromFilename, uploadPath, uploadedMedia } from "./capture";
import { BUCKET, TEXT_MAX, createItem, deleteItem, getItem, inProgress, itemDir, linkDedupeKey, restartItem } from "./store";

/**
 * 存进来 / 重新处理 / 删除：页面的 server action 和 /api/v1 的接口都调这里（以后的手机 App 走接口，行为和网页一样）。
 * 能直接告诉用户的问题抛 VaultError（message 给用户看）；别的错往上抛。
 */

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/** 后台任务起不来（Workflow 运行时没连上）：这条标成失败并带上原因，不让它挂在「处理中」。 */
async function startProcessing(itemId: string): Promise<void> {
  try {
    await start(processItem, [itemId]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`后台任务没启动 item=${itemId}: ${message}`);
    const db = getServiceClient();
    await db.from("items").update({ status: "failed", error: `后台任务没启动：${message.slice(0, 300)}` }).eq("id", itemId).in("status", ["fetching", "analyzing"]);
  }
}

export type Saved = { id: string; existing: boolean };

/** 存一段粘贴的内容：链接（含 App 分享出来的那段话）或文字。已经存过同一条的回到那条，不重复处理。 */
export async function saveInput(session: Session, input: string, note = ""): Promise<Saved> {
  const capture = classifyCapture(input);
  if (!capture) throw new VaultError("没有内容：贴一条链接，或者一段文字");
  const { user, db } = session;
  let saved: Saved;
  if (capture.kind === "link") {
    let ref;
    try {
      ref = await resolveLink(capture.url);
    } catch (e) {
      if (e instanceof LinkError) throw new VaultError(e.message);
      throw e;
    }
    saved = await createItem(db, user.id, { source: "link", dedupeKey: linkDedupeKey(ref), status: "fetching", platform: ref.platform, externalId: ref.externalId, url: ref.url, note });
  } else {
    if (capture.text.length > TEXT_MAX) throw new VaultError(`文字太长（${capture.text.length.toLocaleString("en-US")} 字），一次最多 ${TEXT_MAX.toLocaleString("en-US")} 字；更长的存成 .txt 文件上传`);
    saved = await createItem(db, user.id, { source: "text", dedupeKey: textDedupeKey(capture.text), status: "fetching", kind: "text", userText: capture.text, note });
  }
  if (!saved.existing) await startProcessing(saved.id);
  return saved;
}

export type UploadTicket = Saved & { upload: { path: string; token: string } | null };

/**
 * 开始上传一个文件：建一条「等上传」的内容，发一个签名上传地址，浏览器（或 App）把文件直接传到存储桶，
 * 传完调 finishUpload。同一个文件（按 SHA-256）已经存过的回到那条（upload = null，不用再传）；
 * 上次没传完的那条重新发一个地址接着传。
 */
export async function beginUpload(session: Session, file: { name: string; mime: string; size: number; sha256: string }, note = ""): Promise<UploadTicket> {
  if (!/^[0-9a-f]{64}$/i.test(file.sha256)) throw new VaultError("文件校验值不对");
  const plan = planUpload(file);
  if ("error" in plan) throw new VaultError(plan.error);
  const { user, db } = session;
  const id = crypto.randomUUID();
  const path = uploadPath(itemDir(user.id, id), plan.ext);
  const saved = await createItem(db, user.id, {
    id,
    source: "upload",
    dedupeKey: fileDedupeKey(file.sha256),
    status: "uploading",
    kind: plan.kind,
    title: titleFromFilename(file.name),
    media: [uploadedMedia(plan.kind, path, plan.mime, file.size)],
    note,
  });
  let target = path;
  if (saved.existing) {
    const had = await getItem(db, user.id, saved.id);
    target = had?.status === "uploading" ? (had.media[0]?.path ?? "") : "";
    if (!target) return { ...saved, upload: null };
  }
  const { data, error } = await getServiceClient().storage.from(BUCKET).createSignedUploadUrl(target, { upsert: true });
  if (error || !data) throw new Error(`拿不到上传地址: ${error?.message ?? "没有返回"}`);
  return { id: saved.id, existing: false, upload: { path: target, token: data.token } };
}

/** 文件传完了：确认文件真的在，开始处理。 */
export async function finishUpload(session: Session, id: string): Promise<void> {
  const { user, db } = session;
  const item = await getItem(db, user.id, id);
  if (!item) throw new VaultError("这条内容不在了", 404);
  if (item.status !== "uploading") return; // 已经开始处理了（重复调用）
  const path = item.media[0]?.path;
  const name = path?.split("/").pop();
  const service = getServiceClient();
  const { data, error } = await service.storage.from(BUCKET).list(itemDir(user.id, id), { search: name });
  if (error) throw new Error(`检查上传的文件失败: ${error.message}`);
  if (!name || !(data ?? []).some((f) => f.name === name)) throw new VaultError("文件没有传上来，请重新上传", 409);
  await restartItem(db, user.id, id, "fetch");
  await startProcessing(id);
}

/** 重新处理：fetch = 重新读链接（换掉转存的文件和互动数）；analyze = 不重读，只重新抽帧转写 + 理解。 */
export async function reprocess(session: Session, id: string, from: "fetch" | "analyze", patch: { userText?: string } = {}): Promise<void> {
  const { user, db } = session;
  const item = await getItem(db, user.id, id);
  if (!item) throw new VaultError("这条内容不在了", 404);
  if (item.status === "uploading") throw new VaultError("文件还没传完", 409);
  if (inProgress(item)) throw new VaultError("这条正在处理中，等它结束再试", 409);
  // 上传的文件和贴的文字没有「重新读取」：原始内容就在库里
  const step = item.source === "link" ? from : "analyze";
  const userText = patch.userText?.trim();
  if (userText && userText.length > TEXT_MAX) throw new VaultError("文字太长");
  await restartItem(db, user.id, id, userText && item.source === "link" ? "fetch" : step, userText ? { userText } : {});
  await startProcessing(id);
}

export async function removeItem(session: Session, id: string): Promise<void> {
  // 删文件、清没人用的实体要 service 权限；归属由 user_id 条件保证
  try {
    await deleteItem(getServiceClient(), session.user.id, id);
  } catch (e) {
    if (e instanceof Error && e.message.includes("不在了")) throw new VaultError(e.message, 404);
    throw e;
  }
}
