import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { selectAll } from "@/lib/db/select-all";

/** 目录页筛选栏上各项的条数：按内容类型、领域、来源各数一遍（只读四个小列，分页读完）。 */

type Db = SupabaseClient<Database>;
type Row = { content_type: string | null; category: string | null; platform: string | null; source: string; status: string };

export type Facets = { total: number; contentType: Map<string, number>; category: Map<string, number>; origin: Map<string, number> };

/** 来源一栏的键：链接按平台分，上传和文字各算一种 */
export const originKey = (row: Pick<Row, "platform" | "source">) => (row.source === "link" ? (row.platform ?? "web") : row.source);

export function countFacets(rows: Row[]): Facets {
  const facets: Facets = { total: 0, contentType: new Map(), category: new Map(), origin: new Map() };
  const bump = (map: Map<string, number>, key: string | null) => {
    if (key) map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const row of rows) {
    if (row.status === "uploading") continue;
    facets.total++;
    bump(facets.contentType, row.content_type);
    bump(facets.category, row.category);
    bump(facets.origin, originKey(row));
  }
  return facets;
}

export async function loadFacets(db: Db, userId: string): Promise<Facets> {
  const rows = await selectAll<Row>((from, to) => db.from("items").select("content_type,category,platform,source,status").eq("user_id", userId).order("id").range(from, to), "收藏库");
  return countFacets(rows);
}
