import type { PostSnapshot } from "@/lib/sources/types";
import { CATEGORY_LABEL, CONTENT_TYPE_INFO } from "./taxonomy";
import type { Understanding } from "./understand";

/**
 * 一条内容「搜得到」靠两样东西（纯函数，处理的最后一步算出来存进 items）：
 * - search_text：这条内容所有能搜的字拼在一起，关键词搜索在里面找；
 * - 向量用的文字：标题 + 概括 + 要点 + 标签这些「讲了什么」的浓缩，语义搜索用（「那个讲三亚带娃酒店的视频」）。
 */

export type IndexInput = {
  title: string;
  author: string;
  url: string | null;
  note: string;
  /** 他在这条内容上划的线、写的批注拼成的文字（notes.ts 的 notesIndexText）；没有是空 */
  annotations?: string;
  post: Pick<PostSnapshot, "text" | "hashtags">;
  userText: string | null;
  transcript: string | null;
  tags: string[];
  understanding: Understanding | null;
};

/** search_text 的上限：一条两小时的口播约 10 万字，留够 */
export const SEARCH_TEXT_MAX = 300_000;

const host = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

export function buildSearchText(input: IndexInput): string {
  const u = input.understanding;
  const parts = [
    input.title,
    u && u.title !== input.title ? u.title : "",
    input.author,
    host(input.url),
    input.note,
    input.annotations ?? "",
    u ? `${CONTENT_TYPE_INFO[u.contentType].label} ${CATEGORY_LABEL[u.category]}` : "",
    input.tags.join(" "),
    input.post.hashtags.join(" "),
    u?.summary ?? "",
    u?.points.map((p) => p.text).join("\n") ?? "",
    u?.outline.map((n) => n.text).join("\n") ?? "",
    u?.card.map((f) => `${f.label}：${f.value}`).join("\n") ?? "",
    u?.quotes.join("\n") ?? "",
    u?.entities.map((e) => e.name).join(" ") ?? "",
    input.userText ?? "",
    input.post.text,
    u?.ocr ?? "",
    input.transcript ?? "",
  ];
  // NUL 字符 Postgres 的 text 存不了（偶尔出现在抓来的网页里）
  return parts
    .map((p) => p.replace(/\u0000/g, "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, SEARCH_TEXT_MAX);
}

/** 向量用的文字。没有理解结果（理解失败）时退回标题 + 正文开头，至少能按字面意思找到。 */
export function buildEmbeddingText(input: IndexInput): string {
  const u = input.understanding;
  const parts = u
    ? [
        u.title || input.title,
        `${CONTENT_TYPE_INFO[u.contentType].label} · ${CATEGORY_LABEL[u.category]}`,
        u.summary,
        input.tags.join("、"),
        u.points.map((p) => p.text).join("\n"),
        u.card.map((f) => `${f.label}：${f.value}`).join("\n"),
        input.note,
        // 他自己划的、写的排在最后：向量文字有 8000 字的上限，挤掉的不该是内容本身的概括
        input.annotations ?? "",
      ]
    : [input.title, input.note, input.annotations ?? "", input.userText ?? input.post.text, input.transcript ?? ""];
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);
}
