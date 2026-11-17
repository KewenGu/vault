import { NextResponse } from "next/server";
import { reprocess } from "@/lib/vault/service";
import { jsonBody, str, withSession } from "../../../respond";

/** 重新处理：`{ from: "fetch" | "analyze", text?: "链接读不到时自己贴的正文" }`。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    const { id } = await params;
    const body = await jsonBody(request);
    await reprocess(session, id, body.from === "fetch" ? "fetch" : "analyze", { userText: str(body.text) || undefined });
    return NextResponse.json({ ok: true }, { status: 202 });
  });
}
