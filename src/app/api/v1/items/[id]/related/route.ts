import { NextResponse } from "next/server";
import { relatedItems } from "@/lib/vault/service";
import { withSession } from "../../../respond";
import { itemSummary } from "../../serialize";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 这条内容的相关内容：`{ related: [{ …一条内容（和列表里的一样）, match: { similarity, shared: [{ id, name, type }] } }], notes }`。
 * `similarity` 是内容相近的程度（0–1，不是靠内容相近找到的是 null）；`shared` 是两条内容都提到的人 / 地方 / 东西；
 * `notes` 是这次没能找的（这条内容没有向量、查询出错）。最多 6 条，相关的在前。不调模型。
 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const { items, notes } = await relatedItems(session, (await params).id);
    return NextResponse.json({ related: items.map((r) => ({ ...itemSummary(r.item), match: { similarity: r.similarity, shared: r.shared } })), notes });
  });
}
