import { NextResponse } from "next/server";
import { lookBack } from "@/lib/vault/journal-service";
import { withSession } from "../../respond";

/**
 * 「那年今日」：`today`（看的人当地的今天，YYYY-MM-DD，必须给）的一个月前、半年前和往年的同一天写过的日记，近的在前：
 * `{ items: [{ label: "1 年前", entry: { id, day, title, excerpt, cover… } }] }`。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json({ items: await lookBack(session, new URL(request.url).searchParams.get("today")) }));
}
