import { NextResponse } from "next/server";
import { addNote, listItemNotes } from "@/lib/vault/note-service";
import { jsonBody, withSession } from "../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 这条内容上的划线和批注：`{ notes: [{ id, itemId, quote, body, at, createdAt, updatedAt }] }`，先写的在前。 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json({ notes: await listItemNotes(session, (await params).id) }));
}

/**
 * 加一条：`{ quote?, body?, at? }`——`quote` 是划下来的那段原话，`body` 是自己写的话，至少要有一样；`at` 是那段话在视频 / 音频里的秒数。
 * 返回 `{ notes, warning }`：这条内容现在所有的笔记；`warning` 不是 null 时，笔记存好了、但搜索的索引没更新成（暂时搜不到它）。
 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json(await addNote(session, (await params).id, { quote: body.quote, body: body.body, at: body.at }), { status: 201 });
  });
}
