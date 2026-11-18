/**
 * 压缩副本的参数怎么定（纯函数，测试直接断言）：给定时长和目标大小，算出码率、分辨率、帧率。
 *
 * 总码率 = 目标大小 ÷ 时长，先留出音频，剩下的给视频；视频码率够多少就用多大的画面——码率不够还硬撑大画面，
 * 出来全是马赛克，不如缩小了看得清。口播类视频（人不怎么动）在这些码率下是能看的；动作多的画面会糊，这是这个大小的代价。
 */

export type CompressionPlan = {
  /** 画面高度（像素）；原片比它矮就不放大 */
  height: number;
  fps: number;
  videoKbps: number;
  /** 0 = 没有音轨 */
  audioKbps: number;
  mono: boolean;
};

/** 目标大小只用到上限的这么多：编码器控制码率有误差，容器本身也占一点 */
const FILL = 0.9;
/** 视频码率低于这个数就不压了（240p 也没法看） */
export const MIN_VIDEO_KBPS = 50;

/** 视频码率 → 画面高度和帧率 */
function pictureFor(videoKbps: number): { height: number; fps: number } {
  if (videoKbps >= 1000) return { height: 720, fps: 30 };
  if (videoKbps >= 400) return { height: 480, fps: 30 };
  if (videoKbps >= 90) return { height: 360, fps: 24 };
  return { height: 240, fps: 20 };
}

/**
 * 算压缩参数。压不出能看的东西（太长）返回 null。opts.videoKbps：第一次压出来超了、按比例降码率重压时直接指定。
 */
export function planCompression(
  durationS: number,
  maxBytes: number,
  opts: { hasAudio?: boolean; sourceHeight?: number | null; videoKbps?: number } = {}
): CompressionPlan | null {
  if (!(durationS > 0) || !(maxBytes > 0)) return null;
  const totalKbps = (maxBytes * FILL * 8) / durationS / 1000;
  const hasAudio = opts.hasAudio !== false;
  // 码率紧的时候音频用单声道 48k（人声够清楚），宽裕了给立体声 96k
  const audioKbps = !hasAudio ? 0 : totalKbps >= 600 ? 96 : totalKbps >= 250 ? 64 : 48;
  const videoKbps = Math.floor(opts.videoKbps ?? totalKbps - audioKbps);
  if (videoKbps < MIN_VIDEO_KBPS) return null;
  const picture = pictureFor(videoKbps);
  const height = opts.sourceHeight && opts.sourceHeight > 0 ? Math.min(picture.height, opts.sourceHeight) : picture.height;
  return { height, fps: picture.fps, videoKbps, audioKbps, mono: audioKbps > 0 && audioKbps < 64 };
}

/** ffmpeg 的参数（纯函数）。宽度跟着高度按比例走、取偶数；faststart 让浏览器不用下完整个文件就能开始播。 */
export function compressArgs(input: string, output: string, plan: CompressionPlan): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(plan.audioKbps > 0 ? ["-map", "0:a:0?"] : ["-an"]),
    "-vf",
    `scale=-2:'min(${plan.height},ih)',fps=${plan.fps}`,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-b:v",
    `${plan.videoKbps}k`,
    "-maxrate",
    `${Math.round(plan.videoKbps * 1.5)}k`,
    "-bufsize",
    `${plan.videoKbps * 3}k`,
    "-pix_fmt",
    "yuv420p",
    ...(plan.audioKbps > 0 ? ["-c:a", "aac", "-b:a", `${plan.audioKbps}k`, "-ac", plan.mono ? "1" : "2"] : []),
    "-movflags",
    "+faststart",
    "-y",
    output,
  ];
}

/** 页面和提示里怎么叫这份副本：「360p」 */
export const pictureLabel = (plan: Pick<CompressionPlan, "height">) => `${plan.height}p`;
