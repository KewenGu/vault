import { NextResponse } from "next/server";
import { searchItems } from "@/lib/vault/search";
import { AccountLinkError, saveInput, savePage } from "@/lib/vault/service";
import { jsonBody, str, withSession } from "../respond";
import { hitSummary } from "./serialize";

/**
 * 存一条：`{ input: "链接、分享文案或一段文字", note?: "为什么存" }` → `{ id, existing }`。处理在后台跑，用 GET 这条看进度。
 * input 是一个账号的主页（X / TikTok / 抖音 / 小红书 / Instagram / YouTube）时不存，回 400 和 `{ error, account: { platform, handle, url } }`：
 * 整个账号走 `POST /api/v1/creators`（要说存最近的多少条）。
 * 服务器读不到、客户端自己读到的网页：`{ page: { url, title, text, description?, cover?, images?, author?, site?, publishedAt? }, note? }`（见 lib/vault/page-capture.ts）。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    try {
      const saved = body.page !== undefined ? await savePage(session, body.page, str(body.note)) : await saveInput(session, str(body.input), str(body.note));
      return NextResponse.json(saved, { status: saved.existing ? 200 : 201 });
    } catch (e) {
      if (!(e instanceof AccountLinkError)) throw e;
      const { platform, handle, url } = e.account;
      return NextResponse.json({ error: e.message, account: { platform, handle, url } }, { status: 400 });
    }
  });
}

/** 列出 / 搜索：`?q=` 关键词 + 语义；`kind` `type` `category` `tag` `platform` `source` `entity` 筛选；`limit` 最多 200。 */
export async function GET(request: Request) {
  return withSession(request, async (session) => {
    const p = new URL(request.url).searchParams;
    const limit = Number(p.get("limit"));
    const result = await searchItems(session.db, session.user.id, {
      q: p.get("q") ?? "",
      filters: {
        kind: p.get("kind") ?? undefined,
        contentType: p.get("type") ?? undefined,
        category: p.get("category") ?? undefined,
        tag: p.get("tag") ?? undefined,
        platform: p.get("platform") ?? undefined,
        source: p.get("source") ?? undefined,
        entityId: p.get("entity") ?? undefined,
      },
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return NextResponse.json({ items: result.hits.map(hitSummary), terms: result.terms, semantic: result.semantic });
  });
}
