import { extractSpeechAudio } from "@/lib/media/audio";
import { canDigestVideo } from "@/lib/media/frames";
import { likelyChinese } from "@/lib/media/transcript";
import { getServiceClient } from "@/lib/supabase/service";
import { estimateUsd } from "@/lib/usage/prices";
import { PLAYABLE_EXT, PLAYABLE_MIME, needsPlayableCopy, toPlayableAudio } from "@/lib/vault/journal-audio";
import { buildJournalSearchText, docText } from "@/lib/vault/journal-doc";
import { getEntry, getMedia, journalDir, listMedia, setSearchText, updateMedia, type MediaPatch } from "@/lib/vault/journal-store";
import { SPEECH_MAX_SECONDS, transcribeSpeech } from "@/lib/vault/speech";
import { BUCKET } from "@/lib/vault/store";

/**
 * 日记里的一段录音传上来之后的后台任务：转成各种浏览器都能播的格式（见 lib/vault/journal-audio.ts），
 * 把说的话转成带时间的文字（和收藏库里的音频走同一套：豆包 → OpenAI → 本机 whisper），再把这篇日记搜索用的文字更新一遍。
 *
 * - 录音本身已经在存储桶里了：转格式、转文字哪一步没做成都不丢录音，只在 notes 里记一句「没做成什么」（页面上列出来，可以重试）。
 * - 只有读不到文件这类意外才算 failed。
 * - 每一步写回去之前都看这个文件还是不是「处理中」：处理到一半被删掉 / 被重试了就不再写，后写出来的文件清掉。
 */

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const extOf = (path: string) => path.split(".").pop() ?? "bin";

async function transcribeJournalAudioStep(mediaId: string, userId: string): Promise<void> {
  "use step";
  const db = getServiceClient();
  const media = await getMedia(db, userId, mediaId);
  if (!media || media.kind !== "audio" || media.status !== "processing") return;
  const notes: string[] = [];
  const counts: Record<string, number> = {};
  const patch: MediaPatch = {};
  let written: string | null = null;
  try {
    const { data: blob, error } = await db.storage.from(BUCKET).download(media.path);
    if (error || !blob) throw new Error(`读取录音失败: ${error?.message ?? "文件不在"}`);
    const raw = new Uint8Array(await blob.arrayBuffer());
    const ext = extOf(media.path);
    if (!canDigestVideo()) {
      notes.push(`这台机器没有 ffmpeg：没有转成文字${needsPlayableCopy(ext) ? "，录音也还是浏览器录出来的格式（有的浏览器可能播不了、拖不了进度）" : ""}`);
    } else {
      if (needsPlayableCopy(ext)) {
        try {
          const playable = await toPlayableAudio(raw, ext);
          const path = `${journalDir(userId, media.entryId)}/${media.id}.${PLAYABLE_EXT}`;
          const { error: upErr } = await db.storage.from(BUCKET).upload(path, new Blob([playable as BlobPart], { type: PLAYABLE_MIME }), { contentType: PLAYABLE_MIME, upsert: true });
          if (upErr) throw new Error(upErr.message);
          written = path;
          Object.assign(patch, { path, mime: PLAYABLE_MIME, bytes: playable.byteLength });
        } catch (e) {
          notes.push(`录音没能转成通用的格式（${messageOf(e).slice(0, 120)}），还是浏览器录出来的样子：有的浏览器可能播不了、拖不了进度`);
        }
      }
      try {
        const speechAudio = await extractSpeechAudio(raw, ext, SPEECH_MAX_SECONDS);
        patch.durationS = Math.round(speechAudio.probe.duration * 100) / 100;
        const entry = await getEntry(db, userId, media.entryId);
        // 这篇日记里已经写了字就按它猜语言；还没写的按界面语言（默认中文）
        const words = entry ? `${entry.title}\n${docText(entry.doc)}`.trim() : "";
        const chinese = words ? likelyChinese("", words) : process.env.VAULT_LANGUAGE?.trim().toLowerCase() !== "en";
        const speech = await transcribeSpeech(counts, speechAudio, chinese ? "zh" : null);
        patch.transcript = speech.transcript;
        notes.push(...speech.notes);
        if (speech.transcript && speechAudio.probe.duration > speechAudio.seconds + 1) notes.push(`只转写了前 ${Math.round(speechAudio.seconds / 60)} 分钟`);
      } catch (e) {
        notes.push(`没有转成文字：${messageOf(e).slice(0, 160)}`);
      }
    }
    const usage = { ...media.usage };
    for (const [k, n] of Object.entries(counts)) usage[k] = (usage[k] ?? 0) + n;
    const saved = await updateMedia(db, userId, media.id, { ...patch, status: "ready", error: null, notes, usage, costUsd: estimateUsd(usage) }, "processing");
    if (!saved) {
      // 处理的这会儿被删掉（或被重试）了：刚写出来的那份没人指着，清掉
      if (written) await db.storage.from(BUCKET).remove([written]);
      return;
    }
    // 换了格式：原来那份不要了
    if (written && written !== media.path) {
      const { error: rmErr } = await db.storage.from(BUCKET).remove([media.path]);
      if (rmErr) console.error(`删除录音的原文件失败 ${media.path}: ${rmErr.message}`);
    }
  } catch (e) {
    console.error(`日记录音处理出错 media=${mediaId}: ${messageOf(e)}`);
    if (written) await db.storage.from(BUCKET).remove([written]);
    await updateMedia(db, userId, media.id, { status: "failed", error: messageOf(e).slice(0, 500) }, "processing").catch((err) => console.error(`标记失败出错 media=${mediaId}: ${messageOf(err)}`));
    return;
  }
  await refreshSearchText(userId, media.entryId);
}

/** 这篇日记搜索用的文字按现在的正文和转写结果重算一遍。没算成不算失败（下次保存日记时会再算）。 */
async function refreshSearchText(userId: string, entryId: string): Promise<void> {
  try {
    const db = getServiceClient();
    const entry = await getEntry(db, userId, entryId);
    if (!entry) return;
    const media = await listMedia(db, userId, entryId);
    await setSearchText(db, userId, entryId, buildJournalSearchText(entry, media.map((m) => m.transcript)));
  } catch (e) {
    console.error(`更新日记的搜索文字出错 entry=${entryId}: ${messageOf(e)}`);
  }
}

export async function processJournalAudio(mediaId: string, userId: string) {
  "use workflow";
  await transcribeJournalAudioStep(mediaId, userId);
}
