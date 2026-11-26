import type { CreatorSummary } from "@/lib/vault/creator-service";
import { creatorBusy, creatorStuck } from "@/lib/vault/creator-store";

/** 接口里的一个博主：账号、状态、清单里各种状态各有几条。busy = 后台正在跑；stuck = 状态是进行中但很久没动静（可以接着存）。 */
export function creatorJson(c: CreatorSummary) {
  return {
    id: c.id,
    platform: c.platform,
    handle: c.handle,
    name: c.name,
    bio: c.bio,
    url: c.url,
    postCount: c.postCount,
    status: c.status,
    busy: creatorBusy(c),
    stuck: creatorStuck(c),
    error: c.error,
    want: c.want,
    notes: c.notes,
    counts: c.counts,
    costUsd: c.costUsd,
    syncedAt: c.syncedAt,
    createdAt: c.createdAt,
  };
}
