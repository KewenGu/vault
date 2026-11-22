import { NextResponse } from "next/server";
import { retryMedia } from "@/lib/vault/journal-service";
import { withSession } from "../../../../../respond";

/** 录音重新转一次文字。返回 `{ media }`。 */
export async function POST(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  return withSession(request, async (session) => NextResponse.json({ media: await retryMedia(session, (await params).mediaId) }));
}
