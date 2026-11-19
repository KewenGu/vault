import "server-only";
import { fetchDouyinVideo } from "./douyin";
import { fetchInstagramPost } from "./instagram";
import type { LinkRef } from "./link";
import { VIDEO_MAX_BYTES } from "@/lib/media/files";
import { fetchTikTokVideo } from "./tiktok";
import { SourceFetchError, type SourcePlatform, type FetchedPost } from "./types";
import { fetchWebPage } from "./web";
import { fetchXhsNote } from "./xhs";
import { fetchXPost } from "./x";
import { YouTubeBlockedError, fetchYouTubeVideo } from "./youtube";
import { fetchYouTubeViaApify } from "./youtube-apify";
import { mapYtdlpInfo, ytdlpInfo, ytdlpPath } from "./ytdlp";

/**
 * 按平台读一条帖子（收藏夹后台任务的第一步）。各平台怎么读、花不花钱：
 *
 * | 平台 | 怎么读 | 花费 |
 * |---|---|---|
 * | 小红书 | 直接读分享页（要链接里的口令） | 免费 |
 * | 抖音 | Apify actor | 约 $0.008 / 条 |
 * | TikTok | 直接读视频页 | 免费 |
 * | Instagram | Apify 官方 actor | 约 $0.003 / 条 |
 * | YouTube | App 的播放接口（字幕 + 360p 视频）；被拦时（云服务器上）走 Apify，只有字幕 | 免费；走 Apify 时约 $0.004 / 条 |
 * | X | FxTwitter 公开接口 → 官方嵌入接口 | 免费 |
 * | 网页 | Jina Reader → 自己抓；本机有 yt-dlp 时认别的视频站 | Jina 带密钥时 $0.0005 |
 */

/**
 * YouTube 的播放接口不给读时换一条路，按这个顺序：
 * 1. 本机有 yt-dlp：让它再试一次（不花钱，还能把视频下下来）。
 * 2. 视频在、只是不给这台机器看（云服务器的机房 IP 被要求登录验证），又配了 APIFY_TOKEN：走 Apify（见 youtube-apify.ts）。
 * 都不行就报原来的错（页面上可以贴文字）。
 */
async function fetchYouTube(ref: LinkRef): Promise<FetchedPost> {
  const canYtdlp = ytdlpPath() !== null;
  try {
    return await fetchYouTubeVideo(ref, VIDEO_MAX_BYTES, canYtdlp);
  } catch (e) {
    if (!(e instanceof SourceFetchError)) throw e;
    const info = canYtdlp ? await ytdlpInfo(ref.url).catch(() => null) : null;
    if (info) return mapYtdlpInfo(info, ref);
    if (e instanceof YouTubeBlockedError && process.env.APIFY_TOKEN?.trim()) return fetchYouTubeViaApify(ref);
    throw e;
  }
}

const FETCHERS: Record<SourcePlatform, (ref: LinkRef) => Promise<FetchedPost>> = {
  xiaohongshu: (ref) => fetchXhsNote(ref, VIDEO_MAX_BYTES),
  douyin: (ref) => fetchDouyinVideo(ref),
  tiktok: (ref) => fetchTikTokVideo(ref, VIDEO_MAX_BYTES),
  instagram: (ref) => fetchInstagramPost(ref),
  youtube: fetchYouTube,
  x: (ref) => fetchXPost(ref, VIDEO_MAX_BYTES),
  web: (ref) => fetchWebPage(ref),
};

export function fetchPost(ref: LinkRef): Promise<FetchedPost> {
  return FETCHERS[ref.platform](ref);
}
