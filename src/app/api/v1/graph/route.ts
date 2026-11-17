import { NextResponse } from "next/server";
import { loadGraph } from "@/lib/graph/data";
import { withSession } from "../respond";

/** 整张知识图谱：`{ nodes: [{ id, name, type, count, summary, aliases }], links: [{ source, target, relation, weight }] }`。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => NextResponse.json(await loadGraph(session.db, session.user.id)));
}
