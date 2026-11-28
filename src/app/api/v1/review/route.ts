import { NextResponse } from "next/server";
import { getReview, writeWeekReview, type Review } from "@/lib/vault/review-service";
import { itemSummary } from "../items/serialize";
import { jsonBody, withSession } from "../respond";

const serialize = (review: Review) => ({
  today: review.today,
  week: {
    ...review.week,
    items: review.week.items.map(itemSummary),
    byCategory: review.week.byCategory.map((g) => ({ category: g.category, label: g.label, items: g.items.map((i) => i.id) })),
    own: review.week.own.map((i) => i.id),
  },
  resurfaced: review.resurfaced && {
    picks: review.resurfaced.picks.map(itemSummary),
    lookBack: review.resurfaced.lookBack.map((x) => ({ label: x.label, item: itemSummary(x.item) })),
  },
});

/**
 * 回顾：`today` = 看的人当地的今天（`YYYY-MM-DD`，必须给：服务器不知道他在哪个时区），`tz` = 时区差（分钟，JavaScript 的
 * `new Date().getTimezoneOffset()`：北京是 -480；不给按 UTC），`week` = 看哪一周（那一周里的任何一天；不给是这一周）。不调模型。
 * 返回 `{ today, week: { week, lastDay, label, items, more, byCategory: [{ category, label, items: [id] }], entities: [{ id, name, type, count }],
 * tags: [{ tag, count }], own: [id], notes: [{ note, itemTitle }], asks, aiReviewId, gaps }, resurfaced: { picks, lookBack: [{ label, item }] } | null }`。
 * `items` 是这一周存的内容（和列表里的一样），最多 200 条（`more`）；`entities`、`tags` 是这一周不止一条内容提到的；`aiReviewId` 是 AI 给这一周写过的回顾
 * （一次提问的 id，没写过是 `null`）；`resurfaced` 是今天翻出来的旧内容和往期的今天存的，读不出来是 `null`。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => {
    const p = new URL(request.url).searchParams;
    return NextResponse.json(serialize(await getReview(session, { today: p.get("today"), tz: p.get("tz"), week: p.get("week") ?? undefined })));
  });
}

/**
 * 让 AI 写一周的回顾：`{ week: "那一周里的任何一天", tz? }`。要等模型，一般十几秒到一分钟。
 * 返回 `{ id, existing }`：存成的那次提问（用 `GET /api/v1/asks/:id` 读，可以接着追问）；这一周已经写过的不重写，`existing` 是 true。
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await jsonBody(request);
    const made = await writeWeekReview(session, { week: body.week, tz: body.tz });
    return NextResponse.json(made, { status: made.existing ? 200 : 201 });
  });
}
