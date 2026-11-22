import "server-only";
import { start } from "workflow/api";
import type { Session } from "@/lib/auth/user";
import { archiveImage } from "@/lib/media/files";
import { getServiceClient } from "@/lib/supabase/service";
import { processJournalAudio } from "@/workflows/process-journal-audio";
import { UPLOAD_MAX_BYTES } from "./capture";
import { stickerImage } from "./journal-sticker-image";
import { VaultError } from "./errors";
import {
  JOURNAL_MAX,
  buildJournalSearchText,
  cleanDay,
  cleanDoc,
  cleanJournalTitle,
  cleanMonth,
  cleanMood,
  cleanStyle,
  cleanWeather,
  docMediaIds,
  excerpt,
  isBlankDoc,
  lookBackDays,
  monthRange,
  planJournalUpload,
  searchTerms,
  snippet,
  transcriptCues,
  type Cue,
  type JournalStyle,
} from "./journal-doc";
import {
  createEntry,
  deleteEntry,
  deleteMedia,
  deleteSticker,
  entriesBetween,
  entriesOnDays,
  getSticker,
  insertSticker,
  listStickers,
  readySticker,
  type JournalSticker,
  entriesOfDay,
  getEntry,
  getMedia,
  insertMedia,
  journalDir,
  lastStyle,
  listEntries,
  listMedia,
  listMediaOf,
  neighbors,
  updateEntry,
  updateMedia,
  type EntryPatch,
  type JournalEntry,
  type JournalMedia,
  type MediaKind,
  type MediaStatus,
} from "./journal-store";
import { isUuid } from "./map-nodes";
import { BUCKET, STUCK_MS } from "./store";

/**
 * 日记本：新建 / 保存 / 翻 / 搜 / 删，往一篇里放照片和录音。页面的 server action 和 /api/v1/journal 的接口都调这里
 * （和 service.ts 一样：以后的手机 App 走接口，行为和网页一样）。能直接告诉用户的问题抛 VaultError。
 *
 * 日记不进知识图谱，也不交给 Claude 读：只有录音会发给语音识别转成文字（走哪一家见 lib/vault/speech.ts）。
 */

const NOT_FOUND = "这篇日记不在了";
const MEDIA_NOT_FOUND = "这个文件不在了";
export const PAGE_SIZE = 60;
/** 浏览器开始传一个文件之后，这么久还没传完就按没传成算（页面关了、网断了） */
const UPLOAD_STUCK_MS = 15 * 60_000;

/** 页面上的一个文件：照片或录音。url 带着版本号（文件换过格式之后地址跟着变，浏览器不会拿旧的）。 */
export type MediaView = {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  error: string | null;
  url: string;
  width: number | null;
  height: number | null;
  durationS: number | null;
  /** 录音转出来的一句句话（带时间） */
  cues: Cue[];
  /** 没做成 / 没看到的：没识别出说话、只转了前 60 分钟、这台机器没有 ffmpeg… */
  notes: string[];
};

export type EntrySummary = {
  id: string;
  day: string;
  title: string;
  style: JournalStyle;
  mood: string;
  weather: string;
  /** 正文开头的一句；搜索时是找到的那一段 */
  excerpt: string;
  photos: number;
  audios: number;
  /** 第一张照片（列表上的小图） */
  cover: string | null;
  updatedAt: string;
};

export type EntryDetail = { entry: Omit<JournalEntry, "searchText">; media: MediaView[]; older: string | null; newer: string | null };

export const mediaUrl = (m: Pick<JournalMedia, "id" | "updatedAt">) => `/media/journal/${m.id}?v=${Date.parse(m.updatedAt) || 0}`;

