import { ItemCard } from "@/components/item-card";
import type { SearchHit } from "@/lib/vault/search";

/** 按 i % n 把卡片轮流分到 n 栏：第一行从左往右是最新的几条，各栏高度不同所以保留错落 */
function deal<T>(list: T[], n: number): T[][] {
  const cols: T[][] = Array.from({ length: n }, () => []);
  list.forEach((x, i) => cols[i % n].push(x));
  return cols;
}

/** 窄屏一栏、中屏两栏、宽屏三栏各排一份，用断点只显示其中一份（不需要在浏览器里量宽度，也不会加载完再跳一下） */
const LAYOUTS = [
  { n: 1, className: "flex sm:hidden" },
  { n: 2, className: "hidden sm:flex lg:hidden" },
  { n: 3, className: "hidden lg:flex" },
] as const;

/** 收藏库的卡片墙 */
export function ItemGrid({ hits }: { hits: SearchHit[] }) {
  return (
    <>
      {LAYOUTS.map(({ n, className }) => (
        <div key={n} className={`${className} items-start gap-4`}>
          {deal(hits, n).map((col, c) => (
            <div key={c} className="flex min-w-0 flex-1 flex-col gap-4">
              {col.map((hit) => (
                <ItemCard key={hit.item.id} hit={hit} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
