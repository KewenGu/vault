import { readFile, writeFile } from "node:fs/promises";
import { getServiceClient } from "@/lib/supabase/service";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { embedTexts } from "@/lib/embeddings";
import { defaultGraphDeps, linkItemEntities } from "@/lib/graph/merge";
import { extractSpeechAudio } from "@/lib/media/audio";
import { withTempDir } from "@/lib/media/ffmpeg";
import { IMAGE_MAX_BYTES, MAX_IMAGES, VIDEO_MAX_BYTES, TooLargeError, archiveImage, downloadRemote, downloadRemoteToFile, visionImage, visionSlices } from "@/lib/media/files";
import { canDigestVideo, contactSheets, digestVideo, digestVideoFile, sheetLayout } from "@/lib/media/frames";
import { keepLocalFile, localFileSize, localMediaPath, removeLocalItemFiles } from "@/lib/media/local-store";
import { muxAudioInto } from "@/lib/media/mux";
import { clockTenths, frameNote, likelyChinese, parseTranscript, speechAt, speechLabel, type Cue } from "@/lib/media/transcript";
import { fetchPost } from "@/lib/sources/fetch-post";
import { mapCapture } from "@/lib/sources/web";
import { emptyStats, type FetchedPost, type ItemMedia, type PostSnapshot } from "@/lib/sources/types";
import { ytdlpDownload } from "@/lib/sources/ytdlp";
import { buildEmbeddingText, buildSearchText } from "@/lib/vault/indexing";
import { SPEECH_MAX_SECONDS, transcribeSpeech } from "@/lib/vault/speech";
import { BUCKET, audioOf, bucketFileLimit, framesOf, getItemById, imagesOf, itemDir, removeItemFiles, sheetsOf, tagCounts, videoOf, type Item } from "@/lib/vault/store";
import { videoReadMaxBytes } from "@/lib/vault/limits";
import { understand, type OutputLanguage } from "@/lib/vault/understand";
import type { Json } from "@/lib/db/types";

/**
 * 一条内容存进来之后的后台任务：跑完这几步，页面自己刷新看结果。
 *
 *   ① 读取：链接 → 按平台读帖子（lib/sources/fetch-post.ts）、把图片 / 视频转存到存储桶；
 *            上传的文件 → 图片统一成 JPEG，视频 / 音频登记，文字文件读成正文；贴的文字 → 什么都不用做
 *   ② 看和听（视频 / 音频、且这台机器有 ffmpeg）：测切点、抽画面、把说的话转成带时间的文字
 *            （平台自带字幕的不用转；豆包语音识别 → OpenAI whisper-1 → 本机 whisper，前一条走不通才试下一条）、拼帧格
 *   ③ 理解：Claude 看图 + 读文字，产出标题、类型、领域、概括、要点、卡片字段、标签、图里的字、实体和关系
 *   ④ 建索引：搜索用的全文、语义向量；实体并入这个人的知识图谱
 *
 * - 从哪一步开始看这条内容的状态：fetching = 从 ① 开始；analyzing = 已经读过，只重新做 ②③④（重新分析）。
 * - ①③ 失败把原因写回这条内容（status=failed）、不再往下跑，也不自动重试——平台读不到多半是口令过期或风控，
 *   重试只会更糟；用户在页面上点「重试」。已经理解过的内容重新处理失败时，留着上次的结果（status 回到 ready，error 里记原因）。
 * - ② 是锦上添花：做不了（没有 ffmpeg、语音识别没开通、视频太大没下载）就记一句「没看到什么」，照样理解。
 * - ④ 里向量 / 图谱没建成不算失败：内容已经能看、能按关键词搜，error 里记一句，重新分析时补上。
 * - 记账：每一步用掉的量（Claude、向量、语音识别、Apify / Jina）累加进 items.usage，折成美元记在 cost_usd。
 */

type Counts = Record<string, number>;
type StepResult = { ok: boolean; error?: string; counts: Counts };
type Db = ReturnType<typeof getServiceClient>;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);
/** 超过这么大的视频不测切点（见 digestVideoSource） */
const CUT_DETECT_MAX_BYTES = 50 * 1024 * 1024;
/** 网页配图短边不到这么多像素的不存（图标、头像、分隔线） */
const WEB_IMAGE_MIN_EDGE = 200;

const outputLanguage = (): OutputLanguage => (process.env.VAULT_LANGUAGE?.trim().toLowerCase() === "en" ? "en" : "zh");

async function load(itemId: string): Promise<{ db: Db; item: Item | null }> {
  const db = getServiceClient();
  return { db, item: await getItemById(db, itemId) };
}

/** 这一轮没成：有上次的理解结果就留着（回到 ready），没有才是 failed。 */
async function markFailed(itemId: string, error: string, hadUnderstanding: boolean): Promise<void> {
  const db = getServiceClient();
  const { error: e } = await db
    .from("items")
    .update({ status: hadUnderstanding ? "ready" : "failed", error: error.slice(0, 500) })
    .eq("id", itemId)
    .in("status", ["fetching", "analyzing"]);
  if (e) console.error(`标记失败出错 item=${itemId}: ${e.message}`);
}

