"use server";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { VaultError } from "@/lib/vault/errors";
import { getResurfaced, writeWeekReview } from "@/lib/vault/review-service";
import { displayTitle } from "@/lib/vault/store";
import type { ActionState } from "../actions";

/** 让 AI 写这一周的回顾（要等模型，一般十几秒到一分钟）。写完去「问」的对话页看；这一周写过的直接去那一次。 */
export async function writeReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  let made;
  try {
    made = await writeWeekReview(session, { week: String(formData.get("week") ?? ""), tz: String(formData.get("tz") ?? "") });
  } catch (e) {
    if (e instanceof VaultError) return { error: e.message };
    console.error("写一周回顾出错:", e);
    return { error: "出错了，请稍后重试" };
  }
  redirect(`/ask/${made.id}`);
}

export type ResurfacedRow = { id: string; title: string; summary: string; tag: string };

/** 今天翻出来的旧内容（首页那一小块：今天是哪一天只有浏览器知道，页面出来之后才来问）。读不出来就是没有。 */
export async function resurfacedAction(today: string, tz: number): Promise<ResurfacedRow[]> {
  const session = await requireSession();
  try {
    const found = await getResurfaced(session, { today, tz });
    if (!found) return [];
    return [...found.lookBack.map((x) => ({ item: x.item, tag: `${x.label}的今天` })), ...found.picks.map((item) => ({ item, tag: "翻到的" }))].map(({ item, tag }) => ({ id: item.id, title: displayTitle(item), summary: item.summary, tag }));
  } catch (e) {
    if (!(e instanceof VaultError)) console.error("翻旧内容出错:", e);
    return [];
  }
}