/** 数据库里的一行 → 页面上的样子。处理 / 上传拖了太久的按没成算，说清楚怎么办。 */
export function toMediaView(m: JournalMedia, now = Date.now()): MediaView {
  const waited = now - (Date.parse(m.startedAt) || now);
  let status = m.status;
  let error = m.error;
  if (m.status === "processing" && waited > STUCK_MS) {
    status = "failed";
    error = "转文字中断了（服务重启过或跑太久）";
  } else if (m.status === "uploading" && waited > UPLOAD_STUCK_MS) {
    status = "failed";
    error = "文件没有传完";
  }
  return { id: m.id, kind: m.kind, status, error, url: mediaUrl(m), width: m.width, height: m.height, durationS: m.durationS, cues: transcriptCues(m.transcript), notes: m.notes };
}

/** 给页面的一篇：搜索用的那一大段文字不带（正文里都有）。 */
const strip = ({ id, day, title, style, mood, weather, doc, rev, createdAt, updatedAt }: JournalEntry): EntryDetail["entry"] => ({ id, day, title, style, mood, weather, doc, rev, createdAt, updatedAt });

/** 列表上的一条条：摘要（搜索时是找到的那一段）、这一页上放着几张照片几段录音、封面。 */
async function summarize(session: Session, entries: JournalEntry[], terms: string[] = []): Promise<EntrySummary[]> {
  const media = await listMediaOf(
    session.db,
    session.user.id,
    entries.map((e) => e.id)
  );
  return entries.map((e): EntrySummary => {
    const mine = new Map(media.filter((m) => m.entryId === e.id).map((m) => [m.id, m]));
    // 只数这一页上真的放着的（传了一半没放进去的不算）
    const used = docMediaIds(e.doc).flatMap((id) => mine.get(id) ?? []);
    const cover = used.find((m) => m.kind === "image" && m.status === "ready");
    return {
      id: e.id,
      day: e.day,
      title: e.title,
      style: e.style,
      mood: e.mood,
      weather: e.weather,
      excerpt: (terms.length > 0 ? snippet(e.searchText, terms) : null) ?? excerpt(e.doc),
      photos: used.filter((m) => m.kind === "image").length,
      audios: used.filter((m) => m.kind === "audio").length,
      cover: cover ? mediaUrl(cover) : null,
      updatedAt: e.updatedAt,
    };
  });
}