async function upload(db: Db, path: string, data: Uint8Array, mime: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(path, new Blob([data as BlobPart], { type: mime }), { contentType: mime, upsert: true });
  if (error) throw new Error(`转存文件失败: ${error.message}`);
}

async function download(db: Db, path: string): Promise<Uint8Array> {
  const { data: blob, error } = await db.storage.from(BUCKET).download(path);
  if (error || !blob) throw new Error(`读取文件失败: ${error?.message ?? "文件不在"}`);
  return new Uint8Array(await blob.arrayBuffer());
}

const emptyPost = (patch: Partial<PostSnapshot> = {}): PostSnapshot => ({
  text: "",
  publishedAt: null,
  stats: emptyStats(),
  hashtags: [],
  topComments: [],
  music: null,
  notes: [],
  authorId: null,
  durationS: null,
  digestNotes: [],
  transcriptFrom: null,
  cuts: [],
  links: [],
  ...patch,
});

/**
 * 存储服务嫌文件太大时，说清楚是哪一道上限：存储桶自己的（接口读得到，跑一条 SQL 就能改），
 * 还是项目全局的（读不到，在控制台改；免费套餐封顶 50 MB）。两道里小的那个说了算。
 */
async function storageLimitHint(db: Db, bytes: number): Promise<string> {
  const limit = await bucketFileLimit(db).catch(() => undefined);
  if (typeof limit === "number" && limit < bytes) {
    return `存储桶的单文件上限是 ${megabytes(limit)} MB：在 Supabase 的 SQL Editor 里运行迁移 20261118000001_bucket_limit.sql`;
  }
  return "Supabase 项目的全局上传上限不够（免费套餐封顶 50 MB）：把 .env.local 里的 VAULT_STORE_MAX_MB 去掉或调回 50";
}

/** 一个要读的视频：在内存里（从存储桶取出来的，存档上限以内），或者在磁盘上（刚下载的，可能几百 MB） */
type VideoSource = { data: Uint8Array; ext: string } | { file: string; bytes: number };

/**
 * 把读到的帖子的图片 / 视频下载下来转存；下不了的记进 notes（不算失败——文字还在，照样能理解）。
 * tmp：放下载下来的视频的临时目录（调用方建、调用方删）。
 * unstored：视频没进存储桶（太大，或者存储那边不收）——画面和声音要趁现在从这个文件读。
 */
