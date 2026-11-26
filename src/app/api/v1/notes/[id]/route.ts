import { NextResponse } from "next/server";
import { editNote, removeNote } from "@/lib/vault/note-service";
import { jsonBody, withSession } from "../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 改一条笔记里自己写的那段话：`{ body }`（划下来的原话不能改）。返回 `{ notes, warning }`，和加一条时一样。 */
export async function PATCH(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await editNote(session, (await params).id, { body: (await jsonBody(request)).body })));
}

/** 删一条笔记。返回 `{ notes, warning }`（它挂着的那条内容剩下的笔记）。 */
export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await removeNote(session, (await params).id)));
}
