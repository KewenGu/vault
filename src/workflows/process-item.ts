import { getServiceClient } from "@/lib/supabase/service";
import { meterInto, recordCall } from "@/lib/usage/meter";
import { OPENAI_ASR_COUNT_KEY, estimateUsd } from "@/lib/usage/prices";
import { AsrNotEnabledError, asrConfig, transcribe } from "@/lib/asr/volc";
import { openaiAsrConfig, transcribeWithOpenAI } from "@/lib/asr/openai";
import { localWhisper, transcribeLocally, whisperSetupHint } from "@/lib/asr/whisper-local";
import { embedTexts } from "@/lib/embeddings";
import { defaultGraphDeps, linkItemEntities } from "@/lib/graph/merge";
import { extractSpeechAudio } from "@/lib/media/audio";
import { IMAGE_MAX_BYTES, MAX_IMAGES, VIDEO_MAX_BYTES, TooLargeError, downloadRemote, normalizeImage, visionImage } from "@/lib/media/files";
import { canDigestVideo, contactSheets, digestVideo, sheetLayout } from "@/lib/media/frames";
import { clockTenths, cuesToText, frameNote, likelyChinese, parseTranscript, speechAt, speechLabel, type Cue } from "@/lib/media/transcript";
import { fetchPost } from "@/lib/sources/fetch-post";
import { emptyStats, type FetchedPost, type ItemMedia, type PostSnapshot } from "@/lib/sources/types";
import { ytdlpDownload } from "@/lib/sources/ytdlp";
import { buildEmbeddingText, buildSearchText } from "@/lib/vault/indexing";
import { BUCKET, audioOf, framesOf, getItemById, imagesOf, itemDir, removeItemFiles, sheetsOf, tagCounts, videoOf, type Item } from "@/lib/vault/store";
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

/** 口播最多转写前这么多秒（60 分钟；48 kbps 单声道约 22 MB，在各家语音识别的单文件上限以内——最紧的是 OpenAI 的 25 MB） */
const SPEECH_MAX_SECONDS = 3600;
/**
 * 为了读懂内容，视频最多下载这么大（默认 600 MB，`VAULT_VIDEO_READ_MAX_MB` 可以改）。
 * 和「存档」的上限（VIDEO_MAX_BYTES，存储桶单文件 50 MB）是两回事：超过存档上限的视频不存原片，
 * 但照样下载到本机抽画面、转写——2026-11-18 第一条真实的抖音视频（38 分钟、127 MB）就因为把两个上限混在一起，
 * 整条没下载，只看了封面和文案。整个文件会读进内存，所以也不能无限大。
 */
const videoReadMaxBytes = () => {
  const mb = Number(process.env.VAULT_VIDEO_READ_MAX_MB);
  return (Number.isFinite(mb) && mb >= 50 ? Math.min(mb, 2000) : 600) * 1024 * 1024;
};
const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);
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
  ...patch,
});

