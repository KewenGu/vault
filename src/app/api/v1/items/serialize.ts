import { coverOf, displayTitle, inProgress, isStuck, itemFileUrl, sourceLabel, type Item } from "@/lib/vault/store";
import type { SearchHit } from "@/lib/vault/search";

/** 接口返回的一条内容（列表用）：文件给的是站内地址（/media/…，带登录态访问）。 */
export function itemSummary(item: Item) {
  const cover = coverOf(item);
  return {
    id: item.id,
    title: displayTitle(item),
    source: item.source,
    sourceLabel: sourceLabel(item),
    platform: item.platform,
    url: item.url,
    kind: item.kind,
    status: isStuck(item) ? "failed" : item.status,
    inProgress: inProgress(item),
    error: item.error,
    author: item.author,
    summary: item.summary,
    contentType: item.contentType,
    category: item.category,
    tags: item.tags,
    note: item.note,
    cover: cover ? itemFileUrl(item, cover) : null,
    createdAt: item.createdAt,
    processedAt: item.processedAt,
  };
}

function omitCapture(post: Item["post"]): Item["post"] {
  const out = { ...post };
  delete out.capture;
  return out;
}

/** 详情：再带上理解结果、正文、口播和所有文件。 */
export function itemDetail(item: Item) {
  return {
    ...itemSummary(item),
    understanding: item.understanding,
    text: item.userText || item.post.text,
    transcript: item.transcript,
    // 在 Safari 里读的网页原样留着一份（重新读取用），正文和上面的 text 重复，不往外给
    post: omitCapture(item.post),
    media: item.media.map((m) => ({ role: m.role, url: itemFileUrl(item, m), mime: m.mime, width: m.width, height: m.height, durationS: m.durationS ?? null, at: m.at ?? null })),
    costUsd: item.costUsd,
  };
}

export const hitSummary = (hit: SearchHit) => ({ ...itemSummary(hit.item), match: { keywordHits: hit.keywordHits, similarity: hit.similarity, snippet: hit.snippet } });
