import type { ListedPost } from "./account";
import { archiveGet } from "./reddit";
import type { PostKind } from "./types";

/**
 * 列一个 Reddit 用户发过的帖子：和读单条一样走第三方存档 Arctic Shift（见 reddit.ts；Reddit 自己不让服务器读）。免费、不要密钥。
 *
 * - `/api/posts/search?author=<用户名>&sort=desc&limit=<1–100>`：他发的帖子，从新到旧，一页最多 100 条；用户名不分大小写
 *   （结果里的 `author` 是他自己写的那个大小写）。往回翻用 `before=<上一页最旧那条的 created_utc>`。
 *   `fields=` 只要用得上的几项（一条不到 300 字节；不挑的话一条 5 KB 左右）——能挑的字段是存档定的，
 *   `is_video`、`is_gallery`、`removed_by_category`、`stickied` 不能挑，所以是不是视频 / 图集只能从 `post_hint` 和地址猜，置顶的认不出来。
 * - `/api/users/search?author=<用户名>`：存档见过的用户。只拿来分清「没有这个人」和「这个人没发过帖子」：
 *   里面的帖子数、karma 是很久以前统计的（2026-11-26 实测一个账号的统计停在 15 个月前），不拿来用。
 *
 * 2026-11-26 在云端容器里实测：一页 100 条约 1.5 秒；请求太密会回 422「slow down」（archiveGet 会等一下再问一次）。
 *
 * 列出来的是帖子（发在版块里的、发在他自己主页上的、转帖）；他写的评论不在里面——评论不是一条能单独存的内容。
 * 存档是快照：刚发的帖子可能还没收录；被删、被移除的帖子存档里还留着，照样列出来（读的时候会说它被移除了）。
 */

/** 一页最多要这么多条（存档的上限） */
export const REDDIT_PAGE = 100;
const FIELDS = "id,author,subreddit,created_utc,title,post_hint,url";

/** before：往回翻下一页用的（这一页最旧那条的时间，秒）；rows：存档这一页给了多少行（不到要的条数就是到头了）。 */
export type RedditPage = { name: string; posts: ListedPost[]; before: number | null; rows: number };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 从 `post_hint` 和帖子指向的地址猜是哪一类；链接帖（指向别的网站）读了才知道，先不说。 */
function guessKind(it: Obj): PostKind | null {
  const hint = str(it.post_hint);
  const url = str(it.url);
  if (hint === "hosted:video" || /^https?:\/\/v\.redd\.it\//i.test(url)) return "video";
  if (hint === "image" || /^https?:\/\/i\.redd\.it\//i.test(url) || /^https?:\/\/(www\.)?reddit\.com\/gallery\//i.test(url)) return "image";
  if (hint === "self" || /^https?:\/\/(www\.|old\.)?reddit\.com\/(r|u|user)\/[^/]+\/comments\//i.test(url)) return "text";
  return null;
}

/** 存档返回的一页 → 清单（纯函数）。name：要列的用户名（小写）；别人的行（不该有）不要。 */
export function readRedditListing(data: unknown[], name: string): RedditPage {
  let shown = "";
  let before: number | null = null;
  const posts: ListedPost[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const it = obj(raw);
    const created = typeof it.created_utc === "number" && it.created_utc > 0 ? it.created_utc : null;
    if (created !== null && (before === null || created < before)) before = created;
    const id = str(it.id).toLowerCase();
    if (!/^[0-9a-z]{4,10}$/.test(id) || seen.has(id)) continue;
    if (str(it.author).toLowerCase() !== name) continue;
    seen.add(id);
    shown ||= str(it.author);
    posts.push({
      externalId: id,
      // 和单独贴这条帖子的链接认出来的是同一个写法（link.ts）
      url: `https://www.reddit.com/comments/${id}`,
      kind: guessKind(it),
      title: Array.from(str(it.title).trim()).slice(0, 300).join(""),
      publishedAt: created !== null ? new Date(created * 1000).toISOString() : null,
      // 置顶在主页上的认不出来（存档不让挑那个字段），按发的时间排
      pinned: false,
    });
  }
  return { name: shown, posts, before: before !== null ? Math.floor(before) : null, rows: data.length };
}

/** 读一页他发的帖子（从新到旧）。before：只要比这个时间（秒）更早的。存档出错原样抛。 */
export async function fetchRedditUserPosts(name: string, before: number | null, limit = REDDIT_PAGE): Promise<RedditPage> {
  const n = Math.max(1, Math.min(REDDIT_PAGE, Math.floor(limit)));
  const data = await archiveGet(`/posts/search?author=${encodeURIComponent(name)}&sort=desc&limit=${n}&fields=${FIELDS}${before ? `&before=${before}` : ""}`);
  if (!Array.isArray(data)) throw new Error("Reddit 存档返回的不是帖子的清单");
  return readRedditListing(data, name.toLowerCase());
}

/** 存档见没见过这个用户（发过帖子或者评论的）；见过返回他自己写的那个大小写。 */
export async function fetchRedditUserName(name: string): Promise<string | null> {
  const data = await archiveGet(`/users/search?author=${encodeURIComponent(name)}&limit=10`);
  const hit = (Array.isArray(data) ? data : []).map((u) => str(obj(u).author)).find((a) => a.toLowerCase() === name.toLowerCase());
  return hit ?? null;
}
