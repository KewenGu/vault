import { labeledPublicFetch as labeledFetch } from "@/lib/network/labeled-public-fetch";
import { MOBILE_UA, type LinkRef } from "./link";
import { SourceFetchError, emptyStats, type FetchedPost, type RemoteFile } from "./types";

/**
 * 读一篇小红书笔记：按手机浏览器打开分享页（`/discovery/item/<id>?xsec_token=…`），页面里的
 * `window.__INITIAL_STATE__` 带着整篇笔记——标题、正文、图片 / 视频地址、互动数、首屏的几条高赞评论。
 * 不用登录、不花钱；但要链接里的访问口令（xsec_token）：没有或过期时小红书把请求转到 404 / 登录页，
 * 这时报 SourceFetchError（重试没用，让用户重新复制链接）。
 * 图片 / 视频地址带时效签名（几小时就失效），调用方读完要马上转存。
 */

const SERVICE = "小红书(www.xiaohongshu.com)";

/** 「14.5K」「2,822」「1.2万」「10万+」→ 数字；空的、认不出的是 null。 */
export function parseCount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  if (typeof raw !== "string") return null;
  const m = /^([\d,]+(?:\.\d+)?)\s*([kKwW万千亿]?)\+?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit: Record<string, number> = { k: 1e3, K: 1e3, 千: 1e3, w: 1e4, W: 1e4, 万: 1e4, 亿: 1e8 };
  return Math.round(n * (unit[m[2]] ?? 1));
}