/** 把读到的帖子的图片 / 视频下载下来转存；下不了的记进 notes（不算失败——文字还在，照样能理解）。 */
async function storeMedia(db: Db, dir: string, post: FetchedPost): Promise<{ media: ItemMedia[]; notes: string[]; unstored: { data: Uint8Array; ext: string } | null }> {
  const media: ItemMedia[] = [];
  const notes: string[] = [];
  const images = post.images.slice(0, MAX_IMAGES);
  if (post.images.length > images.length) notes.push(`一共 ${post.images.length} 张图，只存了前 ${images.length} 张`);
  let failed = 0;
  for (const [i, file] of images.entries()) {
    try {
      const img = await normalizeImage(await downloadRemote(file, IMAGE_MAX_BYTES, 30_000));
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
  // 太大存不了档的视频：留着这份数据，读完画面和声音就丢（见 videoReadMaxBytes）
  let unstored: { data: Uint8Array; ext: string } | null = null;
  if (post.video) {
    const readMax = videoReadMaxBytes();
    try {
      // 没有能直接下的地址的（别的视频站）交给本机的 yt-dlp：它按大小挑清晰度，挑的就是存得下的那一档
      const data = post.video.via === "ytdlp" ? await ytdlpDownload(post.video.url, VIDEO_MAX_BYTES) : await downloadRemote(post.video, readMax, 600_000);
      if (data.byteLength <= VIDEO_MAX_BYTES) {
        const path = `${dir}/video.mp4`;
        await upload(db, path, data, "video/mp4");
        // yt-dlp 下的是按大小挑的那一档，宽高和视频信息里写的不一定一样：留空，抽画面时按实际的补
        const sized = post.video.via === "ytdlp" ? { width: null, height: null } : { width: post.video.width ?? null, height: post.video.height ?? null };
        media.push({ role: "video", path, mime: "video/mp4", ...sized, bytes: data.byteLength, durationS: post.video.durationS });
      } else {
        unstored = { data, ext: "mp4" };
        notes.push(`原片没有存档（${megabytes(data.byteLength)} MB，超过 ${megabytes(VIDEO_MAX_BYTES)} MB 的上限）：画面和声音照常读，但这里不能播放，要看去原链接`);
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
async function fetchLink(db: Db, item: Item, counts: Counts): Promise<void> {
  if (!item.platform || !item.externalId || !item.url) throw new Error("这条内容没有链接");
  const ref = { platform: item.platform, externalId: item.externalId, url: item.url };
  let post: FetchedPost;
  try {
    post = await meterInto(counts, () => fetchPost(ref));
  } catch (e) {
    if (!item.userText?.trim()) throw e;
    const { error } = await db.from("items").update({ status: "analyzing" }).eq("id", item.id);
    if (error) throw new Error(`更新失败: ${error.message}`);
    return;
  }
  // 重新读取：先清掉上一轮的文件（图片数量可能变了）
  await removeItemFiles(db, item.userId, item.id);
  const stored = await storeMedia(db, itemDir(item.userId, item.id), post);
  let media = stored.media;
  let transcript: string | null = post.captions || null;
  let durationS = post.video?.durationS ?? null;
  let digestNotes: string[] = [];
  let cuts: number[] = [];
  if (stored.unstored) {
    // 原片存不下：趁数据还在手上，现在就把画面和声音读出来（存下来的视频是下一步从存储桶里取出来读的）
    try {
      const language = likelyChinese(post.platform, `${post.title}\n${post.text}\n${item.note}`) ? "zh" : null;
      const d = await digestVideoBytes(db, { id: item.id, userId: item.userId, captions: post.captions ?? null, language }, stored.unstored.data, stored.unstored.ext, counts);
      media = [...media, ...d.frames, ...d.sheets];
      transcript = d.transcript;
      digestNotes = d.notes;
      cuts = d.cuts;
      durationS = d.durationS ?? durationS;
    } catch (e) {
      digestNotes = [`没有抽出视频画面（${messageOf(e).slice(0, 120)}），只看了封面和文字`];
    }
  }
  const snapshot = emptyPost({
    text: post.text,
    publishedAt: post.publishedAt,
    stats: post.stats,
    hashtags: post.hashtags,
    topComments: post.topComments,
    music: post.music,
    notes: [...post.notes, ...stored.notes],
    authorId: post.author.id,
    durationS,
    digestNotes,
    transcriptFrom: post.captions ? "captions" : transcript ? "asr" : null,
    cuts,
  });
  const { error } = await db
    .from("items")
    .update({
      status: "analyzing",
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
}

/**
 * ① 上传的文件：浏览器直传到 `<目录>/upload.<扩展名>`（items.media 里登记着），这里把它变成能用的样子——
 * 图片统一成 JPEG（摆正、长边 ≤ 2160，原文件删掉）；视频 / 音频原样留着；文字文件读成正文（文件删掉）。
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
        img = await normalizeImage(data);
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

async function fetchItemStep(itemId: string): Promise<StepResult> {
  "use step";
  const counts: Counts = {};
  const { db, item } = await load(itemId);
  if (!item) return { ok: false, error: "这条内容不在了", counts };
  if (item.status === "analyzing") return { ok: true, counts };
  if (item.status !== "fetching") return { ok: false, error: `状态是 ${item.status}，不再读取`, counts };
  try {
    if (item.source === "link") await fetchLink(db, item, counts);
    else if (item.source === "upload") await fetchUpload(db, item);
    else {
      const { error } = await db.from("items").update({ status: "analyzing", post: emptyPost(item.post) as unknown as Json }).eq("id", itemId);
      if (error) throw new Error(`更新失败: ${error.message}`);
    }
    return { ok: true, counts };
  } catch (e) {
    const error = messageOf(e);
    await markFailed(itemId, item.understanding ? `重新读取没成，留着上次的结果：${error}` : error, item.understanding !== null);
    return { ok: false, error, counts };
  }
}

/**
 * 把音轨转成带时间的文字。三条路按顺序试，前一条走不通才试下一条：豆包语音识别（配了密钥、控制台也开通了）
 * → OpenAI whisper-1（配了 OPENAI_API_KEY）→ 本机的 whisper（命令和模型文件都在，不花钱）。
 * 都走不通就不转，notes 里说清楚各差什么。转出来是空的（没人说话）不算走不通，不再往下试。
 */
async function transcribeSpeech(counts: Counts, audio: { data: Uint8Array; seconds: number }, language: "zh" | null): Promise<{ transcript: string | null; cues: Cue[]; notes: string[] }> {
  const done = (text: string, cues: Cue[] = []) => (text ? { transcript: text, cues, notes: [] } : { transcript: null, cues: [], notes: ["没有识别出说话（可能只有音乐）"] });
  const why: string[] = [];
  const volc = asrConfig();
  if (!volc) {
    why.push("没配 VOLC_SPEECH_API_KEY");
  } else {
    try {
      const r = await meterInto(counts, async () => {
        const r = await transcribe(volc, audio.data);
        recordCall(r.countKey, Math.ceil(r.seconds ?? audio.seconds));
        return r;
      });
      return done(r.cues.length > 0 ? cuesToText(r.cues) : r.text, r.cues);
    } catch (e) {
      why.push(e instanceof AsrNotEnabledError ? e.message : `豆包语音识别出错（${messageOf(e).slice(0, 100)}）`);
      console.error(`口播：豆包语音识别没转成，换备用通道：${messageOf(e)}`);
    }
  }
  const openai = openaiAsrConfig();
  if (!openai) {
    why.push("没配 OPENAI_API_KEY");
  } else {
    try {
      const r = await meterInto(counts, async () => {
        const r = await transcribeWithOpenAI(openai, audio.data, language);
        recordCall(OPENAI_ASR_COUNT_KEY, Math.ceil(r.seconds ?? audio.seconds));
        return r;
      });
      return done(cuesToText(r.cues), r.cues);
    } catch (e) {
      why.push(`OpenAI 的转写没成（${messageOf(e).slice(0, 100)}）`);
    }
  }
  const whisper = localWhisper();
  if (whisper) {
    try {
      const r = await transcribeLocally(whisper, audio.data, audio.seconds, language);
      return done(cuesToText(r.cues), r.cues);
    } catch (e) {
      why.push(`本机的 whisper 没转出来（${messageOf(e).slice(0, 100)}）`);
    }
  } else {
    const hint = whisperSetupHint();
    if (hint) why.push(hint);
  }
  return { transcript: null, cues: [], notes: [`没有转写说的话：${why.join("；")}`] };
}

const extOf = (path: string) => path.split(".").pop() ?? "bin";
const speechLanguage = (item: Item): "zh" | null => (likelyChinese(item.platform ?? "", `${item.title}\n${item.post.text}\n${item.note}`) ? "zh" : null);

type VideoDigestResult = { frames: ItemMedia[]; sheets: ItemMedia[]; transcript: string | null; notes: string[]; cuts: number[]; durationS: number | null; width: number | null; height: number | null };

/**
 * ② 视频：测切点、抽帧、转写（平台自带字幕的只抽帧）、每帧标词、拼帧格，把帧和帧格存进存储桶。
 * 顺序是先转写再存帧：帧上「那一刻说的话」要等口播出来才知道。视频的数据由调用方给（存下来的从存储桶取，存不下的是刚下载的那份）。
 */
async function digestVideoBytes(
  db: Db,
  ctx: { id: string; userId: string; captions: string | null; language: "zh" | null },
  data: Uint8Array,
  ext: string,
  counts: Counts
): Promise<VideoDigestResult> {
  const { captions } = ctx;
  const notes: string[] = [];
  if (!canDigestVideo()) {
    notes.push(captions ? "这台机器没有 ffmpeg，没有抽视频画面，只看了封面、字幕和文字" : "这台机器没有 ffmpeg，没有抽视频画面、也没有转写口播，只看了封面和文字");
    return { frames: [], sheets: [], transcript: captions, notes, cuts: [], durationS: null, width: null, height: null };
  }
  let transcript: string | null = captions;
  const digest = await digestVideo(data, ext, { overview: true, audioMaxSeconds: SPEECH_MAX_SECONDS });
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
      sheets.push({ role: "sheet", path, mime: "image/jpeg", width: sheet.width, height: sheet.height, bytes: sheet.data.byteLength, at: sheet.from, to: sheet.to });
    }
  } catch (e) {
    // 帧格拼不出来（字体 / 内存）：没有帧格也能理解，每帧的说明里有同样的时间和词
    console.warn(`视频：帧格没拼出来 item=${ctx.id}: ${messageOf(e)}`);
  }
  return { frames, sheets, transcript, notes, cuts, durationS: Math.round(digest.probe.duration * 100) / 100, width: digest.probe.width, height: digest.probe.height };
}

/** ②（存了原片的视频）：从存储桶取出来读。 */
async function digestVideoItem(db: Db, item: Item, video: ItemMedia, counts: Counts): Promise<{ media: ItemMedia[]; transcript: string | null; notes: string[]; cuts: number[] }> {
  const captions = item.post.transcriptFrom === "captions" ? item.transcript : null;
  const kept = item.media.filter((m) => m.role !== "frame" && m.role !== "sheet");
  const d = await digestVideoBytes(db, { id: item.id, userId: item.userId, captions, language: speechLanguage(item) }, canDigestVideo() ? await download(db, video.path) : new Uint8Array(), extOf(video.path), counts);
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

/**
 * 给模型看的图：图文 / 文章 / 上传的图是每一张图；视频是封面 + 帧格（全片一览，每格下面是时间和那一刻说的话）+ 抽的每一帧
 * （说明里带时间、是不是刚切镜、那一刻说到的词；没抽成就只有封面）。
 */
async function visionImages(db: Db, item: Item): Promise<{ caption: string; data: Uint8Array }[]> {
  const frames = framesOf(item);
  const sheets = sheetsOf(item);
  const images = imagesOf(item);
  const sheetCaption = (i: number) => {
    const s = sheets[i];
    const range = s.at !== undefined && s.to !== undefined ? `（${clockTenths(s.at)}–${clockTenths(s.to)}）` : "";
    return `帧格 ${i + 1}/${sheets.length}${range}：全片画面一览，每格下面是时间和那一刻说的话`;
  };
  const picks: { caption: string; path: string }[] =
    item.kind === "video"
      ? [
          ...images.slice(0, 1).map((m) => ({ caption: "封面", path: m.path })),
          ...sheets.map((m, i) => ({ caption: sheetCaption(i), path: m.path })),
          ...frames.map((m) => ({ caption: frameNote({ at: m.at ?? 0, cut: m.cut, words: m.words }), path: m.path })),
        ]
      : images.map((m, i) => ({ caption: images.length > 1 ? `第 ${i + 1} 张图${i === 0 ? "（封面）" : ""}` : "图片", path: m.path }));
  const out: { caption: string; data: Uint8Array }[] = [];
  for (const p of picks) {
    try {
      out.push({ caption: p.caption, data: await visionImage(await download(db, p.path)) });
    } catch {
      // 这张读不出来：不给模型看
    }
  }
  return out;
}

/** ③ 理解。 */
async function understandItemStep(itemId: string): Promise<StepResult> {
  "use step";
  const counts: Counts = {};
  const { db, item } = await load(itemId);
  if (!item) return { ok: false, error: "这条内容不在了", counts };
  if (item.status !== "analyzing") return { ok: false, error: `状态是 ${item.status}，不再分析`, counts };
  try {
    const images = await visionImages(db, item);
    // 上传的文件的标题只是文件名，不算内容：画面和声音都没读到时不让模型对着文件名编
    const text = item.userText?.trim() || item.post.text || (item.source === "link" ? item.title : "");
    if (!text && images.length === 0 && !item.transcript) {
      const why = item.post.digestNotes.join("；");
      throw new Error(`没有读到任何内容（文字、画面、声音都没有），没法理解${why ? `：${why}` : ""}`);
    }
    const gaps: string[] = [];
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
    // 平台自己有标题的（YouTube、小红书、网页）留着，用户认得它；抖音、TikTok、Instagram、X 的「标题」是文案的第一行，
    // 常常是一整段话——换成模型起的。上传的文件名、空标题也换成模型起的。
    const keepTitle = item.source === "link" && item.title && (item.platform === "youtube" || item.platform === "xiaohongshu" || item.platform === "web");
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

function add(into: Counts, from: Counts) {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

export async function processItem(itemId: string) {
  "use workflow";
  const counts: Counts = {};
  const fetched = await fetchItemStep(itemId);
  add(counts, fetched.counts);
  if (fetched.ok) {
    add(counts, (await digestItemStep(itemId)).counts);
    const understood = await understandItemStep(itemId);
    add(counts, understood.counts);
    if (understood.ok) add(counts, (await indexItemStep(itemId)).counts);
  }
  await recordUsageStep(itemId, counts);
}
