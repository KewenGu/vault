/**
 * 把一个查询的所有行读完。PostgREST 一次最多返回 1000 行（Supabase 默认），超过的会被悄悄截掉：
 * 行数会随数据量涨的查询（图谱的节点、关联）都要走这里分页。`page(from, to)` 返回带 range 的查询；
 * 查询要有稳定的排序，不然翻页会漏行 / 重行。
 */
export async function selectAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`读取${what}失败: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < size) return out;
  }
}
