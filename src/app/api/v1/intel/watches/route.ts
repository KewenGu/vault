import { NextResponse } from "next/server";
import { addWatch, listMyWatches } from "@/lib/vault/intel-service";
import { jsonBody, withSession } from "../../respond";

/** 盯着的来源：`{ watches: [{ id, kind, query, keywords, minScore, enabled, lastCheckedAt, lastError, lastNotes, createdAt }] }`，先加的在前。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json({ watches: await listMyWatches(session) }));
}

/**
 * 加一个来源：`{ kind: "subreddit" | "hn", query, minScore?, keywords? }`。加完马上去看一次（要等几秒到十几秒）。
 * 返回 `{ watch, check: { found, fresh, notes, error } }`；同一个来源已经有了回 409。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json(await addWatch(session, { kind: body.kind, query: body.query, minScore: body.minScore, keywords: body.keywords }));
  });
}
