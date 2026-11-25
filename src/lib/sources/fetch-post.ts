import "server-only";
import { fetchDouyinVideo } from "./douyin";
import { fetchInstagramPost } from "./instagram";
import { followMentions, type FollowDeps, type Followed } from "./follow";
import { resolveLink, type LinkRef } from "./link";
import { VIDEO_MAX_BYTES } from "@/lib/media/files";
import { RedditArchiveMiss, readRedditPost } from "./reddit";
import { fetchTikTokVideo } from "./tiktok";
import { SourceFetchError, type SourcePlatform, type FetchedPost } from "./types";
import { fetchWebPage } from "./web";
import { fetchXhsNote } from "./xhs";
import { readXPost } from "./x";
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
 * | YouTube | App 的播放接口（字幕 + 360p 视频）；被拦时（云服务器上）走 Apify：一个 actor 读信息和字幕，另一个把 360p 视频下下来 | 免费；走 Apify 时约 $0.004 / 条 + 视频每分钟 $0.00001 |
 * | X | FxTwitter 公开接口 → 官方嵌入接口；提到的帖子和链接跟着读（见 follow.ts） | 免费 |
 * | Reddit | 第三方存档 Arctic Shift（帖子 + 评论）；链接帖指向的链接跟着读；存档读不到时按网页再试一次 | 免费 |
 * | 网页 | Jina Reader → 自己抓；本机有 yt-dlp 时认别的视频站 | Jina 带密钥时 $0.0005 |
 */

/**
 * YouTube 的播放接口不给读时换一条路，按这个顺序：
 * 1. 本机有 yt-dlp：让它再试一次（不花钱，还能把视频下下来）。
 * 2. 视频在、只是不给这台机器看（云服务器的机房 IP 被要求登录验证），又配了 APIFY_TOKEN：走 Apify（见 youtube-apify.ts），
 *    信息、字幕和视频本体都从那边拿。
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

/**
 * Reddit：先问存档；存档里没有（刚发的帖子）或者存档出错，按网页再试一次（家用网络下有时读得到，机房 IP 读不到）。
 * 两边都不行，说清楚是哪种情况、接下来能怎么办。
 */
async function readReddit(ref: LinkRef): Promise<Followed> {
  try {
    return await readRedditPost(ref);
  } catch (e) {
    if (e instanceof SourceFetchError && !(e instanceof RedditArchiveMiss)) throw e;
    const miss = e instanceof RedditArchiveMiss;
    const page = await fetchWebPage({ ...ref, platform: "web" }).catch(() => null);
    if (page) {
      const why = miss ? "第三方存档里还没有这条帖子" : "第三方存档这会儿读不了";
      return { post: { ...page, platform: "reddit", externalId: ref.externalId, notes: [`${why}，内容是按网页读的：没有点赞数，评论没有单独读`, ...page.notes] }, mentions: [] };
    }
    throw new SourceFetchError(
      miss
        ? "这个 Reddit 帖子读不到：Reddit 不让服务器直接读，第三方存档里也还没有这一条（刚发的帖子要过一阵才收录；链接不对、帖子不存在也是这样）。过一会儿点「重试」，或者把内容复制下来贴进来"
        : `这个 Reddit 帖子读不到：Reddit 不让服务器直接读，第三方存档这会儿也读不了（${(e instanceof Error ? e.message : String(e)).slice(0, 100)}）。过一会儿点「重试」，或者把内容复制下来贴进来`
    );
  }
}

/**
 * 跟着读时各种链接怎么读。Reddit 帖子在这里读到为止，它自己指向的链接不再跟
 * （不然「X 帖子 → Reddit 帖子 → 又一条 X 帖子」各跟各的，读过的记不到一起）。
 */
const FOLLOW: FollowDeps = {
  readX: (r) => readXPost(r, VIDEO_MAX_BYTES),
  readOther: async (r) => (r.platform === "reddit" ? (await readReddit(r)).post : FETCHERS[r.platform](r)),
  resolve: (url) => resolveLink(url),
};

const FETCHERS: Record<SourcePlatform, (ref: LinkRef) => Promise<FetchedPost>> = {
  xiaohongshu: (ref) => fetchXhsNote(ref, VIDEO_MAX_BYTES),
  douyin: (ref) => fetchDouyinVideo(ref),
  tiktok: (ref) => fetchTikTokVideo(ref, VIDEO_MAX_BYTES),
  instagram: (ref) => fetchInstagramPost(ref),
  youtube: fetchYouTube,
  x: async (ref) => followMentions(await readXPost(ref, VIDEO_MAX_BYTES), FOLLOW),
  reddit: async (ref) => followMentions(await readReddit(ref), FOLLOW),
  web: (ref) => fetchWebPage(ref),
};

export function fetchPost(ref: LinkRef): Promise<FetchedPost> {
  return FETCHERS[ref.platform](ref);
}