async function storeMedia(db: Db, dir: string, post: FetchedPost, tmp: string): Promise<{ media: ItemMedia[]; notes: string[]; unstored: { file: string; bytes: number } | null }> {
  const media: ItemMedia[] = [];
  const notes: string[] = [];
  const images = post.images.slice(0, MAX_IMAGES);
  if (post.images.length > images.length) notes.push(`一共 ${post.images.length} 张图，只存了前 ${images.length} 张`);
  let failed = 0;
  for (const [i, file] of images.entries()) {
    try {
      const img = await archiveImage(await downloadRemote(file, IMAGE_MAX_BYTES, 30_000));
      if (post.platform === "web" && Math.min(img.width, img.height) < WEB_IMAGE_MIN_EDGE) continue;
      const path = `${dir}/img-${String(media.length + 1).padStart(2, "0")}.jpg`;
      await upload(db, path, img.data, img.mime);
      media.push({ role: "image", path, mime: img.mime, width: img.width, height: img.height, bytes: img.data.byteLength });
    } catch (e) {
      failed++;
      console.error(`图片转存失败 ${dir} #${i + 1}: ${messageOf(e)}`);
    }
  }
  if (failed > 0) notes.push(`有 ${failed} 张图没下载下来`);
  let unstored: { file: string; bytes: number } | null = null;
  if (post.video) {
    const readMax = videoReadMaxBytes();
    try {
      // 视频写到磁盘上的临时目录，不进内存。没有能直接下的地址的（别的视频站）交给本机的 yt-dlp：
      // 它按大小挑清晰度，挑的就是存得下的那一档，拿回来的数据也写到同一个位置，后面只有一条路
      const file = `${tmp}/source.mp4`;
      let bytes: number;
      if (post.video.via === "ytdlp") {
        const data = await ytdlpDownload(post.video.url, VIDEO_MAX_BYTES);
        await writeFile(file, data);
        bytes = data.byteLength;
      } else bytes = await downloadRemoteToFile(post.video, file, readMax, 600_000);
      // 声音在另一个文件里的（Reddit）：下下来合进去。合不成不算失败，留着没有声音的画面，说清楚
      if (post.video.audio) {
        try {
          bytes = await muxAudioInto(file, post.video.audio, tmp);
        } catch (e) {
          notes.push(`视频的声音没有合进去（${messageOf(e).slice(0, 100)}），只有画面：说了什么读不到`);
          console.error(`视频合声音失败 ${dir}: ${messageOf(e)}`);
        }
      }
      const cannotPlay = "画面和声音照常读，但这里不能播放，要看去原链接";
      if (bytes <= VIDEO_MAX_BYTES) {
        const path = `${dir}/video.mp4`;
        try {
          // 存档上限以内的才整个读进内存（要传给存储服务）
          await upload(db, path, new Uint8Array(await readFile(file)), "video/mp4");
          // yt-dlp 下的是按大小挑的那一档，宽高和视频信息里写的不一定一样：留空，抽画面时按实际的补
          const sized = post.video.via === "ytdlp" ? { width: null, height: null } : { width: post.video.width ?? null, height: post.video.height ?? null };
          media.push({ role: "video", path, mime: "video/mp4", ...sized, bytes, durationS: post.video.durationS });
        } catch (e) {
          // 存储那边不收（最常见：存储桶或项目的单文件上限比这里的小）。视频已经在手上了，照样读，只是不留原片
          unstored = { file, bytes };
          const tooBig = /maximum allowed size|too large|exceeded|413/i.test(messageOf(e));
          notes.push(`原片没存进去（${megabytes(bytes)} MB，${tooBig ? await storageLimitHint(db, bytes) : messageOf(e).slice(0, 100)}）：${cannotPlay}`);
          console.error(`视频存档失败 ${dir}: ${messageOf(e)}`);
        }
      } else {
        // 存储桶存不下：不上传、也不压缩，原片搬到这台服务器的磁盘上留着（lib/media/local-store.ts），页面从磁盘播放，
        // 内容也从那儿读。等 Supabase 换了付费套餐、VAULT_STORE_MAX_MB 调高之后再搬去存储桶。
        // （2026-11-19 之前这里会压一份放得下的副本存进存储桶：1 核的机器压一条长视频要十几二十分钟，长于一小时的压到 50 MB 也没法看。）
        const path = `${dir}/video.mp4`;
        try {
          unstored = { file: await keepLocalFile(file, path), bytes };
          media.push({ role: "video", path, mime: "video/mp4", width: post.video.width ?? null, height: post.video.height ?? null, bytes, durationS: post.video.durationS, local: true });
        } catch (e) {
          // 留不下（磁盘满了、目录没权限）：照样从临时目录里的这份读，读完就没了
          unstored = { file, bytes };
          notes.push(`原片没有留下来（${megabytes(bytes)} MB，超过 ${megabytes(VIDEO_MAX_BYTES)} MB 的存档上限，存到这台服务器的磁盘上也没成：${messageOf(e).slice(0, 100)}）：${cannotPlay}`);
          console.error(`原片留在磁盘上失败 ${dir}: ${messageOf(e)}`);
        }
      }
    } catch (e) {
      const seen = post.captions ? "只看了封面、字幕和文字" : "只看了封面和文字";
      if (e instanceof TooLargeError) {
        const mb = e.bytes ? `（${megabytes(e.bytes)} MB）` : "";
        notes.push(`视频太大${mb}，超过 ${megabytes(readMax)} MB 没有下载，${seen}`);
      } else {
        // 原因写出来：只说「没下载下来」分不清是超时、被平台拒绝还是地址失效，下一步该怎么办也就不知道
        notes.push(`视频没下载下来（${messageOf(e).slice(0, 100)}），${seen}`);
        console.error(`视频转存失败 ${dir}: ${messageOf(e)}`);
      }
    }
  }
  return { media, notes, unstored };
}

