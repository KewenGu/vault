import { NextResponse } from "next/server";
import { checkWatch } from "@/lib/vault/intel-service";
import { withSession } from "../../../../respond";

type Ctx = { params: Promise<{ id: string }> };

/** 现在去看这个来源。返回 `{ found, fresh, notes, error }`：来源读不到不算接口出错，原因在 `error` 里。 */
export async function POST(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => NextResponse.json(await checkWatch(session, (await params).id)));
}
