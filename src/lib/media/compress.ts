import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { probeMedia, runFfmpeg, withTempDir } from "./ffmpeg";
import { compressArgs, planCompression, type CompressionPlan } from "./compress-plan";

/**
 * 把一个存不下的视频压成一份放得进存储桶的副本（H.264 + AAC 的 mp4，能在浏览器里直接播、能拖进度条）。
 * 给页面播放和「点时间跳到那一刻」用；读内容（抽帧、转写）用的还是原片。要 ffmpeg。
 * 原片在磁盘上（input 是它的路径，下载时直接写的盘）：只读它，不改不删；压出来的副本在存档上限以内，读进内存返回。
 *
 * 码率是按「目标大小 ÷ 时长」算的（见 compress-plan.ts）；编码器不保证正好卡在目标上，出来的文件比上限大就按比例降码率再压一次，
 * 还大就放弃（返回 null 的原因）。太长的视频（压到上限以内画面没法看）直接不压。
 */
export type CompressedVideo = { data: Uint8Array; plan: CompressionPlan; durationS: number; width: number | null; height: number | null };

export async function compressVideo(input: string, maxBytes: number): Promise<CompressedVideo | { skipped: string }> {
  return withTempDir(async (dir) => {
    const probe = await probeMedia(input);
    let plan = planCompression(probe.duration, maxBytes, { hasAudio: probe.hasAudio, sourceHeight: probe.height });
    if (!plan) return { skipped: `视频有 ${Math.round(probe.duration / 60)} 分钟，压到 ${Math.round(maxBytes / 1024 / 1024)} MB 以内画面没法看` };
    const output = path.join(dir, "out.mp4");
    for (let attempt = 0; attempt < 2; attempt++) {
      // 最慢按实时算（慢机器、高分辨率原片），至少给五分钟
      await runFfmpeg(compressArgs(input, output, plan), { timeoutMs: Math.max(300_000, probe.duration * 1000) });
      const data = new Uint8Array(await readFile(output));
      if (data.byteLength <= maxBytes) {
        const out = await probeMedia(output).catch(() => null);
        return { data, plan, durationS: Math.round((out?.duration ?? probe.duration) * 100) / 100, width: out?.width ?? null, height: out?.height ?? plan.height };
      }
      // 超了：按超出的比例降视频码率（再留一成余量）重压一次
      const scaled = Math.floor(plan.videoKbps * (maxBytes / data.byteLength) * 0.9);
      const again = planCompression(probe.duration, maxBytes, { hasAudio: probe.hasAudio, sourceHeight: probe.height, videoKbps: scaled });
      if (!again) break;
      plan = again;
    }
    return { skipped: "压了两次还是超过上限" };
  });
}