/** ① 链接：读帖子、转存文件。读不到、但用户补贴过文字的，留着上次读到的东西直接去理解。 */
/** 返回值：这一步是不是已经把视频的画面和声音读过了（原片存不下、趁数据在手上直接读的）。 */
async function fetchLink(db: Db, item: Item, counts: Counts): Promise<boolean> {
  if (!item.platform || !item.externalId || !item.url) throw new Error("这条内容没有链接");
  const ref = { platform: item.platform, externalId: item.externalId, url: item.url };
  // 在手机的 Safari 里读过的网页（服务器读不到）：用那一份，不去抓
  const capture = item.post.capture;
  let post: FetchedPost;
  try {
    post = capture ? mapCapture(capture, ref) : await meterInto(counts, () => fetchPost(ref));
  } catch (e) {
    if (!item.userText?.trim()) throw e;
    const { error } = await db.from("items").update({ status: "analyzing" }).eq("id", item.id);
    if (error) throw new Error(`更新失败: ${error.message}`);
    return false;
  }
  // 重新读取：先清掉上一轮的文件（图片数量可能变了）
  await removeItemFiles(db, item.userId, item.id);
  await removeLocalItemFiles(item.userId, item.id);
  let media: ItemMedia[] = [];
  let storeNotes: string[] = [];
  let transcript: string | null = post.captions || null;
  let durationS = post.video?.durationS ?? post.durationS ?? null;
  let digestNotes: string[] = [];
  let cuts: number[] = [];
  let digested = false;
  // 视频先下载到一个临时目录里，这一步结束（成功、失败都一样）整个删掉；要留的大视频在 storeMedia 里已经搬走了
  await withTempDir(async (tmp) => {
    const stored = await storeMedia(db, itemDir(item.userId, item.id), post, tmp);
    media = stored.media;
    storeNotes = stored.notes;
    if (!stored.unstored) return;
    digested = true;
    // 原片没进存储桶：现在就从磁盘上的文件把画面和声音读出来（存进存储桶的视频是下一步取出来读的）
    try {
      const language = likelyChinese(post.platform, `${post.title}\n${post.text}\n${item.note}`) ? "zh" : null;
      const d = await digestVideoSource(db, { id: item.id, userId: item.userId, captions: post.captions ?? null, language }, stored.unstored, counts);
      // 探测到的真实时长、尺寸比平台报的准
      media = [...media.map((m) => (m.role === "video" && d.durationS !== null ? { ...m, durationS: d.durationS, width: d.width ?? m.width, height: d.height ?? m.height } : m)), ...d.frames, ...d.sheets];
      transcript = d.transcript;
      digestNotes = d.notes;
      cuts = d.cuts;
      durationS = d.durationS ?? durationS;
    } catch (e) {
      digestNotes = [`没有抽出视频画面（${messageOf(e).slice(0, 120)}），只看了封面和文字`];
    }
  });
  const snapshot = emptyPost({
    text: post.text,
    publishedAt: post.publishedAt,
    stats: post.stats,
    hashtags: post.hashtags,
    topComments: post.topComments,
    music: post.music,
    notes: [...post.notes, ...storeNotes],
    authorId: post.author.id,
    durationS,
    digestNotes,
    transcriptFrom: post.captions ? "captions" : transcript ? "asr" : null,
    cuts,
    links: post.links ?? [],
    ...(capture ? { capture } : {}),
  });
  const { error } = await db
    .from("items")
    .update({
      status: "analyzing",
      ...(post.url && post.url !== item.url ? { url: post.url } : {}),
      kind: post.kind,
      title: post.title || null,
      author: post.author.name || null,
      post: snapshot as unknown as Json,
      media: media as unknown as Json,
      transcript,
      understanding: null,
      processed_at: null,
    })
    .eq("id", item.id);
  if (error) throw new Error(`保存帖子失败: ${error.message}`);
  return digested;
}

/**
 * ① 上传的文件：浏览器直传到 `<目录>/upload.<扩展名>`（items.media 里登记着），这里把它变成能用的样子——
 * 图片统一成 JPEG（摆正、长边 ≤ 2160；长图按宽度缩，宽 ≤ 1440，见 archiveImage；原文件删掉）；视频 / 音频原样留着；文字文件读成正文（文件删掉）。
 * 已经处理过的（重新读取）不用再动。
 */
async function fetchUpload(db: Db, item: Item): Promise<void> {
  const raw = item.media.find((m) => /\/upload\.[a-z0-9]+$/i.test(m.path) && m.role !== "video" && m.role !== "audio");
  let media = item.media;
  let userText = item.userText;
  if (raw) {
    const data = await download(db, raw.path);
    const dir = itemDir(item.userId, item.id);
    if (item.kind === "text") {
      userText = new TextDecoder("utf-8").decode(data).replace(/^﻿/, "").trim();
      if (!userText) throw new Error("这个文件里没有文字");
      media = [];
    } else {
      let img;
      try {
        img = await archiveImage(data);
      } catch {
        throw new Error("这张图片读不出来（格式不支持或文件坏了）。HEIC 照片请先转成 JPEG 再传");
      }
      const path = `${dir}/img-01.jpg`;
      await upload(db, path, img.data, img.mime);
      media = [{ role: "image", path, mime: img.mime, width: img.width, height: img.height, bytes: img.data.byteLength }];
    }
    const { error: rmErr } = await db.storage.from(BUCKET).remove([raw.path]);
    if (rmErr) console.error(`删除上传的原文件失败 ${raw.path}: ${rmErr.message}`);
  } else if (item.media.length === 0 && !item.userText) {
    throw new Error("文件没有传上来，请重新上传");
  }
  const { error } = await db
    .from("items")
    .update({ status: "analyzing", media: media as unknown as Json, user_text: userText, post: emptyPost(item.post) as unknown as Json })
    .eq("id", item.id);
  if (error) throw new Error(`保存失败: ${error.message}`);
}

/** userId：这条内容是谁的（收尾清文件要用；一开始就不在了是 null）。 */
async function fetchItemStep(itemId: string): Promise<StepResult & { digested: boolean; userId: string | null }> {
  "use step";
  const counts: Counts = {};
  const { db, item } = await load(itemId);
  if (!item) return { ok: false, error: "这条内容不在了", counts, digested: false, userId: null };
  const userId = item.userId;
  if (item.status === "analyzing") return { ok: true, counts, digested: false, userId };
  if (item.status !== "fetching") return { ok: false, error: `状态是 ${item.status}，不再读取`, counts, digested: false, userId };
  try {
    let digested = false;
    if (item.source === "link") digested = await fetchLink(db, item, counts);
    else if (item.source === "upload") await fetchUpload(db, item);
    else {
      const { error } = await db.from("items").update({ status: "analyzing", post: emptyPost(item.post) as unknown as Json }).eq("id", itemId);
      if (error) throw new Error(`更新失败: ${error.message}`);
    }
    return { ok: true, counts, digested, userId };
  } catch (e) {
    const error = messageOf(e);
    await markFailed(itemId, item.understanding ? `重新读取没成，留着上次的结果：${error}` : error, item.understanding !== null);
    return { ok: false, error, counts, digested: false, userId };
  }
}

