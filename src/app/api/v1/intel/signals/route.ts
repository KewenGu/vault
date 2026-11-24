import { NextResponse } from "next/server";
import { listMySignals } from "@/lib/vault/intel-service";
import { withSession } from "../../respond";

/**
 * 发现的内容：`{ signals: [{ id, watchId, source, url, discussionUrl, title, excerpt, author, channel, score, comments, publishedAt, status, itemId, foundAt }], counts: { new, saved, dismissed } }`。
 * `status` = new（默认）/ saved / dismissed；按发布时间新的在前，最多 100 条。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json(await listMySignals(session, new URL(request.url).searchParams.get("status") ?? undefined)));
}
