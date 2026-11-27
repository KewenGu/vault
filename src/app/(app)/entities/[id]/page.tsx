import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/user";
import { getEntityPage } from "@/lib/vault/entity-service";
import { VaultError } from "@/lib/vault/errors";
import { PAGE_SIZE } from "@/lib/vault/search";
import { EntityView } from "./entity-view";

export const metadata: Metadata = { title: "图谱里的一个" };

/**
 * 实体页：知识图谱里的一个人 / 地方 / 东西，和收藏库里关于它的一切（见 lib/vault/entity-service.ts）。
 * 从详情页的「提到的」、图谱页点进来。
 */
export default async function EntityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  let data;
  try {
    data = await getEntityPage(session, id, { offset: (page - 1) * PAGE_SIZE });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) notFound();
    throw e;
  }
  return <EntityView data={data} page={page} />;
}