/** 日记列表，日期新的在前。q = 搜索：标题、正文、照片说明、录音里说的话，按空白拆开的每个词都出现才算。 */
export async function listMyEntries(session: Session, opts: { q?: string; page?: number } = {}): Promise<{ entries: EntrySummary[]; more: boolean; terms: string[] }> {
  const { user, db } = session;
  const terms = searchTerms(opts.q ?? "");
  const page = Number.isInteger(opts.page) && opts.page! > 0 ? opts.page! : 0;
  const { entries, more } = await listEntries(db, user.id, { terms, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
  return { entries: await summarize(session, entries, terms), more, terms };
}

/** 一个月的日记（月历用），日期早的在前。month 是 YYYY-MM。 */
export async function listMonth(session: Session, month: unknown): Promise<EntrySummary[]> {
  const clean = cleanMonth(month);
  if (!clean) throw new VaultError("月份不对：要 YYYY-MM 这样的");
  const { from, to } = monthRange(clean);
  return summarize(session, await entriesBetween(session.db, session.user.id, from, to));
}

export type LookBack = { label: string; entry: EntrySummary };

/** 「那年今日」：一个月前、半年前、往年的今天写过的日记，近的在前。today = 看的人当地的今天（浏览器给）。 */
export async function lookBack(session: Session, today: unknown): Promise<LookBack[]> {
  const day = cleanDay(today);
  if (!day) throw new VaultError("日期不对：要 YYYY-MM-DD 这样的");
  const days = lookBackDays(day);
  const labelOf = new Map(days.map((d) => [d.day, d.label]));
  const entries = await entriesOnDays(
    session.db,
    session.user.id,
    days.map((d) => d.day)
  );
  return (await summarize(session, entries)).map((entry) => ({ label: labelOf.get(entry.day) ?? "", entry }));
}

/**
 * 开一篇新的。day = 写的人当地的日期（浏览器给）。这一天最后那篇还是空白的（点了「写一篇」没写就走了）就回到它，不再多开一篇。
 * 风格接着用最近动过的那一篇的。
 */
export async function createEntryFor(session: Session, input: { day: unknown; style?: unknown }): Promise<string> {
  const { user, db } = session;
  const day = cleanDay(input.day);
  if (!day) throw new VaultError("日期不对：要 YYYY-MM-DD 这样的");
  const last = (await entriesOfDay(db, user.id, day)).at(-1);
  if (last && !last.title && isBlankDoc(last.doc) && (await listMedia(db, user.id, last.id)).length === 0) return last.id;
  const style = input.style === undefined ? ((await lastStyle(db, user.id)) ?? cleanStyle(undefined)) : cleanStyle(input.style);
  return createEntry(db, user.id, { day, style });
}

/** 一篇日记、它的文件、往前往后翻到哪一篇。 */
export async function getEntryDetail(session: Session, id: string): Promise<EntryDetail> {
  const { user, db } = session;
  const entry = isUuid(id) ? await getEntry(db, user.id, id) : null;
  if (!entry) throw new VaultError(NOT_FOUND, 404);
  const [media, around] = await Promise.all([listMedia(db, user.id, id), neighbors(db, user.id, entry)]);
  return { entry: strip(entry), media: media.map((m) => toMediaView(m)), ...around };
}

export type EntryEdit = { title?: unknown; day?: unknown; style?: unknown; mood?: unknown; weather?: unknown; doc?: unknown; rev?: unknown };

/**
 * 保存自己改的（只改给了的）。rev = 改之前看到的版本号：这篇在别处（另一台设备、另一个标签页）改过了就不盖掉，抛 409。
 * 不给 rev 就直接按现在的版本存。返回新的版本号。
 */
export async function saveEntry(session: Session, id: string, edit: EntryEdit): Promise<{ rev: number }> {
  const { user, db } = session;
  const had = isUuid(id) ? await getEntry(db, user.id, id) : null;
  if (!had) throw new VaultError(NOT_FOUND, 404);
  const rev = edit.rev === undefined ? had.rev : Number(edit.rev);
  const conflict = () => new VaultError("这篇日记在别处改过了（另一台设备或另一个标签页）：这边没存上的改动先自己留一份，再刷新看最新的", 409);
  if (rev !== had.rev) throw conflict();
  const patch: EntryPatch = {};
  if (edit.day !== undefined) {
    const day = cleanDay(edit.day);
    if (!day) throw new VaultError("日期不对：要 YYYY-MM-DD 这样的");
    patch.day = day;
  }
  if (edit.title !== undefined) patch.title = cleanJournalTitle(edit.title);
  if (edit.style !== undefined) patch.style = cleanStyle(edit.style);
  if (edit.mood !== undefined) patch.mood = cleanMood(edit.mood);
  if (edit.weather !== undefined) patch.weather = cleanWeather(edit.weather);
  if (edit.doc !== undefined) patch.doc = cleanDoc(edit.doc);
  const next = { ...had, ...patch };
  const media = await listMedia(db, user.id, id);
  patch.searchText = buildJournalSearchText(
    next,
    media.map((m) => m.transcript)
  );
  const saved = await updateEntry(db, user.id, id, rev, patch);
  if (saved === null) throw conflict();
  return { rev: saved };
}

/** 存储桶里这篇日记目录下的文件。only 给了 = 只要名字以它开头的（一个文件的原件和转出来的那份）。 */
async function removeFiles(userId: string, entryId: string, only?: string): Promise<void> {
  const service = getServiceClient();
  const dir = journalDir(userId, entryId);
  const { data, error } = await service.storage.from(BUCKET).list(dir, { limit: 1000, ...(only ? { search: only } : {}) });
  if (error) return console.error(`列出日记的文件失败 ${dir}: ${error.message}`);
  const paths = (data ?? []).filter((f) => !only || f.name.startsWith(only)).map((f) => `${dir}/${f.name}`);
  if (paths.length === 0) return;
  const { error: rmErr } = await service.storage.from(BUCKET).remove(paths);
  if (rmErr) console.error(`删除日记的文件失败 ${dir}: ${rmErr.message}`);
}

/** 删一篇：行、它的文件的登记（级联）、存储桶里的文件。 */
export async function removeEntry(session: Session, id: string): Promise<void> {
  if (!isUuid(id) || !(await deleteEntry(session.db, session.user.id, id))) throw new VaultError(NOT_FOUND, 404);
  await removeFiles(session.user.id, id);
}

// ---------------------------------------------------------------- 照片和录音

export async function listEntryMedia(session: Session, entryId: string): Promise<MediaView[]> {
  if (!isUuid(entryId)) throw new VaultError(NOT_FOUND, 404);
  return (await listMedia(session.db, session.user.id, entryId)).map((m) => toMediaView(m));
}

export type MediaTicket = { media: MediaView; upload: { bucket: string; path: string; token: string } };

/**
 * 开始往一篇日记里传一个文件（照片或录音）：登记一行「等上传」，发一个签名上传地址，浏览器（或 App）把文件直接传到存储桶，
 * 传完调 finishMediaUpload。文件先放在 `<id>-raw.<扩展名>`，处理完换成能用的样子。
 */
export async function beginMediaUpload(session: Session, entryId: string, file: { name: string; mime: string; size: number }): Promise<MediaTicket> {
  const { user, db } = session;
  const entry = isUuid(entryId) ? await getEntry(db, user.id, entryId) : null;
  if (!entry) throw new VaultError(NOT_FOUND, 404);
  const plan = planJournalUpload(file, UPLOAD_MAX_BYTES);
  if ("error" in plan) throw new VaultError(plan.error);
  if ((await listMedia(db, user.id, entryId)).length >= JOURNAL_MAX.media) throw new VaultError(`一篇日记最多放 ${JOURNAL_MAX.media} 个文件（照片和录音）：这一篇放满了，新开一篇接着放`);
  const id = crypto.randomUUID();
  const path = `${journalDir(user.id, entryId)}/${id}-raw.${plan.ext}`;
  await insertMedia(db, user.id, { id, entryId, kind: plan.kind, path, mime: plan.mime, bytes: file.size });
  const { data, error } = await getServiceClient().storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) {
    await deleteMedia(db, user.id, id);
    throw new Error(`拿不到上传地址: ${error?.message ?? "没有返回"}`);
  }
  const media = await getMedia(db, user.id, id);
  if (!media) throw new Error("登记文件失败");
  return { media: toMediaView(media), upload: { bucket: BUCKET, path, token: data.token } };
}

/** 后台任务起不来（Workflow 运行时没连上）：标成失败并带上原因，不让它挂在「处理中」。 */
async function startTranscribing(userId: string, mediaId: string): Promise<void> {
  try {
    await start(processJournalAudio, [mediaId, userId]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`后台任务没启动 journal_media=${mediaId}: ${message}`);
    await updateMedia(getServiceClient(), userId, mediaId, { status: "failed", error: `后台任务没启动：${message.slice(0, 300)}` }, "processing");
  }
}

/** 照片：统一成 JPEG（摆正、长边 ≤ 2160，见 archiveImage），原文件删掉。很快，当场做完。 */
async function settleImage(media: JournalMedia): Promise<void> {
  const service = getServiceClient();
  const { data: blob, error } = await service.storage.from(BUCKET).download(media.path);
  if (error || !blob) throw new Error(`读取文件失败: ${error?.message ?? "文件不在"}`);
  let img;
  try {
    img = await archiveImage(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    await updateMedia(service, media.userId, media.id, { status: "failed", error: "这张图片读不出来（格式不支持或文件坏了）。HEIC 照片请先转成 JPEG 再传" });
    return;
  }
  const path = `${journalDir(media.userId, media.entryId)}/${media.id}.jpg`;
  const { error: upErr } = await service.storage.from(BUCKET).upload(path, new Blob([img.data as BlobPart], { type: img.mime }), { contentType: img.mime, upsert: true });
  if (upErr) throw new Error(`转存图片失败: ${upErr.message}`);
  await updateMedia(service, media.userId, media.id, { status: "ready", error: null, path, mime: img.mime, bytes: img.data.byteLength, width: img.width, height: img.height });
  const { error: rmErr } = await service.storage.from(BUCKET).remove([media.path]);
  if (rmErr) console.error(`删除上传的原文件失败 ${media.path}: ${rmErr.message}`);
}

/** 文件传完了：确认文件真的在。照片当场处理好；录音交给后台转文字（页面隔几秒来看一眼）。返回这个文件现在的样子。 */
export async function finishMediaUpload(session: Session, mediaId: string): Promise<MediaView> {
  const { user, db } = session;
  const media = isUuid(mediaId) ? await getMedia(db, user.id, mediaId) : null;
  if (!media) throw new VaultError(MEDIA_NOT_FOUND, 404);
  if (media.status === "uploading") {
    const name = media.path.split("/").pop() ?? "";
    const { data, error } = await getServiceClient().storage.from(BUCKET).list(journalDir(user.id, media.entryId), { search: name });
    if (error) throw new Error(`检查上传的文件失败: ${error.message}`);
    if (!(data ?? []).some((f) => f.name === name)) throw new VaultError("文件没有传上来，请重新传", 409);
    if (media.kind === "image") await settleImage(media);
    else if (await updateMedia(db, user.id, mediaId, { status: "processing", startedAt: new Date().toISOString() }, "uploading")) await startTranscribing(user.id, mediaId);
  }
  const now = await getMedia(db, user.id, mediaId);
  if (!now) throw new VaultError(MEDIA_NOT_FOUND, 404);
  return toMediaView(now);
}

/** 录音重新转一次文字（上次没转成、转得不对、中断了）。正在转的不重复开。 */
export async function retryMedia(session: Session, mediaId: string): Promise<MediaView> {
  const { user, db } = session;
  const media = isUuid(mediaId) ? await getMedia(db, user.id, mediaId) : null;
  if (!media) throw new VaultError(MEDIA_NOT_FOUND, 404);
  if (media.kind !== "audio") throw new VaultError("只有录音能重新转文字");
  if (media.status === "uploading") throw new VaultError("文件还没传完：删掉这一条重新传", 409);
  if (toMediaView(media).status === "processing") throw new VaultError("这段录音正在转文字，等它结束再试", 409);
  await updateMedia(db, user.id, mediaId, { status: "processing", error: null, startedAt: new Date().toISOString() });
  await startTranscribing(user.id, mediaId);
  const now = await getMedia(db, user.id, mediaId);
  if (!now) throw new VaultError(MEDIA_NOT_FOUND, 404);
  return toMediaView(now);
}

/** 删一个文件：登记和存储桶里的文件（原件和转出来的那份）。正文里指着它的那一块由页面自己拿掉。 */
export async function removeMedia(session: Session, mediaId: string): Promise<void> {
  const { user, db } = session;
  const media = isUuid(mediaId) ? await getMedia(db, user.id, mediaId) : null;
  if (!media) return; // 已经不在了：要的结果已经有了
  await deleteMedia(db, user.id, mediaId);
  await removeFiles(user.id, media.entryId, media.id);
}

// ---------------------------------------------------------------- 我的贴纸

/** 自己传的贴纸最多留这么多张；一张的原件最多这么大 */
export const STICKERS_MAX = 200;
export const STICKER_MAX_BYTES = 15 * 1024 * 1024;
const STICKER_NOT_FOUND = "这张贴纸不在了";

export type StickerView = { id: string; url: string; width: number | null; height: number | null };
export type StickerTicket = { id: string; upload: { bucket: string; path: string; token: string } };

export const stickerDir = (userId: string) => `${userId}/journal-stickers`;
const toStickerView = (s: JournalSticker): StickerView => ({ id: s.id, url: `/media/journal/sticker/${s.id}`, width: s.width, height: s.height });

/** 我的贴纸，新传的在前。 */
export async function listMyStickers(session: Session): Promise<StickerView[]> {
  return (await listStickers(session.db, session.user.id)).map(toStickerView);
}

/** 开始传一张贴纸：只收图片。登记一行「等上传」，发一个签名上传地址；传完调 finishStickerUpload。 */
export async function beginStickerUpload(session: Session, file: { name: string; mime: string; size: number }): Promise<StickerTicket> {
  const { user, db } = session;
  const plan = planJournalUpload(file, STICKER_MAX_BYTES);
  if ("error" in plan) throw new VaultError(plan.error === "日记里只能放照片和录音" ? "贴纸只能是图片" : plan.error);
  if (plan.kind !== "image") throw new VaultError("贴纸只能是图片");
  if ((await listStickers(db, user.id, true)).length >= STICKERS_MAX) throw new VaultError(`「我的贴纸」最多留 ${STICKERS_MAX} 张：先删掉几张不用的`);
  const id = crypto.randomUUID();
  const path = `${stickerDir(user.id)}/${id}-raw.${plan.ext}`;
  await insertSticker(db, user.id, { id, path, bytes: file.size });
  const { data, error } = await getServiceClient().storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) {
    await deleteSticker(db, user.id, id);
    throw new Error(`拿不到上传地址: ${error?.message ?? "没有返回"}`);
  }
  return { id, upload: { bucket: BUCKET, path, token: data.token } };
}

/** 贴纸传完了：裁掉四周的空白、缩小、存成保留透明底的 WebP，原件删掉。读不出来的整张不要（登记和文件都清掉）。 */
export async function finishStickerUpload(session: Session, id: string): Promise<StickerView> {
  const { user, db } = session;
  const sticker = isUuid(id) ? await getSticker(db, user.id, id) : null;
  if (!sticker) throw new VaultError(STICKER_NOT_FOUND, 404);
  if (sticker.status === "ready") return toStickerView(sticker);
  const service = getServiceClient();
  const drop = async () => {
    await deleteSticker(db, user.id, id);
    await service.storage.from(BUCKET).remove([sticker.path]);
  };
  const { data: blob, error } = await service.storage.from(BUCKET).download(sticker.path);
  if (error || !blob) {
    await drop();
    throw new VaultError("文件没有传上来，请重新传", 409);
  }
  let img;
  try {
    img = await stickerImage(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    await drop();
    throw new VaultError("这张图片读不出来（格式不支持或文件坏了）。HEIC 照片请先转成 PNG 或 JPEG 再传");
  }
  const path = `${stickerDir(user.id)}/${id}.webp`;
  const { error: upErr } = await service.storage.from(BUCKET).upload(path, new Blob([img.data as BlobPart], { type: img.mime }), { contentType: img.mime, upsert: true });
  if (upErr) throw new Error(`保存贴纸失败: ${upErr.message}`);
  await readySticker(db, user.id, id, { path, width: img.width, height: img.height, bytes: img.data.byteLength });
  const { error: rmErr } = await service.storage.from(BUCKET).remove([sticker.path]);
  if (rmErr) console.error(`删除贴纸的原文件失败 ${sticker.path}: ${rmErr.message}`);
  return { id, url: `/media/journal/sticker/${id}`, width: img.width, height: img.height };
}

/** 从「我的贴纸」里删一张（登记和文件）。日记上贴着的那一件不动，只是画不出来了。 */
export async function removeSticker(session: Session, id: string): Promise<void> {
  const { user, db } = session;
  const sticker = isUuid(id) ? await getSticker(db, user.id, id) : null;
  if (!sticker) return;
  await deleteSticker(db, user.id, id);
  const { error } = await getServiceClient().storage.from(BUCKET).remove([sticker.path]);
  if (error) console.error(`删除贴纸的文件失败 ${sticker.path}: ${error.message}`);
}