const extOf = (path: string) => path.split(".").pop() ?? "bin";
const speechLanguage = (item: Item): "zh" | null => (likelyChinese(item.platform ?? "", `${item.title}\n${item.post.text}\n${item.note}`) ? "zh" : null);

type VideoDigestResult = { frames: ItemMedia[]; sheets: ItemMedia[]; transcript: string | null; notes: string[]; cuts: number[]; durationS: number | null; width: number | null; height: number | null };

/**
 * ② 视频：测切点、抽帧、转写（平台自带字幕的只抽帧）、每帧标词、拼帧格，把帧和帧格存进存储桶。
 * 顺序是先转写再存帧：帧上「那一刻说的话」要等口播出来才知道。视频由调用方给（存下来的从存储桶取到内存里，存不下的是刚下载到磁盘上的那份）。
 */
async function digestVideoSource(
  db: Db,
  ctx: { id: string; userId: string; captions: string | null; language: "zh" | null },
  source: VideoSource,
  counts: Counts
): Promise<VideoDigestResult> {
  const { captions } = ctx;
  const notes: string[] = [];
  if (!canDigestVideo()) {
    notes.push(captions ? "这台机器没有 ffmpeg，没有抽视频画面，只看了封面、字幕和文字" : "这台机器没有 ffmpeg，没有抽视频画面、也没有转写口播，只看了封面和文字");
    return { frames: [], sheets: [], transcript: captions, notes, cuts: [], durationS: null, width: null, height: null };
  }
  let transcript: string | null = captions;
  // 测切点要把整条视频解码一遍。大文件（长视频）不测：帧按时间均匀取，省下的那一遍在小机器上是好几分钟。
  const opts = { overview: true, audioMaxSeconds: SPEECH_MAX_SECONDS, detectCuts: ("file" in source ? source.bytes : source.data.byteLength) <= CUT_DETECT_MAX_BYTES };
  const digest = "file" in source ? await digestVideoFile(source.file, opts) : await digestVideo(source.data, source.ext, opts);
  const cuts = (digest.cuts ?? []).map((c) => c.at);
  let cues: Cue[] = captions ? parseTranscript(captions).flatMap((t) => (t.at === null ? [] : [{ at: t.at, text: t.text }])) : [];
  if (captions) {
    // 有平台字幕：不做语音识别
  } else if (!digest.audio) {
    // 有音轨但没导出来（ffmpeg 出错 / 超时）和本来就没声音要分开说：前一种重试可能就好了
    notes.push(digest.probe.hasAudio ? "音轨没导出来（ffmpeg 出错或超时），没有转写口播，只看了画面和文字" : "视频没有声音");
  } else {
    const speech = await transcribeSpeech(counts, digest.audio, ctx.language);
    transcript = speech.transcript;
    cues = speech.cues;
    notes.push(...speech.notes);
    if (transcript && digest.probe.duration > digest.audio.seconds + 1) notes.push(`口播只转写了前 ${Math.round(digest.audio.seconds / 60)} 分钟（全长 ${Math.round(digest.probe.duration / 60)} 分钟）`);
  }
  const dir = itemDir(ctx.userId, ctx.id);
  const portrait = (digest.probe.height ?? 0) >= (digest.probe.width ?? 0);
  const { span } = sheetLayout(portrait);
  const frames: ItemMedia[] = [];
  const tiles: { at: number; cut: boolean; data: Uint8Array; speech: ReturnType<typeof speechAt> }[] = [];
  for (const [i, f] of digest.frames.entries()) {
    const speech = cues.length > 0 ? speechAt(cues, f.at, span) : null;
    const path = `${dir}/frame-${String(i + 1).padStart(2, "0")}.jpg`;
    await upload(db, path, f.data, "image/jpeg");
    frames.push({ role: "frame", path, mime: "image/jpeg", width: f.width, height: f.height, bytes: f.data.byteLength, at: f.at, cut: f.cut ?? false, words: speech ? speechLabel(speech) : null });
    tiles.push({ at: f.at, cut: f.cut ?? false, data: f.data, speech });
  }
  const sheets: ItemMedia[] = [];
  try {
    const overview = digest.overview.map((o) => ({ at: o.at, cut: o.cut, data: o.data, speech: cues.length > 0 ? speechAt(cues, o.at, span) : null }));
    for (const [i, sheet] of (await contactSheets(overview.length ? overview : tiles, portrait)).entries()) {
      const path = `${dir}/sheet-${String(i + 1).padStart(2, "0")}.jpg`;
      await upload(db, path, sheet.data, "image/jpeg");
      sheets.push({ role: "sheet", path, mime: "image/jpeg", width: sheet.width, height: sheet.height, bytes: sheet.data.byteLength, at: sheet.from, to: sheet.to, tiles: sheet.tiles });
    }
  } catch (e) {
    // 帧格拼不出来（字体 / 内存）：没有帧格也能理解，每帧的说明里有同样的时间和词
    console.warn(`视频：帧格没拼出来 item=${ctx.id}: ${messageOf(e)}`);
  }
  return { frames, sheets, transcript, notes, cuts, durationS: Math.round(digest.probe.duration * 100) / 100, width: digest.probe.width, height: digest.probe.height };
}