/** 从页面 HTML 里取 `window.__INITIAL_STATE__`（是 JS 对象字面量：值里有裸的 undefined，换成 null 再解析）。 */
export function extractInitialState(html: string): unknown | null {
  const m = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/:\s*undefined\b/g, ":null").replace(/\[\s*undefined\b/g, "[null").replace(/,\s*undefined\b/g, ",null"));
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};
const https = (u: string) => u.replace(/^http:\/\//i, "https://");

/** 正文里的话题写成 `#冷门好店大安利[话题]#`：去掉 `[话题]#`，留 `#冷门好店大安利`。 */
export function cleanDesc(desc: string): string {
  return desc.replace(/\[话题\]#/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

/** 视频的几路码流里挑一路：优先 h264（哪儿都能放），其次 h265；同一种里挑不超过上限的最大那个。 */
function pickStream(stream: Obj, maxBytes: number): (RemoteFile & { durationS: number | null }) | null {
  const candidates = [...arr(stream.h264).map((s) => ({ s: obj(s), pref: 0 })), ...arr(stream.h265).map((s) => ({ s: obj(s), pref: 1 }))]
    .map(({ s, pref }) => ({
      pref,
      url: str(s.masterUrl),
      backupUrls: arr(s.backupUrls).filter((u): u is string => typeof u === "string"),
      width: numOrNull(s.width),
      height: numOrNull(s.height),
      bytes: numOrNull(s.size),
      durationMs: numOrNull(s.duration) ?? numOrNull(s.videoDuration),
    }))
    .filter((c) => c.url);
  if (candidates.length === 0) return null;
  const fits = candidates.filter((c) => c.bytes === null || c.bytes <= maxBytes);
  // 都超限时也返回最小的那路：调用方下载时按大小拦下，并记一句「视频太大没转存」
  const pool = fits.length > 0 ? fits : [...candidates].sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0)).slice(0, 1);
  const best = pool.sort((a, b) => a.pref - b.pref || (b.bytes ?? 0) - (a.bytes ?? 0))[0];
  return {
    url: https(best.url),
    backupUrls: best.backupUrls.map(https),
    width: best.width,
    height: best.height,
    bytes: best.bytes,
    durationS: best.durationMs ? Math.round(best.durationMs / 100) / 10 : null,
  };
}

/** 把 `__INITIAL_STATE__` 变成一条帖子。笔记不在（口令失效 / 被删 / 风控）抛 SourceFetchError。 */
export function parseXhsState(state: unknown, maxVideoBytes = 50 * 1024 * 1024): FetchedPost {
  const data = obj(obj(obj(state).noteData).data);
  const note = obj(data.noteData);
  const noteId = str(note.noteId);
  if (!noteId) throw new SourceFetchError(GONE);
  const type = str(note.type) === "video" ? "video" : "image";
  const interact = obj(note.interactInfo);
  const user = obj(note.user);
  const images: RemoteFile[] = arr(note.imageList)
    .map((i) => obj(i))
    .map((i) => ({ url: https(str(i.url) || str(obj(arr(i.infoList)[0]).url)), width: numOrNull(i.width), height: numOrNull(i.height) }))
    .filter((i) => i.url);
  const media = obj(obj(note.video).media);
  const video = type === "video" ? pickStream(obj(media.stream), maxVideoBytes) : null;
  if (video && !video.durationS) video.durationS = numOrNull(obj(obj(note.video).capa).duration) ?? numOrNull(obj(media.video).duration);
  const desc = cleanDesc(str(note.desc));
  const notes: string[] = [];
  if (arr(note.noteAttributes).includes("long_text_to_image")) notes.push("这是一篇「长文转图片」的笔记：正文主要写在图片里");
  if (type === "video" && !video) notes.push("页面里没有给出视频地址，只读到了封面");
  const time = numOrNull(note.time);
  return {
    platform: "xiaohongshu",
    externalId: noteId,
    kind: type,
    title: str(note.title).trim(),
    text: desc,
    author: { id: str(user.userId) || null, name: str(user.nickName) || str(user.nickname) },
    publishedAt: time ? new Date(time).toISOString() : null,
    stats: {
      ...emptyStats(),
      likes: parseCount(interact.likedCount),
      collects: parseCount(interact.collectedCount),
      comments: parseCount(interact.commentCount),
      shares: parseCount(interact.shareCount),
    },
    hashtags: arr(note.tagList)
      .map((t) => str(obj(t).name).trim())
      .filter(Boolean),
    topComments: arr(obj(data.commentData).comments)
      .map((c) => obj(c))
      .map((c) => ({ text: str(c.content).trim(), likes: parseCount(c.likeViewCount) ?? parseCount(c.likeCount) }))
      .filter((c) => c.text)
      .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
      .slice(0, 8),
    images,
    video,
    music: null,
    notes,
  };
}

const GONE = "这篇笔记读不到：链接可能过期了，或者笔记被删了、设成了私密。在小红书里重新点「分享 → 复制链接」再贴一次";

/** 读一篇笔记。网络错误原样抛（可以重试）；笔记读不到抛 SourceFetchError。 */
export async function fetchXhsNote(ref: LinkRef, maxVideoBytes?: number): Promise<FetchedPost> {
  const page = new URL(ref.url);
  const target = new URL(`https://www.xiaohongshu.com/discovery/item/${ref.externalId}`);
  // 口令和它的来源标记原样带上，其余参数（设备号、分享人等）不要
  const token = page.searchParams.get("xsec_token");
  if (!token) throw new SourceFetchError("这条链接里没有访问口令（xsec_token），小红书不让读：在小红书里点「分享 → 复制链接」，把复制到的内容整段贴进来");
  target.searchParams.set("xsec_token", token);
  target.searchParams.set("xsec_source", page.searchParams.get("xsec_source") || "pc_feed");
  const res = await labeledFetch(SERVICE, target.href, {
    headers: { "user-agent": MOBILE_UA, accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  // 口令失效时被转到 /404/sec_… 或 /login
  if (/\/(404|login)\b/.test(new URL(res.url || target.href).pathname)) throw new SourceFetchError(GONE);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) throw new SourceFetchError(GONE);
    throw new Error(`小红书 ${res.status}：页面打不开，过一会儿再试`);
  }
  const state = extractInitialState(await res.text());
  if (!state) throw new SourceFetchError("小红书返回的页面里没有笔记内容（可能触发了验证）。过一会儿再试，或者把笔记文字贴进来直接分析");
  const post = parseXhsState(state, maxVideoBytes);
  if (post.externalId !== ref.externalId) throw new SourceFetchError(GONE);
  return post;
}
