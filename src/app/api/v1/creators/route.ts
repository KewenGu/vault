import { NextResponse } from "next/server";
import { addCreator, listMyCreators } from "@/lib/vault/creator-service";
import { jsonBody, str, withSession } from "../respond";
import { creatorJson } from "./serialize";

/** 列出加过的博主，最近加的在前。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json({ creators: (await listMyCreators(session)).map(creatorJson) }));
}

/**
 * 加一个博主、开始存他的作品：`{ input: "主页的链接或分享文案", want: 20 }` → `{ id, existing }`。
 * want = 存最近的多少条（1–1000）。列作品和一条条存都在后台跑，用 GET /api/v1/creators/<id> 看进度。
 * 已经加过的：没在跑就按这次的条数再同步一遍。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    const saved = await addCreator(session, str(body.input), body.want);
    return NextResponse.json(saved, { status: saved.existing ? 200 : 201 });
  });
}
