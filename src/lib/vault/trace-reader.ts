import "server-only";
import { fetchPostAlone } from "@/lib/sources/fetch-post";
import { LinkError, resolveLink } from "@/lib/sources/link";
import { SOURCE_PLATFORM_LABEL, SourceFetchError } from "@/lib/sources/types";
import type { TracePage } from "./trace";

/**
 * 溯源时用 Vault 自己的读取器读一个地址（lib/sources/ 里存内容用的那一套）。
 *
 * 为什么要有：Anthropic 那边的读网页工具读不了 X（2026-11-27 第一次真实溯源就撞上了：一篇公众号转述的是 Jack Clark 在 X 上
 * 发的长文，原帖 `url_not_allowed`，只能看搜索摘要），微博、Reddit、小红书、YouTube 的字幕也一样读不到——而第一手的出处
 * 恰恰常常是一条帖子、一段视频。这些平台 Vault 自己有读法（FxTwitter、存档、平台接口…）。
 *
 * 只读这一条，不跟着读它提到的链接、不下载图片和视频；它提到的地址列出来交给模型，接着读哪个由它定。
 * 读不到抛 Error（message 是能直接给模型和用户看的话）。花钱的读法（抖音、Instagram 走 Apify，网页走带密钥的 Jina）
 * 照常记账：调用在后台任务的计量域里。
 */

/** 读一个地址最多等这么久：平台接口卡住时不让整次溯源陪着等 */
const READ_TIMEOUT_MS = 60_000;

const HOW: Record<string, string> = { quote: "引用的帖子", link: "正文里的链接", embed: "长文里嵌的帖子", thread: "作者接在后面发的" };

export async function readPageForTrace(url: string): Promise<TracePage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("读了一分钟还没读到，先不等了")), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(url), timeout]);
  } catch (e) {
    if (e instanceof LinkError || e instanceof SourceFetchError) throw new Error(e.message.split("。")[0]);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function read(url: string): Promise<TracePage> {
  const ref = await resolveLink(url);
  const { post, mentions } = await fetchPostAlone(ref);
  const parts = [post.text];
  // 接口顺带给了的引用帖子：正文接在后面
  for (const m of mentions) if (m.read) parts.push(`【${HOW[m.how] ?? "提到的帖子"}：${m.read.post.author.name}】\n${m.read.post.text}`);
  if (post.captions) parts.push(`【字幕】\n${post.captions}`);
  const links = [...(post.links ?? []), ...mentions.filter((m) => !m.read && /^https?:\/\//i.test(m.url)).map((m) => ({ text: HOW[m.how] ?? "", url: m.url }))];
  return {
    url: post.url ?? ref.url,
    via: SOURCE_PLATFORM_LABEL[post.platform],
    title: post.title,
    author: post.author.name,
    publishedAt: post.publishedAt,
    text: parts.filter(Boolean).join("\n\n"),
    links: links.filter((l, i) => links.findIndex((o) => o.url === l.url) === i),
    notes: post.notes,
  };
}
