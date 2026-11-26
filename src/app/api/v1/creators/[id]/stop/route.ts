import { NextResponse } from "next/server";
import { stopCreator } from "@/lib/vault/creator-service";
import { withSession } from "../../../respond";

/** 停下：还排着队的搁下（清单上变成 held），正在处理的那一两条会处理完。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    await stopCreator(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
