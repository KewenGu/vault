import { NextResponse } from "next/server";
import { resumeCreator } from "@/lib/vault/creator-service";
import { withSession } from "../../../respond";

/** 接着存：上次停下搁着的、中断时还排着队的，不重新列作品。没有可存的回 400，正在跑回 409。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    await resumeCreator(session, (await params).id);
    return NextResponse.json({ ok: true }, { status: 202 });
  });
}
