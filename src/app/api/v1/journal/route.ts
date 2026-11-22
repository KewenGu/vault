import { NextResponse } from "next/server";
import { createEntryFor, listMonth, listMyEntries } from "@/lib/vault/journal-service";
import { jsonBody, withSession } from "../respond";

/**
 * 日记列表，日期新的在前：`{ entries: [{ id, day, title, style, mood, weather, excerpt, photos, audios, cover, updatedAt }], more }`。
 * `q` = 搜索（标题、正文、照片说明、录音里说的话；空格隔开的词都出现才算），`page` = 第几页（从 0 开始，一页 60 篇）。
 * `month` = 只要这一个月的（YYYY-MM，月历用；日期早的在前，不分页）。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => {
    const params = new URL(request.url).searchParams;
    const month = params.get("month");
    if (month) return NextResponse.json({ entries: await listMonth(session, month), more: false });
    const { entries, more } = await listMyEntries(session, { q: params.get("q") ?? "", page: Number(params.get("page")) || 0 });
    return NextResponse.json({ entries, more });
  });
}

/**
 * 开一篇新的：`{ day, style? }`。day 是写的人当地的日期（YYYY-MM-DD，服务器不知道他在哪个时区，所以必须给）。
 * 这一天最后那篇还是空白的就回到它。返回 `{ id }`。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json({ id: await createEntryFor(session, { day: body.day, style: body.style }) }, { status: 201 });
  });
}
