import { MAX_IMAGES } from "@/lib/media/files";
import type { LinkRef } from "./link";
import { SOURCE_PLATFORM_LABEL, SourceFetchError, type FetchedPost } from "./types";

/**
 * 跟着读：一条帖子提到的东西（引用转发的帖子、正文里的链接、长文里嵌的帖子）也读进来，读到的帖子里再提到的接着读，
 * 一层一层往下，读过的不再读（防止互相引用转圈）。X 帖子走 X 的读法（能接着往下找），别的链接（网页、YouTube、
 * 小红书…）走各自平台的读法，读到为止（网页里的链接不再跟：一个网页的链接太多，大多是导航）。
 *
 * 一条收藏最多跟着读 MAX_FOLLOW 条：只是防止失控（一条帖子贴几百个链接、一串帖子无穷无尽），正常的帖子碰不到。
 * 读到的按「先父后子」的顺序接在正文后面（长文里嵌的帖子放回原位），图片排在后面存到上限，自己没视频的用第一个读到的视频。
 * 没读到的、没存的、超出条数没读的都记进 notes。互动数、作者、标签还是这条帖子自己的。
 */

/**
 * 帖子提到的一样东西。how：quote 引用转发，link 正文里的链接，embed 长文里嵌的帖子。
 * ref：认出来是哪个平台的哪条（短链要跟跳转，先是 null）。read：已经读到的（FxTwitter 带着完整的引用帖子）；
 * unavailable：已经知道读不到（被删、私密、X 长文本身的链接…），不再去读。
 */
export type Mention = { how: "quote" | "link" | "embed"; url: string; ref: LinkRef | null; read?: Followed; unavailable?: string };
/** 读到的一条：帖子本身 + 它提到的东西（不是 X 的读到为止，没有）。 */
export type Followed = { post: FetchedPost; mentions: Mention[] };

export type FollowDeps = {
  /** 读一条 X 帖子（连同它提到的东西） */
  readX: (ref: LinkRef) => Promise<Followed>;
  /** 读别的平台的一条 */
  readOther: (ref: LinkRef) => Promise<FetchedPost>;
  /** 短链、认不出的链接：跟跳转认出是哪条（认不出抛错） */
  resolve: (url: string) => Promise<LinkRef>;
};

export const MAX_FOLLOW = 30;
/** 每一条读到的东西最多放多少字进正文（一个长网页不把别的挤掉；整条的上限在理解那一步） */
export const SECTION_MAX = 10_000;
/** 各平台读的时候都会说的话，并进来时不重复 */
const BOILERPLATE = new Set(["读不到回复的内容，只有回复数", "这次走的是备用接口：没有转发数、书签数、浏览量", "网页没有点赞、评论这些数字，只能从内容本身判断它好在哪"]);

/** 长文里嵌的帖子在正文里的占位（x.ts 写进去，读到了换成内容） */
export const embedPlaceholder = (id: string) => `【嵌入的帖子】https://x.com/i/status/${id}`;

/** 跟着读到的一条：chain 是它从哪来的（「引用的帖子里链接的网页」），children 是它提到的、接着读的。 */
export type FollowNode = { mention: Mention; chain: string; read?: Followed; error?: unknown; duplicate?: boolean; children: FollowNode[] };

const keyOf = (ref: Pick<LinkRef, "platform" | "externalId">) => `${ref.platform}:${ref.externalId}`;

function labelOf(m: Mention, platform: LinkRef["platform"] | null): string {
  if (m.how === "quote") return "引用的帖子";
  if (m.how === "embed") return "长文里嵌的帖子";
  if (!platform) return "链接";
  if (platform === "x") return "链接的帖子";
  if (platform === "web") return "链接的网页";
  const label = SOURCE_PLATFORM_LABEL[platform];
  return `链接的${/^[a-z]/i.test(label) ? " " : ""}${label}${/[a-z]$/i.test(label) ? " " : ""}内容`;
}