/** ②（存了原片的视频）：从存储桶取出来读；原片在这台服务器磁盘上的直接读那个文件。 */
async function digestVideoItem(db: Db, item: Item, video: ItemMedia, counts: Counts): Promise<{ media: ItemMedia[]; transcript: string | null; notes: string[]; cuts: number[] }> {
  const captions = item.post.transcriptFrom === "captions" ? item.transcript : null;
  const kept = item.media.filter((m) => m.role !== "frame" && m.role !== "sheet");
  const local = video.local ? localMediaPath(video.path) : null;
  const source: VideoSource = local ? { file: local, bytes: video.bytes } : { data: canDigestVideo() ? await download(db, video.path) : new Uint8Array(), ext: extOf(video.path) };
  const d = await digestVideoSource(db, { id: item.id, userId: item.userId, captions, language: speechLanguage(item) }, source, counts);
  // 探测到的真实时长、尺寸比平台报的准
  const media = [...kept.map((m) => (m.role === "video" && d.durationS !== null ? { ...m, durationS: d.durationS, width: d.width ?? m.width, height: d.height ?? m.height } : m)), ...d.frames, ...d.sheets];
  return { media, transcript: d.transcript, notes: d.notes, cuts: d.cuts };
}

/** ② 音频：转成语音识别要的格式再转写。 */
async function digestAudioItem(db: Db, item: Item, audio: ItemMedia, counts: Counts): Promise<{ media: ItemMedia[]; transcript: string | null; notes: string[] }> {
  if (!canDigestVideo()) return { media: item.media, transcript: null, notes: ["这台机器没有 ffmpeg，没有转写音频"] };
  const speechAudio = await extractSpeechAudio(await download(db, audio.path), extOf(audio.path), SPEECH_MAX_SECONDS);
  const speech = await transcribeSpeech(counts, speechAudio, speechLanguage(item));
  const notes = [...speech.notes];
  if (speech.transcript && speechAudio.probe.duration > speechAudio.seconds + 1) notes.push(`只转写了前 ${Math.round(speechAudio.seconds / 60)} 分钟`);
  return { media: item.media.map((m) => (m.role === "audio" ? { ...m, durationS: Math.round(speechAudio.probe.duration * 100) / 100 } : m)), transcript: speech.transcript, notes };
}

async function digestItemStep(itemId: string): Promise<{ counts: Counts }> {
  "use step";
  const counts: Counts = {};
  const { db, item } = await load(itemId);
  if (!item || item.status !== "analyzing") return { counts };
  const video = videoOf(item);
  const audio = audioOf(item);
  if (!video && !audio) return { counts };
  // 2026-11-19 之前存进来的大视频，存的是压缩副本，而画面和口播已经从原片读过：留着那一份（比从副本重读的清楚），不重做
  if (video?.compressed && framesOf(item).length > 0 && item.transcript) return { counts };
  // 原片本该在这台服务器的磁盘上、但文件不在了（清过磁盘、换了机器）：留着之前读到的画面和口播，不重做
  if (video?.local && (await localFileSize(video.path)) === null) return { counts };
  let media = item.media;
  let transcript = item.post.transcriptFrom === "captions" ? item.transcript : null;
  let notes: string[] = [];
  let cuts: number[] = [];
  try {
    if (video) ({ media, transcript, notes, cuts } = await digestVideoItem(db, item, video, counts));
    else if (audio) ({ media, transcript, notes } = await digestAudioItem(db, item, audio, counts));
  } catch (e) {
    notes = [video ? `没有抽出视频画面（${messageOf(e).slice(0, 120)}），只看了封面和文字` : `音频没有处理成（${messageOf(e).slice(0, 120)}）`];
  }
  const captions = item.post.transcriptFrom === "captions";
  const durationS = media.find((m) => m.role === "video" || m.role === "audio")?.durationS ?? item.post.durationS;
  const { error } = await db
    .from("items")
    .update({
      media: media as unknown as Json,
      transcript,
      post: { ...item.post, durationS, digestNotes: notes, transcriptFrom: captions ? "captions" : transcript ? "asr" : null, cuts } satisfies PostSnapshot as unknown as Json,
    })
    .eq("id", itemId);
  if (error) console.error(`保存画面 / 口播失败 item=${itemId}: ${error.message}`);
  return { counts };
}

/** 给模型看的长图一共最多切这么多段（一段约 2000 tokens）；单张最多 16 段（visionSlices） */
const VISION_SLICES_MAX = 40;

