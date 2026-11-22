import { NextResponse } from "next/server";
import { getEntryDetail, removeEntry, saveEntry } from "@/lib/vault/journal-service";
import { jsonBody, withSession } from "../../respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 一篇日记：`{ entry: { id, day, title, style, mood, weather, doc: { blocks, decos, strokes }, rev, … }, media: [{ id, kind, status, url, cues, notes, … }], older, newer }`。
 * doc.blocks 是正文：`{ id, type: "text", text }` / `{ id, type: "photo", media, caption }` / `{ id, type: "audio", media }`，media 指着 media 里的一个文件。
 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await getEntryDetail(session, (await params).id)));
}

/**
 * 保存：`{ title?, day?, style?, mood?, weather?, doc?, rev? }`，只改给了的。rev 是读到这篇时的版本号：
 * 给了、而这篇在别处改过了，回 409、不盖掉。返回 `{ rev }`（新的版本号，下次保存带上）。
 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    return NextResponse.json(await saveEntry(session, (await params).id, { title: body.title, day: body.day, style: body.style, mood: body.mood, weather: body.weather, doc: body.doc, rev: body.rev }));
  });
}

/** 删除（连同照片和录音）。 */
export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    await removeEntry(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
