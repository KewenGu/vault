import { NextResponse } from "next/server";
import { getCreatorDetail, removeCreator } from "@/lib/vault/creator-service";
import { itemSummary } from "../../items/serialize";
import { withSession } from "../../respond";
import { creatorJson } from "../serialize";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 一个博主：`{ creator, posts: [{ id, url, title, kind, publishedAt, pinned, status, itemId }], items, page, pages }`。
 * posts 是整份作品清单（status：pending 排着队、saved 已存、held 列出来了没存；saved 而 itemId 是空 = 存过后来删了）；
 * items 是已经存下来的内容，一页 60 条，`?page=` 翻页。
 */
export async function GET(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    const detail = await getCreatorDetail(session, (await params).id, Number(new URL(request.url).searchParams.get("page")) || 1);
    return NextResponse.json({
      creator: creatorJson({ ...detail.creator, counts: detail.counts }),
      posts: detail.posts.map(({ id, url, title, kind, publishedAt, pinned, status, itemId }) => ({ id, url, title, kind, publishedAt, pinned, status, itemId })),
      items: detail.items.map(itemSummary),
      page: detail.page,
      pages: detail.pages,
    });
  });
}

/** 移除这个博主和他的作品清单；已经存进收藏库的内容留着。 */
export async function DELETE(request: Request, { params }: Ctx) {
  return withSession(request, async (session) => {
    await removeCreator(session, (await params).id);
    return NextResponse.json({ ok: true });
  });
}
