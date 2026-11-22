import { NextResponse } from "next/server";
import { finishMediaUpload } from "@/lib/vault/journal-service";
import { withSession } from "../../../../../respond";

/** 文件传完了。照片当场处理好（status = ready）；录音开始转文字（status = processing，隔几秒 GET …/media 看结果）。返回 `{ media }`。 */
export async function POST(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  return withSession(request, async (session) => NextResponse.json({ media: await finishMediaUpload(session, (await params).mediaId) }));
}
