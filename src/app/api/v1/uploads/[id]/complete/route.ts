import { NextResponse } from "next/server";
import { finishUpload } from "@/lib/vault/service";
import { withSession } from "../../../respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(request, async (session) => {
    const { id } = await params;
    await finishUpload(session, id);
    return NextResponse.json({ ok: true }, { status: 202 });
  });
}
