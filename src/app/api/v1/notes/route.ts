import { NextResponse } from "next/server";
import { listMyNotes } from "@/lib/vault/note-service";
import { withSession } from "../respond";

/**
 * 所有的划线和批注，新写的在前：`{ notes: [{ note: { id, itemId, quote, body, at, createdAt, updatedAt }, item: { id, title, origin } }], more }`。
 * `q` = 按字面找（空格隔开的词都出现才算）。最多 200 条，`more` = 还有更早的没列出来。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json(await listMyNotes(session, { q: new URL(request.url).searchParams.get("q") ?? "" })));
}
