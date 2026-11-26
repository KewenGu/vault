import { NextResponse } from "next/server";
import { askVault, getAskDetail, removeAsk } from "@/lib/vault/ask-service";
import { jsonBody, str, withSession } from "../../respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 一次提问的全部对话：`{ ask: { id, title, chat, sources, costUsd, createdAt, updatedAt }, gone }`。
 * `chat` 是一问一答：`{ role: "user", text, at }` / `{ role: "assistant", text, at, cites: [{ id, title, origin }], notes, seen, total }`。
 * 回答的 `text` 里出处写成 `[1]`、`[2]`…，第 n 个是 `cites[n - 1]`（收藏库里那条内容）；`gone` 是引用过、现在已经删掉的内容的 id。
 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await getAskDetail(session, (await params).id)));
}

/** 接着追问：`{ question }`（带着之前的一问一答和引用过的内容）。要等模型。返回追问之后的全部对话。 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { id } = await params;
    return NextResponse.json(await askVault(session, { id, question: str((await jsonBody(request)).question) }));
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    await removeAsk(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
