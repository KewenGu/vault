import "server-only";
import { fetchDouyinVideo } from "./douyin";
import { fetchInstagramPost } from "./instagram";
import { fetchXThreadIds } from "./account-x";
import { followMentions, type FollowDeps, type Followed, type Mention } from "./follow";
import { resolveLink, type LinkRef } from "./link";
import { VIDEO_MAX_BYTES } from "@/lib/media/files";
import { RedditArchiveMiss, readRedditPost } from "./reddit";
import { fetchTikTokVideo } from "./tiktok";
import { SourceFetchError, type SourcePlatform, type FetchedPost } from "./types";
import { fetchWebPage } from "./web";
import { WEIBO_MEDIA_HEADERS, readWeiboPost } from "./weibo";
import { fetchXhsNote } from "./xhs";
import { canReadXhsViaApify, fetchXhsViaApify } from "./xhs-apify";
import { readXPost } from "./x";
import { YouTubeBlockedError, fetchYouTubeVideo } from "./youtube";
import { fetchYouTubeViaApify } from "./youtube-apify";
import { mapYtdlpInfo, ytdlpInfo, ytdlpPath } from "./ytdlp";

/**
 * 按平台读一条帖子（收藏夹后台任务的第一步）。各平台怎么读、花不花钱：
 *
 * | 平台 | 怎么读 | 花费 |
 * |---|---|---|
 * | 小红书 | 直接读分享页（要链接里的口令）；没有口令（从博主那里存进来的笔记）或口令过期时走 Apify | 免费；走 Apify 时约 $0.005 / 条 |
 * | 抖音 | Apify actor | 约 $0.008 / 条 |
 * | TikTok | 直接读视频页 | 免费 |
 * | Instagram | Apify 官方 actor | 约 $0.003 / 条 |
 * | YouTube | App 的播放接口（字幕 + 360p 视频）；被拦时（云服务器上）走 Apify：一个 actor 读信息和字幕，另一个把 360p 视频下下来 | 免费；走 Apify 时约 $0.004 / 条 + 视频每分钟 $0.00001 |
 * | X | FxTwitter 公开接口 → 官方嵌入接口；提到的帖子和链接跟着读（见 follow.ts）；从博主那里存进来的还读他接在后面发的那一串 | 免费 |
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
 * 小红书：链接里有访问口令就直接读分享页（不花钱，还带几条高赞评论）。没有口令（从博主那里存进来的笔记只有 id）、
 * 或者直接读读不到（口令过期是最常见的：小红书的分享链接隔一阵就失效），又配了 APIFY_TOKEN：按笔记 id 走 Apify（见 xhs-apify.ts）。
 * Apify 那边也说没有这篇，才是真的读不到。
 */
async function fetchXhs(ref: LinkRef): Promise<FetchedPost> {
  const hasToken = /[?&]xsec_token=[^&]/.test(ref.url);
  if (!canReadXhsViaApify()) return fetchXhsNote(ref, VIDEO_MAX_BYTES);
  if (!hasToken) return fetchXhsViaApify(ref);
  try {
    return await fetchXhsNote(ref, VIDEO_MAX_BYTES);
  } catch (e) {
    if (!(e instanceof SourceFetchError)) throw e;
    const post = await fetchXhsViaApify(ref);
    return { ...post, notes: ["链接里的访问口令失效了，这次是按笔记 id 另一条路读的", ...post.notes] };
  }
}

/**
 * 微博：带的文章、外链跟着读。文章是按网页读的，里面的图也在微博的图床上（sinaimg.cn），下载要带 Referer（不带回 403）；
 * 文章页上作者和评论的人的头像（tvax*.sinaimg.cn）、表情（face.t.sinajs.cn）不算配图（2026-11-26 实测一篇文章 6 张里 5 张是这些）。
 */
async function fetchWeibo(ref: LinkRef): Promise<FetchedPost> {
  const read = await readWeiboPost(ref);
  const own = new Set(read.post.images.map((f) => f.url));
  const post = await followMentions(read, FOLLOW);
  const onImageBed = (url: string) => /^https:\/\/[\w.-]+\.sinaimg\.cn\//i.test(url);
  const decoration = (url: string) => /^https:\/\/(tvax?\d*\.sinaimg\.cn|face\.t\.sinajs\.cn)\//i.test(url);
  const images = post.images.filter((f) => own.has(f.url) || !decoration(f.url)).map((f) => (f.headers || !onImageBed(f.url) ? f : { ...f, headers: WEIBO_MEDIA_HEADERS }));
  // 跟着读到的只有头像和表情：这条微博还是只有文字
  const kind = read.post.kind === "text" && post.kind === "image" && images.length === 0 ? "text" : post.kind;
  return { ...post, kind, images };
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
 * 跟着读时各种链接怎么读。Reddit 帖子、微博在这里读到为止，它自己指向的链接不再跟
 * （不然「X 帖子 → Reddit 帖子 → 又一条 X 帖子」各跟各的，读过的记不到一起）。
 */
const FOLLOW: FollowDeps = {
  readX: (r) => readXPost(r, VIDEO_MAX_BYTES),
  readOther: async (r) => (r.platform === "reddit" ? (await readReddit(r)).post : r.platform === "weibo" ? (await readWeiboPost(r)).post : FETCHERS[r.platform](r, {})),
  resolve: (url) => resolveLink(url),
};

/**
 * 一条 X 帖子，连同作者接在它后面发的那一串：后几条当成「提到的东西」排在最前面跟着读，并在正文后面（一串帖子是一条内容）。
 * 查不到是不是一串不算失败，记一句。
 */
async function readXWithThread(ref: LinkRef): Promise<Followed> {
  const read = await readXPost(ref, VIDEO_MAX_BYTES);
  const ids = await fetchXThreadIds(ref.externalId);
  if (ids === null) return { post: { ...read.post, notes: [...read.post.notes, "没查到作者有没有接在这条后面继续发（查一串帖子的接口这会儿读不了）"] }, mentions: read.mentions };
  const thread: Mention[] = ids.map((id) => ({ how: "thread", url: `https://x.com/i/status/${id}`, ref: { platform: "x", externalId: id, url: `https://x.com/i/status/${id}` } }));
  return { post: read.post, mentions: [...thread, ...read.mentions] };
}

/** thread：X 帖子把作者接在后面发的那一串也读进来（别的平台不管它） */
export type FetchOptions = { thread?: boolean };

const FETCHERS: Record<SourcePlatform, (ref: LinkRef, opts: FetchOptions) => Promise<FetchedPost>> = {
  xiaohongshu: fetchXhs,
  douyin: (ref) => fetchDouyinVideo(ref),
  tiktok: (ref) => fetchTikTokVideo(ref, VIDEO_MAX_BYTES),
  instagram: (ref) => fetchInstagramPost(ref),
  youtube: fetchYouTube,
  x: async (ref, opts) => followMentions(opts.thread ? await readXWithThread(ref) : await readXPost(ref, VIDEO_MAX_BYTES), FOLLOW),
  reddit: async (ref) => followMentions(await readReddit(ref), FOLLOW),
  weibo: fetchWeibo,
  web: (ref) => fetchWebPage(ref),
};

export function fetchPost(ref: LinkRef, opts: FetchOptions = {}): Promise<FetchedPost> {
  return FETCHERS[ref.platform](ref, opts);
}
