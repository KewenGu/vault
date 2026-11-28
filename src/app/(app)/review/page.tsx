import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/user";
import { cleanTz, readReviewDays } from "@/lib/vault/review";
import { getReview } from "@/lib/vault/review-service";
import { LocalWeek } from "./local-week";
import { ReviewView } from "./review-view";

export const metadata: Metadata = { title: "回顾" };

/**
 * 「回顾」页：这一周存了什么、写了什么，今天翻出来的旧内容，和点了才写的 AI 回顾（见 lib/vault/review-service.ts）。
 * 今天是哪一天、在哪个时区要浏览器告诉（地址里的 today 和 tz）；没带的时候先出一个小组件补上再读。
 */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ today?: string; tz?: string; week?: string }> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  if (!readReviewDays({ today: sp.today, week: sp.week })) return <LocalWeek week={readReviewDays({ today: sp.week })?.today} />;
  const tz = cleanTz(sp.tz);
  const review = await getReview(session, { today: sp.today, tz, week: sp.week });
  return <ReviewView review={review} tz={tz} />;
}
