import type { AccountPlatform } from "./link";
import { SOURCE_PLATFORM_LABEL, fallbackTitle, type PostKind } from "./types";

/**
 * 存一个博主的全部作品：各平台「列出一个账号的作品」共用的形状。
 * 列出来的只是清单（哪条、什么时候发的、标题）；每一条的内容还是按链接走各平台原来的读法（fetch-post.ts）——
 * 清单里带的图片 / 视频地址有时效，排队轮到它的时候多半已经过期了。
 */

/** 账号本身的信息（列作品时顺带拿到的）。postCount：平台说的作品总数，没给是 null。 */
export type AccountInfo = { name: string; handle: string; bio: string; postCount: number | null };

/** 清单里的一条作品。 */
export type ListedPost = {
  externalId: string;
  /** 这条作品的链接（规范写法，和单独贴这条链接存进来的是同一个，去重靠它） */
  url: string;
  kind: PostKind | null;
  title: string;
  publishedAt: string | null;
  /** 博主置顶的（可能是很久以前发的） */
  pinned: boolean;
};

/** 清单里的标题：文案第一行去掉话题和链接，最多 80 个字。 */
export function listedTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/#[^\s#]+/g, "").replace(/https?:\/\/\S+/g, "").trim())
      .find(Boolean) ?? "";
  return Array.from(line).slice(0, 80).join("");
}

/** 账号所在的平台叫什么。B 站不在「认得的平台」里（它的视频按网页存），名字单独给。 */
export function accountLabel(platform: AccountPlatform): string {
  return platform === "bilibili" ? "B 站" : SOURCE_PLATFORM_LABEL[platform];
}

/** 夹在中文里的平台名：英文开头 / 结尾的前后留空格（「这个 TikTok 账号」「这个抖音账号」）。 */
export function accountLabelInText(platform: AccountPlatform): string {
  const label = accountLabel(platform);
  return `${/^[a-z]/i.test(label) ? " " : ""}${label}${/[a-z]$/i.test(label) ? " " : ""}`;
}

/** 清单里一条没有标题的作品叫什么（「X 帖子」「B 站视频」）。 */
export function listedFallbackTitle(platform: AccountPlatform, kind: PostKind | null): string {
  return platform === "bilibili" ? "B 站视频" : fallbackTitle(platform, kind);
}
