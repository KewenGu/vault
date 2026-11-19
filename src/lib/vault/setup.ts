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
  /** 留在这台服务器磁盘上的大视频原片：放在哪、几个文件、占多少、这个盘还剩多少（null = 没读到） */
  localMedia: { dir: string; files: number; bytes: number; freeBytes: number | null };
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

/**
 * 存档上限这一项。有两道上限：存储桶自己的（接口读得到）和 Supabase 项目全局的（读不到；免费套餐封顶 50 MB）。
 * 默认的 50 MB 在哪种套餐上都存得进去；想存更大的要付费套餐 + 调 VAULT_STORE_MAX_MB。
 */
function storageCheck({ bucketLimit, wanted }: SetupFacts["storage"]): SetupCheck {
  const base = {
    key: "storage",
    label: "存档原片（存储上限）",
    effect: `视频原片和上传的文件单个最多往 Supabase 存 ${mb(wanted)} MB。链接里更大的视频照样读画面和声音，原片不进 Supabase，留在这台服务器的磁盘上（见「大视频的原片」）。`,
  };
  const raise = "想存更大的：Supabase 要付费套餐（免费套餐的全局上传上限封顶 50 MB），在控制台 Storage → Settings 调高之后，在 .env.local 里设 VAULT_STORE_MAX_MB（最多 200）";
  if (bucketLimit === undefined) return { ...base, state: "missing", detail: "没读到存储桶 vault（迁移没跑，或者密钥不对）", fix: "在 Supabase 的 SQL Editor 里运行 supabase/migrations 下的迁移。" };
  if (bucketLimit !== null && bucketLimit < wanted) {
    return {
      ...base,
      state: "missing",
      detail: `存储桶的单文件上限是 ${mb(bucketLimit)} MB，比这里设的 ${mb(wanted)} MB 小`,
      fix: `在 Supabase 的 SQL Editor 里运行迁移 20261118000001_bucket_limit.sql，或者把 VAULT_STORE_MAX_MB 调回 ${mb(bucketLimit)} 以内。`,
    };
  }
  return { ...base, state: "ok", detail: `单个最多 ${mb(wanted)} MB${wanted > 50 * 1024 * 1024 ? "（超过 50 MB 的要付费套餐才存得进去）" : ""}。${raise}`, fix: "" };
}

/** 这个盘剩下不到这么多就提醒：再存一条大视频（最多几百 MB）可能就满了 */
const LOCAL_FREE_WARN_BYTES = 2 * 1024 * 1024 * 1024;
const gb = (bytes: number) => (bytes / 1024 / 1024 / 1024).toFixed(1);

/** 留在这台服务器磁盘上的大视频原片：占了多少、还剩多少。不自动清理，快满了在这里提醒。 */
function localMediaCheck({ dir, files, bytes, freeBytes }: SetupFacts["localMedia"]): SetupCheck {
  const tight = freeBytes !== null && freeBytes < LOCAL_FREE_WARN_BYTES;
  return {
    key: "localMedia",
    label: "大视频的原片（这台服务器的磁盘）",
    state: tight ? "missing" : "ok",
    detail: `${dir}：${files} 个文件，共 ${gb(bytes)} GB${freeBytes === null ? "" : `；这个盘还剩 ${gb(freeBytes)} GB`}`,
    effect: "超过存档上限的视频，原片留在这里，页面从这里播放。不会自动清理，也只有这一台机器上有。磁盘满了，新的大视频会下载不下来（只读封面和文字）。",
    fix: tight ? `磁盘快满了：删掉 ${dir} 下不要的原片（对应的内容和读出来的画面、口播都还在，只是不能在这里播放），或者给这台机器加磁盘。` : "",
  };
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
    localMediaCheck(f.localMedia),
    {
      key: "apify",
      label: "读抖音、Instagram，YouTube 的后备（Apify）",
      state: f.apify ? "ok" : "missing",
      detail: f.apify ? "已配置" : "没配 APIFY_TOKEN",
      effect: "没有它，抖音和 Instagram 的链接读不了（可以手动把文案贴进来）。YouTube 不给这台机器读时（云服务器上会这样）也靠它读标题、简介和字幕。小红书、TikTok、X、网页不需要它。",
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
      effect: "没有它，B 站、Vimeo 这类链接只按网页读文字；YouTube 的播放接口不给读时只能走 Apify（没有画面）。",
      fix: "macOS：brew install yt-dlp。Docker 部署的镜像里自带，不用另装。",
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
