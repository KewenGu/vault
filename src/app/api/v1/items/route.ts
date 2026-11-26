import { NextResponse } from "next/server";
import { searchItems } from "@/lib/vault/search";
import { AccountLinkError, saveInput, saveOwn, savePage } from "@/lib/vault/service";
import { jsonBody, str, withSession } from "../respond";
import { hitSummary } from "./serialize";

/**
 * 存一条：`{ input: "链接、分享文案或一段文字", note?: "为什么存" }` → `{ id, existing }`。处理在后台跑，用 GET 这条看进度。
 * input 是一个账号的主页（X / TikTok / 抖音 / 小红书 / Instagram / YouTube / B 站 / 微博）时不存，回 400 和 `{ error, account: { platform, handle, url } }`：
 * 整个账号走 `POST /api/v1/creators`（要说存最近的多少条）。
 * 自己写的（一个想法、一段笔记）：`{ input: "写的内容", own: true, note? }`——写了什么就存什么，不当链接读、不去重，来源是 `own`。
 * 服务器读不到、客户端自己读到的网页：`{ page: { url, title, text, description?, cover?, images?, author?, site?, publishedAt? }, note? }`（见 lib/vault/page-capture.ts）。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    try {
      const saved = body.page !== undefined ? await savePage(session, body.page, str(body.note)) : body.own === true ? await saveOwn(session, str(body.input), str(body.note)) : await saveInput(session, str(body.input), str(body.note));
      return NextResponse.json(saved, { status: saved.existing ? 200 : 201 });
    } catch (e) {
      if (!(e instanceof AccountLinkError)) throw e;
      const { platform, handle, url } = e.account;
      return NextResponse.json({ error: e.message, account: { platform, handle, url } }, { status: 400 });
    }
  });
}

/**
 * 列出 / 搜索：`?q=` 关键词 + 语义；`kind` `type` `category` `tag` `platform` `source` `entity` 筛选；`limit` 一次要多少条（默认 60，最多 200）；
 * `offset` 从第几条开始（翻页：下一页是 offset + 这次拿到的条数）。返回 `{ items, total, capped, terms, semantic }`：
 * `total` 是符合条件的一共多少条。只是列出 / 筛选时按存进来的时间倒序，能一直翻到最早的一条；带了 `q` 或 `entity` 时按相关程度排，
 * 最多只有最相关的 200 条——到了这个上限 `capped` 是 true，实际符合的可能更多。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => {
    const p = new URL(request.url).searchParams;
    const limit = Number(p.get("limit"));
    const offset = Number(p.get("offset"));
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
      // 接口一律按翻页的方式查（不给 offset 就是从头）：这样 total 总是「一共多少条」
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    });
    return NextResponse.json({ items: result.hits.map(hitSummary), total: result.total, capped: result.capped, terms: result.terms, semantic: result.semantic });
  });
}
