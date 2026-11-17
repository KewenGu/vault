import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth/user";
import { loadGraph } from "@/lib/graph/data";
import { GraphView } from "./graph-view";

export const metadata: Metadata = { title: "图谱" };

export default async function GraphPage() {
  const { user, db } = await requireSession();
  const graph = await loadGraph(db, user.id);
  if (graph.nodes.length === 0) {
    return (
      <p className="panel px-6 py-14 text-center text-sm leading-relaxed text-ink-muted">
        图谱还是空的。每存一条内容，里面提到的人、地方、产品、概念会自动连到这里。
        <Link href="/" className="ml-1 text-accent hover:underline">
          去存第一条
        </Link>
      </p>
    );
  }
  return <GraphView graph={graph} />;
}
