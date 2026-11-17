import { labeledFetch } from "@/lib/fetch-error";
import { recordEmbeddingUsage } from "@/lib/usage/meter";
import { httpError } from "@/lib/error-text";

const VOYAGE_MODEL = "voyage-3.5-lite"; // 1024 维，与迁移 vector(1024) 绑定
const BATCH = 128;
// 429 退避（2026-07-18 Task 18 E2E 第三跑实测催生）：Voyage 未绑支付方式时限速 3 RPM/10K TPM，
// 一次 429 经 WDK step 三连重试仍撞墙就会杀掉整个研究 run。指数退避 20s/40s/80s 共 3 次——
// 覆盖"分钟窗"类限速（等过窗口即恢复）；仍失败才抛，让 step 层的重试与失败信封接手。
const RATE_RETRIES = 3;
const RATE_BASE_DELAY_MS = 20_000;

/** 批量取 embedding（Voyage v1/embeddings）。每批最多 128 条，单条截断到 8000 字符防超限；
 *  inputType 区分文档/查询侧（双塔模型，检索时用 "query" 与入库时的 "document" 不对称编码）。
 *  按响应里的 index 排序后返回，保证与入参顺序一致（Voyage 不保证返回顺序）。 */
export async function embedTexts(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      res = await labeledFetch("Voyage 嵌入（api.voyageai.com）", "https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({ model: VOYAGE_MODEL, input: batch, input_type: inputType }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status !== 429 || attempt >= RATE_RETRIES) break;
      const delayMs = RATE_BASE_DELAY_MS * 2 ** attempt;
      console.error(`Voyage 429（批 ${i / BATCH + 1}，第 ${attempt + 1} 次），${delayMs / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (!res.ok) throw await httpError("Voyage", res);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
    // 真实用量按 Voyage 回包的 usage.total_tokens 记（旧口径是按字符数 /4 粗估）。
    recordEmbeddingUsage("voyage", VOYAGE_MODEL, json.usage?.total_tokens);
    // PR#7 审查修复：Voyage 短回包（返回条数 < 入参条数）此前静默放行——下游按下标对位消费
    // （merge 批发向量、rollback 分块回插），缺位变成 undefined → 节点带 NULL embedding 落库，
    // 消歧检索命不中 → 后续刷新成片重复建节点，且事后无从溯源。当场抛错走各自的失败路径。
    if (json.data.length !== batch.length) {
      throw new Error(`Voyage 返回条数不符: 期望 ${batch.length} 实得 ${json.data.length}（批 ${i / BATCH + 1}）`);
    }
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}

/** F8⑪：supabase-js 读回 pgvector 列时是字符串 "[0.1,0.2,…]" 而非 number[]。
 *  所有读侧（聚类、展示）必须过此函数解析，避免误把字符串当数组用。
 *  已是 number[] 原样返回；字符串走 JSON.parse 并校验全为 number；其余非法输入抛错。 */
export function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "number")) return v as number[];
    throw new Error("parseVector: array contains non-number element");
  }
  if (typeof v === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      throw new Error(`parseVector: malformed vector string: ${v}`);
    }
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) {
      return parsed as number[];
    }
    throw new Error(`parseVector: malformed vector string: ${v}`);
  }
  throw new Error(`parseVector: unsupported input type: ${typeof v}`);
}