/**
 * 给模型看的图：图文 / 文章 / 上传的图是每一张图（长图切成几段，见 visionSlices）；视频是封面 + 帧格（全片一览，每格下面是时间和那一刻说的话）
 * + 抽的每一帧（说明里带时间、是不是刚切镜、那一刻说到的词；没抽成就只有封面）。
 * gaps：没给模型看到的（读不出来的图、长图后面没给的段），理解时告诉模型、页面上列出来。
 */
async function visionImages(db: Db, item: Item): Promise<{ images: { caption: string; data: Uint8Array }[]; gaps: string[] }> {
  const frames = framesOf(item);
  const sheets = sheetsOf(item);
  const images = imagesOf(item);
  const sheetCaption = (i: number) => {
    const s = sheets[i];
    const range = s.at !== undefined && s.to !== undefined ? `（${clockTenths(s.at)}–${clockTenths(s.to)}）` : "";
    return `帧格 ${i + 1}/${sheets.length}${range}：全片画面一览，每格下面是时间和那一刻说的话`;
  };
  const out: { caption: string; data: Uint8Array }[] = [];
  const gaps: string[] = [];
  if (item.kind === "video") {
    const picks = [
      ...images.slice(0, 1).map((m) => ({ caption: "封面", path: m.path })),
      ...sheets.map((m, i) => ({ caption: sheetCaption(i), path: m.path })),
      ...frames.map((m) => ({ caption: frameNote({ at: m.at ?? 0, cut: m.cut, words: m.words }), path: m.path })),
    ];
    for (const p of picks) {
      try {
        out.push({ caption: p.caption, data: await visionImage(await download(db, p.path)) });
      } catch {
        // 这张读不出来：不给模型看
      }
    }
    return { images: out, gaps };
  }
  let slicesLeft = VISION_SLICES_MAX;
  for (const [i, m] of images.entries()) {
    const name = images.length > 1 ? `第 ${i + 1} 张图${i === 0 ? "（封面）" : ""}` : "图片";
    let cut;
    try {
      cut = await visionSlices(await download(db, m.path), { maxSlices: Math.max(1, Math.min(16, slicesLeft)) });
    } catch {
      gaps.push(`${name}读不出来，没给模型看`);
      continue;
    }
    if (cut.total === 1) {
      out.push({ caption: name, data: cut.slices[0] });
      continue;
    }
    slicesLeft -= cut.slices.length;
    cut.slices.forEach((data, j) => out.push({ caption: `${name}（长图，从上往下第 ${j + 1}/${cut.total} 段，相邻两段有一点重叠）`, data }));
    if (cut.slices.length < cut.total) gaps.push(`${name}是很长的长图，切成 ${cut.total} 段，只给模型看了前 ${cut.slices.length} 段，后面的内容没读`);
  }
  return { images: out, gaps };
}

/** ③ 理解。 */
async function understandItemStep(itemId: string): Promise<StepResult> {
  "use step";
  const counts: Counts = {};
  const { db, item } = await load(itemId);
  if (!item) return { ok: false, error: "这条内容不在了", counts };
  if (item.status !== "analyzing") return { ok: false, error: `状态是 ${item.status}，不再分析`, counts };
  try {
    const { images, gaps: unseen } = await visionImages(db, item);
    // 上传的文件的标题只是文件名，不算内容：画面和声音都没读到时不让模型对着文件名编
    const text = item.userText?.trim() || item.post.text || (item.source === "link" ? item.title : "");
    if (!text && images.length === 0 && !item.transcript) {
      const why = item.post.digestNotes.join("；");
      throw new Error(`没有读到任何内容（文字、画面、声音都没有），没法理解${why ? `：${why}` : ""}`);
    }
    const gaps: string[] = [...unseen];
    if (item.source === "link" && item.userText?.trim() && item.media.length === 0) gaps.push("链接本身没读到：只有用户手动贴的文字，没有图片 / 视频");
    const existingTags = (await tagCounts(db, item.userId)).map((t) => t.tag);
    const understanding = await meterInto(counts, () =>
      understand({
        source: item.source,
        platform: item.platform,
        kind: item.kind,
        title: item.title,
        author: item.author,
        url: item.url,
        post: item.post,
        userText: item.userText,
        transcript: item.transcript,
        images,
        gaps,
        note: item.note,
        existingTags,
        language: outputLanguage(),
        now: new Date(),
      })
    );
    // 平台自己有标题的（YouTube、小红书、Reddit、网页）留着，用户认得它；抖音、TikTok、Instagram、X 的「标题」是文案的第一行，
    // 常常是一整段话——换成模型起的。上传的文件名、空标题也换成模型起的。
    const keepTitle = item.source === "link" && item.title && (item.platform === "youtube" || item.platform === "xiaohongshu" || item.platform === "reddit" || item.platform === "web");
    const { error } = await db
      .from("items")
      .update({
        understanding: understanding as unknown as Json,
        title: keepTitle ? item.title : understanding.title || item.title || null,
        summary: understanding.summary,
        content_type: understanding.contentType,
        category: understanding.category,
        ...(item.tagsLocked ? {} : { tags: understanding.tags }),
      })
      .eq("id", itemId)
      .eq("status", "analyzing");
    if (error) throw new Error(`保存理解结果失败: ${error.message}`);
    return { ok: true, counts };
  } catch (e) {
    const error = messageOf(e);
    await markFailed(itemId, item.understanding ? `重新分析没成，留着上次的结果：${error}` : `理解失败：${error}`, item.understanding !== null);
    return { ok: false, error, counts };
  }
}

