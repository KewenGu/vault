import { GONE, archiveGet } from "@/lib/sources/reddit";
import { TITLE_MAX, excerptOf, httpUrl, type Candidate, type Listing } from "./candidate";

/**
 * 一个 Reddit 版块最近的帖子：走第三方存档 Arctic Shift（Reddit 自己不让服务器读，RSS 也是 429；见 lib/sources/reddit.ts）。
 *
 * `/api/posts/search?subreddit=<名字>&after=<秒>&limit=100&sort=desc&fields=…`：新的在前，一页 100 条，
 * 往前翻用 `before=<上一页最后一条的时间>`。`fields` 只认一部分字段名（2026-11-24 实测：id、title、selftext、author、
 * subreddit、created_utc、retrieved_on、score、num_comments、url、link_flair_text 认；permalink、is_self、
 * removed_by_category、_meta 不认，带了回 400）——带上它一页从 450 KB 降到 130 KB。不存在的版块返回空数组，不报错。
 *
 * 分数是存档记下的，不是现在的：帖子刚发时记一次（那时都是 1 分），过几个小时回头再记
 * （同一天实测 r/LocalLLaMA：发了 4 小时以上的帖子四分之三已经记过第二次）。所以一条帖子要等存档回头记过、
 * 分数过了线才会被看到，比 Reddit 上晚几个小时；每次去看都把这几天的重新读一遍，分数跟着更新。
 * 被移除的帖子这个接口认不出来（那个字段要不到），靠分数线挡：被过滤掉的帖子分数一般是 0 或 1。
 */

export const REDDIT_WINDOW_DAYS = 3;
const PAGE = 100;
/** 一次最多翻这么多页（很热闹的版块 100 条只够十几个小时） */
export const MAX_PAGES = 6;
/** 两次请求之间等这么久：存档嫌快会回 422（实测隔 0.7 秒就会） */
const PACE_MS = 1300;
const FIELDS = "id,title,selftext,author,subreddit,created_utc,score,num_comments,url,link_flair_text";

type Row = { id?: unknown; title?: unknown; selftext?: unknown; author?: unknown; subreddit?: unknown; created_utc?: unknown; score?: unknown; num_comments?: unknown; url?: unknown };

const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

/** 用户写的版块：`LocalLLaMA`、`r/LocalLLaMA`、`https://www.reddit.com/r/LocalLLaMA/` 都行。认不出返回 null。 */
export function parseSubreddit(raw: string): string | null {
  const text = raw.trim();
  const name = /(?:^|reddit\.com)\/?r\/([A-Za-z0-9_]+)/i.exec(text)?.[1] ?? text;
  return SUBREDDIT.test(name) ? name : null;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** 存档里的一条帖子 → 候选。不是帖子（没有 id / 标题）、标题已经被换成「[ Removed by … ]」的返回 null。 */
export function mapRedditRow(raw: unknown, subreddit: string): Candidate | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Row;
  const id = typeof r.id === "string" && /^[0-9a-z]{4,10}$/.test(r.id) ? r.id : null;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!id || !title || GONE.test(title)) return null;
  const body = typeof r.selftext === "string" && !GONE.test(r.selftext.trim()) ? r.selftext : "";
  // 链接帖没有正文：说一声它指向哪
  const link = httpUrl(r.url);
  const host = link ? new URL(link).hostname.replace(/^www\./, "") : "";
  const pointsElsewhere = host !== "" && !/(^|\.)(reddit\.com|redd\.it)$/.test(host);
  const author = typeof r.author === "string" && r.author && !GONE.test(r.author) ? `u/${r.author}` : null;
  const created = int(r.created_utc);
  return {
    source: "reddit",
    externalId: id,
    url: `https://www.reddit.com/comments/${id}`,
    discussionUrl: null,
    title: Array.from(title).slice(0, TITLE_MAX).join(""),
    excerpt: excerptOf(body) || (pointsElsewhere ? `链接：${host}` : ""),
    author,
    channel: `r/${typeof r.subreddit === "string" && SUBREDDIT.test(r.subreddit) ? r.subreddit : subreddit}`,
    score: int(r.score),
    comments: int(r.num_comments),
    publishedAt: created !== null ? new Date(created * 1000).toISOString() : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个版块从 since 到现在的帖子（不按分数筛：那是调用方的事）。存档出错往上抛。
 * 没看到的记进 notes：翻到上限还没到 since（帖子太多）、一条都没有（版块名可能写错了）。
 */
export async function listSubreddit(subreddit: string, since: Date, opts: { now?: Date; wait?: (ms: number) => Promise<unknown>; get?: (path: string) => Promise<unknown> } = {}): Promise<Listing> {
  const wait = opts.wait ?? sleep;
  const get = opts.get ?? ((path: string) => archiveGet(path, wait));
  const now = opts.now ?? new Date();
  const after = Math.floor(since.getTime() / 1000);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  let before: number | null = null;
  let rows = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await wait(PACE_MS);
    const data = await get(`/posts/search?subreddit=${subreddit}&after=${after}${before !== null ? `&before=${before}` : ""}&limit=${PAGE}&sort=desc&fields=${FIELDS}`);
    if (!Array.isArray(data)) throw new Error("Reddit 存档返回的不是帖子列表");
    rows += data.length;
    let oldest: number | null = null;
    for (const raw of data) {
      const created = int((raw as Row | null)?.created_utc);
      if (created !== null && (oldest === null || created < oldest)) oldest = created;
      const c = mapRedditRow(raw, subreddit);
      if (c && !seen.has(c.externalId)) {
        seen.add(c.externalId);
        candidates.push(c);
      }
    }
    if (data.length < PAGE || oldest === null) return finish();
    if (page === MAX_PAGES - 1) {
      const hours = Math.max(1, Math.round((now.getTime() / 1000 - oldest) / 3600));
      notes.push(`r/${subreddit} 帖子太多：只看了最近 ${hours} 小时的（${rows} 条），再往前的没看`);
    }
    before = oldest;
  }
  return finish();

  function finish(): Listing {
    if (rows === 0) notes.push(`存档里 r/${subreddit} 最近 ${Math.round((now.getTime() - since.getTime()) / 86_400_000)} 天一条帖子都没有：版块名可能写错了，或者是私密的`);
    return { candidates, notes };
  }
}
