import { NextResponse } from "next/server";
import { syncCreator } from "@/lib/vault/creator-service";
import { jsonBody, withSession } from "../../../respond";

/** 再同步：`{ want: 20 }`，重新列最近的 want 条，清单里没有的存进来（找新发的用小的数，往回多存用大的）。正在跑时回 409。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    await syncCreator(session, (await params).id, (await jsonBody(request)).want);
    return NextResponse.json({ ok: true }, { status: 202 });
  });
}
