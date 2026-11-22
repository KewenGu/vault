import { NextResponse } from "next/server";
import { tidyTranscript } from "@/lib/vault/journal-service";
import { withSession } from "../../../../../respond";

/**
 * 「AI 整理」：把这段录音转出来的文字发给 Claude 理顺（去口头语、补标点、分段，不改意思）。要等模型，一般几秒到几十秒。
 * 发出去的只有这一段录音的文字。返回 `{ text, notes }`：text 是整理好的文字（不会自己存进日记，由调用方放进 doc.blocks 保存），
 * notes 是这次没做到的（太长只整理了前面一部分…）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  return withSession(request, async (session) => NextResponse.json(await tidyTranscript(session, (await params).mediaId)));
}