/** 一层一层往下读（同一层的一起读），返回第一层的节点；skipped 是超出条数没读的。 */
export async function followTree(root: Followed, deps: FollowDeps, max = MAX_FOLLOW): Promise<{ nodes: FollowNode[]; skipped: number }> {
  const seenKeys = new Set([keyOf(root.post)]);
  const seenUrls = new Set<string>();
  let budget = max;
  let skipped = 0;
  const claim = (m: Mention): boolean => {
    if (m.ref ? seenKeys.has(keyOf(m.ref)) : seenUrls.has(m.url)) return false;
    if (!m.unavailable && budget <= 0) {
      skipped++;
      return false;
    }
    if (m.ref) seenKeys.add(keyOf(m.ref));
    seenUrls.add(m.url);
    if (!m.unavailable) budget--;
    return true;
  };
  const node = (mention: Mention, parent: string): FollowNode => ({ mention, chain: parent, children: [] });
  const load = async (n: FollowNode) => {
    const m = n.mention;
    if (m.read || m.unavailable) {
      n.read = m.read;
      return;
    }
    try {
      let ref = m.ref;
      if (!ref) {
        ref = await deps.resolve(m.url);
        // 短链跳到的是已经读过的
        if (seenKeys.has(keyOf(ref))) {
          n.duplicate = true;
          return;
        }
        seenKeys.add(keyOf(ref));
      }
      n.read = ref.platform === "x" ? await deps.readX(ref) : { post: await deps.readOther(ref), mentions: [] };
    } catch (error) {
      n.error = error;
    }
  };
  const label = (n: FollowNode) => labelOf(n.mention, n.read?.post.platform ?? n.mention.ref?.platform ?? null);

  const top = root.mentions.filter(claim).map((m) => node(m, ""));
  let level = top;
  while (level.length > 0) {
    await Promise.all(level.map(load));
    const next: FollowNode[] = [];
    for (const n of level) {
      n.chain = n.chain ? `${n.chain}里${label(n)}` : label(n);
      for (const m of n.read?.mentions ?? []) {
        if (!claim(m)) continue;
        const child = node(m, n.chain);
        n.children.push(child);
        next.push(child);
      }
    }
    level = next;
  }
  return { nodes: top, skipped };
}

const capChars = (text: string, n: number) => {
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join("") : null;
};

/** 读到的并进这条帖子（先父后子）。 */
export function mergeFollowed(main: FetchedPost, nodes: FollowNode[], skipped = 0, max = MAX_FOLLOW): FetchedPost {
  let text = main.text;
  const images = [...main.images];
  let video = main.video;
  let captions = main.captions ?? null;
  const notes = [...main.notes];
  let title = main.title;

  const visit = (n: FollowNode) => {
    if (n.duplicate) return;
    const { mention: m, chain } = n;
    if (!n.read) {
      const why = m.unavailable ?? (n.error instanceof SourceFetchError ? n.error.message.split("。")[0] : `出错了（${(n.error instanceof Error ? n.error.message : String(n.error)).slice(0, 80)}）`);
      notes.push(`${chain}没读到（${m.url}）：${why}`);
      return;
    }
    const sub = n.read.post;
    const name = sub.author.name || (/^https?:/.test(m.url) ? new URL(m.url).hostname.replace(/^www\./, "") : "");
    const who = `${chain}（${name}）`;
    const adopt = !!sub.video && !video;
    let body = sub.text;
    const capped = capChars(body, SECTION_MAX);
    if (capped !== null) {
      body = capped;
      notes.push(`${who}太长，只放了前 ${SECTION_MAX.toLocaleString("en-US")} 字`);
    }
    if (sub.captions && !adopt) body += `\n\n【字幕】\n${capChars(sub.captions, SECTION_MAX) ?? sub.captions}`;
    const heading = `【${chain}：${name}】${sub.platform !== "x" && sub.title ? `《${sub.title}》` : ""}`;
    const section = `${heading}\n${body}`.trim();
    const placeholder = sub.platform === "x" ? embedPlaceholder(sub.externalId) : null;
    if (m.how === "embed" && placeholder && text.includes(placeholder)) text = text.replace(placeholder, section);
    else text += `\n\n${section}`;
    title ||= sub.title;

    const fresh = sub.images.filter((f) => !images.some((i) => i.url === f.url));
    const room = Math.max(0, MAX_IMAGES - images.length);
    images.push(...fresh.slice(0, room));
    if (fresh.length > room) notes.push(`${who}有 ${fresh.length - room} 张图没存`);
    if (adopt) {
      video = sub.video;
      captions = sub.captions ?? null;
      notes.push(`视频是${who}里的`);
    } else if (sub.video) notes.push(`${who}里也有视频，没存${sub.captions ? "（字幕放进了正文）" : ""}`);

    for (const note of sub.notes) if (!BOILERPLATE.has(note)) notes.push(`${who}：${note}`);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  if (skipped > 0) notes.push(`还有 ${skipped} 条提到的帖子 / 链接没读（一条收藏最多跟着读 ${max} 条）`);
  const kind = main.kind !== "text" ? main.kind : video ? "video" : images.length > main.images.length ? "image" : "text";
  return { ...main, kind, title, text, images, video, captions, notes };
}

/** 跟着读完、并进来。 */
export async function followMentions(root: Followed, deps: FollowDeps, max = MAX_FOLLOW): Promise<FetchedPost> {
  const { nodes, skipped } = await followTree(root, deps, max);
  return mergeFollowed(root.post, nodes, skipped, max);
}