/** ④ 建索引、并入图谱，然后这条内容就绪。向量 / 图谱没成不拦就绪，原因记在 error 里。 */
async function indexItemStep(itemId: string): Promise<{ counts: Counts }> {
  "use step";
  const counts: Counts = {};
  const { db, item } = await load(itemId);
  if (!item || item.status !== "analyzing" || !item.understanding) return { counts };
  const u = item.understanding;
  const input = { title: item.title, author: item.author, url: item.url, note: item.note, post: item.post, userText: item.userText, transcript: item.transcript, tags: item.tags, understanding: u };
  const problems: string[] = [];
  let embedding: number[] | null = null;
  if (process.env.VOYAGE_API_KEY) {
    try {
      [embedding] = await meterInto(counts, () => embedTexts([buildEmbeddingText(input)], "document"));
    } catch (e) {
      problems.push(`语义索引没建成（${messageOf(e).slice(0, 120)}）`);
    }
  } else problems.push("没配 VOYAGE_API_KEY：这条只能按关键词搜，图谱只按名字归并");
  try {
    await meterInto(counts, () => linkItemEntities(db, defaultGraphDeps(), { userId: item.userId, itemId, entities: u.entities, relations: u.relations }));
    const { error } = await db.rpc("prune_orphan_entities", { p_user_id: item.userId });
    if (error) console.error(`清理没人用的实体失败 user=${item.userId}: ${error.message}`);
  } catch (e) {
    problems.push(`没有并入知识图谱（${messageOf(e).slice(0, 120)}）`);
  }
  const { error } = await db
    .from("items")
    .update({
      status: "ready",
      search_text: buildSearchText(input),
      embedding: embedding ? JSON.stringify(embedding) : null,
      processed_at: new Date().toISOString(),
      // 没配向量服务是部署的选择，不算这条内容的问题，不写进 error
      error: problems.filter((p) => !p.startsWith("没配")).join("；") || null,
    })
    .eq("id", itemId)
    .eq("status", "analyzing");
  if (error) {
    await markFailed(itemId, `保存索引失败: ${error.message}`, true);
  }
  return { counts };
}

/** 收尾：这一轮用掉的量加到这条内容的账上（成功失败都记——钱已经花了）。 */
async function recordUsageStep(itemId: string, counts: Counts): Promise<void> {
  "use step";
  if (Object.keys(counts).length === 0) return;
  const db = getServiceClient();
  const { data: row, error } = await db.from("items").select("usage").eq("id", itemId).maybeSingle();
  if (error || !row) return;
  const usage: Counts = {};
  for (const [k, n] of Object.entries((row.usage ?? {}) as Record<string, unknown>)) if (typeof n === "number") usage[k] = n;
  for (const [k, n] of Object.entries(counts)) usage[k] = (usage[k] ?? 0) + n;
  const { error: upErr } = await db.from("items").update({ usage: usage as Json, cost_usd: estimateUsd(usage) }).eq("id", itemId);
  if (upErr) console.error(`记用量失败 item=${itemId}: ${upErr.message}`);
}

/**
 * 收尾：处理到一半被用户删掉的内容，把这一轮后来又写出来的文件清掉。
 * 删除那一刻已经把行、存储桶里的文件、服务器磁盘上的原片都删了（lib/vault/service.ts 的 removeItem），
 * 但后台任务不知道，会接着把下载到一半的视频、抽出来的帧写出来——行已经没了，这些文件就成了没人管的。
 * 查不出这条内容还在不在的时候不动：宁可多留，也不误删。
 */
async function removeFilesIfDeletedStep(itemId: string, userId: string): Promise<void> {
  "use step";
  const db = getServiceClient();
  const { data, error } = await db.from("items").select("id").eq("id", itemId).eq("user_id", userId).maybeSingle();
  if (error || data) return;
  await removeItemFiles(db, userId, itemId);
  await removeLocalItemFiles(userId, itemId);
}

function add(into: Counts, from: Counts) {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

export async function processItem(itemId: string) {
  "use workflow";
  const counts: Counts = {};
  const fetched = await fetchItemStep(itemId);
  add(counts, fetched.counts);
  if (fetched.ok) {
    // 原片存不下的视频，读取那一步已经趁数据在手上把画面和声音读了
    if (!fetched.digested) add(counts, (await digestItemStep(itemId)).counts);
    const understood = await understandItemStep(itemId);
    add(counts, understood.counts);
    if (understood.ok) add(counts, (await indexItemStep(itemId)).counts);
  }
  await recordUsageStep(itemId, counts);
  if (fetched.userId) await removeFilesIfDeletedStep(itemId, fetched.userId);
}
