/**
 * 这台机器配齐了没有（纯函数，状态页用）：每一项能力是好的、缺的，缺了会怎样、怎么补。
 * 一条内容「读得不完整」十有八九是这里缺了东西——视频没抽画面、口播没转写——而不是模型偷懒，
 * 所以把它摆在一个看得见的地方，而不是让人去猜。
 */

export type SetupFacts = {
  anthropic: boolean;
  voyage: boolean;
  apify: boolean;
  jina: boolean;
  /** path = 找到的 ffmpeg；error = 找到了但不能用（版本太旧…）的原因 */
  ffmpeg: { path: string | null; error: string | null };
  asr: { volc: boolean; openai: boolean; whisper: string | null; whisperHint: string | null };
  ytdlp: string | null;
  /** 存储桶的单文件上限（字节；null = 桶没设上限，undefined = 没读到）和代码里的存档上限 */
  storage: { bucketLimit: number | null | undefined; wanted: number };
};

/**
 * ffmpeg 找到了但不能用时，状态页上写什么（纯函数）。versionOutput 是 `ffmpeg -version` 的输出（拿到了的话）：
 * 一台机器上常常不止一个 ffmpeg（系统自带的、Homebrew 的、自己下的），光说「版本过旧」不知道说的是哪一个。
 */
export function describeFfmpegProblem(bin: string, message: string, versionOutput: string): string {
  const version = /^ffmpeg version (\S+)/m.exec(versionOutput)?.[1];
  return version ? `用的是 ${bin}，版本 ${version}，不够新：要 8.1.3 或更新（9.x 要 9.0.2 或更新）` : `用的是 ${bin}：${message}`;
}

export type SetupState = "ok" | "missing" | "optional";
export type SetupCheck = { key: string; label: string; state: SetupState; detail: string; effect: string; fix: string };

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** 存档上限这一项：桶的上限接口读得到；项目全局的读不到，只能提醒去哪看。 */
function storageCheck({ bucketLimit, wanted }: SetupFacts["storage"]): SetupCheck {
  const base = {
    key: "storage",
    label: "存档原片（存储上限）",
    effect: `视频原片和上传的文件单个最多存 ${mb(wanted)} MB。存储那边的上限不够时，大视频照样读画面和声音，只是不留原片、不能在这里播放。`,
  };
  const globalHint = "项目的全局上传上限这里读不到：控制台 Storage → Settings → Upload file size limit（免费套餐封顶 50 MB）";
  if (bucketLimit === undefined) return { ...base, state: "missing", detail: "没读到存储桶 vault（迁移没跑，或者密钥不对）", fix: "在 Supabase 的 SQL Editor 里运行 supabase/migrations 下的迁移。" };
  if (bucketLimit !== null && bucketLimit < wanted) {
    return {
      ...base,
      state: "missing",
      detail: `存储桶的单文件上限是 ${mb(bucketLimit)} MB，比这里的 ${mb(wanted)} MB 小`,
      fix: `在 Supabase 的 SQL Editor 里运行：update storage.buckets set file_size_limit = ${wanted} where id = 'vault'; 然后确认${globalHint}。`,
    };
  }
  return { ...base, state: "ok", detail: `存储桶的上限够了（${bucketLimit === null ? "没设上限" : `${mb(bucketLimit)} MB`}）。${globalHint}——大文件还是存不进去的话，就是它`, fix: "" };
}

export function setupChecks(f: SetupFacts): SetupCheck[] {
  const asrVia = [f.asr.volc ? "豆包语音识别" : "", f.asr.openai ? "OpenAI whisper-1" : "", f.asr.whisper ? `本机 whisper（${f.asr.whisper}）` : ""].filter(Boolean);
  const ffmpegOk = !!f.ffmpeg.path && !f.ffmpeg.error;
  return [
    {
      key: "claude",
      label: "理解内容（Claude）",
      state: f.anthropic ? "ok" : "missing",
      detail: f.anthropic ? "已配置" : "没配 ANTHROPIC_API_KEY",
      effect: "没有它，任何内容都读不懂，存进来会停在「理解失败」。",
      fix: "在 .env.local 里填 ANTHROPIC_API_KEY，重启。",
    },
    {
      key: "ffmpeg",
      label: "看视频画面（ffmpeg）",
      state: ffmpegOk ? "ok" : "missing",
      detail: ffmpegOk ? f.ffmpeg.path! : (f.ffmpeg.error ?? "这台机器上没找到 ffmpeg"),
      effect: "没有它，视频只看封面和文案：画面抽不出来，声音也导不出来（下面的语音转写跟着做不了）。上传的视频和音频完全读不了。",
      fix: "在 .env.local 里用 FFMPEG_PATH 指到一个够新的 ffmpeg（SM-Intelligence 的 .env.local 里配过的话，把那一行抄过来），或者 brew upgrade ffmpeg。改完重启。",
    },
    {
      key: "asr",
      label: "听懂说的话（语音转写）",
      state: asrVia.length > 0 && ffmpegOk ? "ok" : "missing",
      detail: asrVia.length === 0 ? (f.asr.whisperHint ?? "三条转写通道一条都没配") : ffmpegOk ? `可用：${asrVia.join("、")}` : `配了 ${asrVia.join("、")}，但没有可用的 ffmpeg，导不出音轨`,
      effect: "没有它，口播类的视频（讲方法、讲知识、测评）只能看到画面上的字和文案，内容要点会很笼统。YouTube 有平台字幕的不受影响。",
      fix: asrVia.length > 0 ? "转写通道已经有了，先把上面的 ffmpeg 配好。" : "任选其一填进 .env.local：OPENAI_API_KEY（最省事），或 VOLC_SPEECH_API_KEY（豆包，便宜），或在本机装 whisper（不花钱）。",
    },
    storageCheck(f.storage),
    {
      key: "apify",
      label: "读抖音、Instagram（Apify）",
      state: f.apify ? "ok" : "missing",
      detail: f.apify ? "已配置" : "没配 APIFY_TOKEN",
      effect: "没有它，抖音和 Instagram 的链接读不了（可以手动把文案贴进来）。小红书、TikTok、YouTube、X、网页不需要它。",
      fix: "在 .env.local 里填 APIFY_TOKEN。",
    },
    {
      key: "voyage",
      label: "语义搜索和图谱归并（Voyage）",
      state: f.voyage ? "ok" : "missing",
      detail: f.voyage ? "已配置" : "没配 VOYAGE_API_KEY",
      effect: "没有它，只能按关键词搜（搜不到换了说法的内容），图谱里同一个东西的不同叫法不会合并。",
      fix: "在 .env.local 里填 VOYAGE_API_KEY，然后把已有的内容「重新分析」一遍补上索引。",
    },
    {
      key: "ytdlp",
      label: "别的视频站（yt-dlp）",
      state: f.ytdlp ? "ok" : "optional",
      detail: f.ytdlp ?? "没装",
      effect: "没有它，B 站、Vimeo 这类链接只按网页读文字；YouTube 的播放接口不给读时也没有后备。",
      fix: "macOS：brew install yt-dlp。",
    },
    {
      key: "jina",
      label: "读网页正文（Jina Reader）",
      state: f.jina ? "ok" : "optional",
      detail: f.jina ? "已配置密钥" : "没配密钥，用免费额度",
      effect: "不配也能读网页；免费额度有限速，连着存很多篇文章时可能读不到。",
      fix: "在 .env.local 里填 JINA_API_KEY。",
    },
  ];
}
