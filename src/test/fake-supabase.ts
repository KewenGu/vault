import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

/**
 * 单测用的内存 supabase：多表 store + 常用链式形状（select/eq/in/gte/lte/lt/is/not/like/order/range/limit/
 * maybeSingle/single、insert、upsert(行, { onConflict })、update().eq()…[.select()[.single()]]、delete().eq()）。只覆盖本项目实际用到的子集：
 * - select 列表支持 `*`、普通列、`alias:col->key` / `alias:col->>key` 的 JSON 取值，以及嵌套关联
 *   `rel(...)`（测试数据把关联对象直接放在 row[rel] 上，原样带出）；
 * - `.or(...)` 视为不过滤（PostgREST 的 or 语法不在这里解析，测试数据自己保证）；
 * - 过滤列可以写关联路径 `posts.persona_id`、`post_variants.posts.persona_id`（逐层取 row 上的关联对象，对应 `!inner` 关联的过滤）；
 * - `select(cols, { count: "exact", head: true })` 返回 `count`（head 时 data 为 null）；
 * - `uniqueKeys` 里声明的列在 insert 时做唯一校验，冲突返回 `{ code: "23505" }`；
 * - `failInsert` / `failUpdate` 按表注入错误；
 * - `storage.from(桶).upload / download / remove / list / createSignedUrl / createSignedUploadUrl` 存在内存 `files` 里（`failUpload` 注入上传失败）。
 * 所有写入按序记在 `ops` 里，便于断言顺序。
 */

type Row = Record<string, unknown>;
type PgError = { message: string; code?: string };

export type FakeSupabase = {
  db: SupabaseClient<Database>;
  store: Record<string, Row[]>;
  ops: string[];
  /** Storage：`<桶>/<路径>` → 文件内容 */
  files: Map<string, { body: Blob | Uint8Array; contentType?: string; createdAt?: string }>;
};

export function makeFakeSupabase(
  seed: Record<string, Row[]>,
  opts: {
    uniqueKeys?: Record<string, string[]>;
    failInsert?: Record<string, PgError>;
    failUpdate?: Record<string, PgError>;
    failSelect?: Record<string, PgError>;
    failUpload?: PgError;
    maxRows?: number;
    /** 数据库函数的实现：名字 → (参数, store) => 返回的 data */
    rpc?: Record<string, (args: Record<string, unknown>, store: Record<string, Row[]>) => unknown>;
    /** 新行的 id 用真的 uuid（默认是好读的 `表名-序号`；走 MCP 这类要校验 uuid 的入口时打开） */
    uuidIds?: boolean;
  } = {}
): FakeSupabase {
  const store: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const defaults = (_name: string, row: Row): Row => ({ ...row });
  const assign = (_name: string, row: Row, patch: Row) => {
    Object.assign(row, patch);
  };
  const ops: string[] = [];
  let counter = 0;

  const table = (name: string) => (store[name] ??= []);

  /** 只在顶层逗号处切分（`posts(topic, personas(name))` 算一列）。 */
  function splitColumns(columns: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of columns) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function project(row: Row, columns: string): Row {
    const cols = splitColumns(columns);
    if (cols.length === 0 || cols.includes("*")) return { ...row };
    const out: Row = {};
    for (const c of cols) {
      // 嵌套关联 `rel(...)`：测试数据里直接把关联对象放在 row[rel] 上，原样带出
      const nested = /^(\w+)(?:!\w+)?\s*\(/.exec(c);
      if (nested) {
        out[nested[1]] = row[nested[1]] ?? null;
        continue;
      }
      const m = /^(?:(\w+):)?(\w+)(?:->>?(\w+))?$/.exec(c);
      if (!m) continue;
      const [, alias, col, key] = m;
      const v = row[col];
      out[alias ?? (key ? key : col)] = key ? ((v as Row | null)?.[key] ?? null) : (v ?? null);
    }
    return out;
  }

  function filterable<T>(getRows: () => Row[], finish: (rows: Row[]) => T) {
    const conds: ((r: Row) => boolean)[] = [];
    const sorts: { col: string; asc: boolean }[] = [];
    let slice: [number, number] | null = null;
    let abortSignal: AbortSignal | undefined;
    const rows = (withSlice = true) => {
      abortSignal?.throwIfAborted();
      let out = getRows().filter((r) => conds.every((c) => c(r)));
      if (sorts.length) {
        out = [...out].sort((a, b) => {
          for (const { col, asc } of sorts) {
            const left = get(a, col), right = get(b, col);
            const cmp = typeof left === "number" && typeof right === "number" ? left - right : String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
            if (cmp) return cmp * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      if (slice && withSlice) out = out.slice(slice[0], slice[1]);
      return out;
    };
    // 关联路径 `rel.col` / `rel.rel2.col`：测试数据把关联对象直接放在 row[rel] 上
    const get = (r: Row, c: string): unknown => c.split(".").reduce<unknown>((v, k) => (v as Row | null | undefined)?.[k], r);
    const chain = {
      abortSignal: (signal: AbortSignal) => ((abortSignal = signal), chain),
      eq: (c: string, v: unknown) => (conds.push((r) => get(r, c) === v), chain),
      neq: (c: string, v: unknown) => (conds.push((r) => get(r, c) !== v), chain),
      in: (c: string, vs: unknown[]) => (conds.push((r) => vs.includes(get(r, c))), chain),
      contains: (c: string, vs: unknown[]) => (conds.push((r) => { const v = get(r, c); return Array.isArray(v) && vs.every((x) => v.includes(x)); }), chain),
      gte: (c: string, v: unknown) => (conds.push((r) => String(get(r, c)) >= String(v)), chain),
      lte: (c: string, v: unknown) => (conds.push((r) => String(get(r, c)) <= String(v)), chain),
      lt: (c: string, v: unknown) => (conds.push((r) => String(get(r, c)) < String(v)), chain),
      is: (c: string, v: unknown) => (conds.push((r) => (get(r, c) ?? null) === v), chain),
      not: (c: string, op: string, v: unknown) =>
        (conds.push((r) => (op === "is" ? (get(r, c) ?? null) !== v : get(r, c) !== v)), chain),
      like: (c: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`);
        conds.push((r) => re.test(String(get(r, c) ?? "")));
        return chain;
      },
      ilike: (c: string, pattern: string) => {
        let regex = "";
        for (let i = 0; i < pattern.length; i++) {
          const ch = pattern[i];
          if (ch === "\\" && i + 1 < pattern.length) regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          else regex += ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        const re = new RegExp(`^${regex}$`, "i");
        conds.push((r) => re.test(String(get(r, c) ?? "")));
        return chain;
      },
      or: (expression: string) => {
        // Agent turn leases: exercise the atomic expired-or-unclaimed condition in concurrency tests.
        const lease = /^run_id\.is\.null,run_expires_at\.lt\.(.+)$/.exec(expression);
        if (lease) conds.push((r) => r.run_id == null || (typeof r.run_expires_at === "string" && r.run_expires_at < lease[1]));
        const scope = /^persona_id\.is\.null,persona_id\.in\.\((.*)\)$/.exec(expression);
        if (scope) conds.push((r) => r.persona_id == null || scope[1].split(",").includes(String(r.persona_id)));
        const contentFamily = /^id\.eq\.([0-9a-f-]+),source_brief_id\.eq\.\1$/i.exec(expression);
        if (contentFamily) conds.push((r) => r.id === contentFamily[1] || r.source_brief_id === contentFamily[1]);
        return chain;
      },
      order: (col: string, o?: { ascending?: boolean }) => (sorts.push({ col, asc: o?.ascending !== false }), chain),
      range: (f: number, t: number) => ((slice = [f, t + 1]), chain),
      limit: (n: number) => ((slice = [0, n]), chain),
      then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish(rows())).then(res, rej),
      rows,
      unpagedRows: () => rows(false),
    };
    return chain;
  }

  function from(name: string) {
    return {
      select(columns = "*", selectOpts?: { count?: string; head?: boolean }) {
        const err = opts.failSelect?.[name];
        let countRows = () => 0;
        const chain = filterable(
          () => table(name),
          (rows) =>
            err
              ? { data: null, error: err, count: null }
              : {
                  data: selectOpts?.head ? null : rows.slice(0, opts.maxRows).map((r) => project(r, columns)),
                  error: null,
                  ...(selectOpts?.count ? { count: countRows() } : {}),
                }
        );
        countRows = () => chain.unpagedRows().length;
        return Object.assign(chain, {
          maybeSingle: () =>
            Promise.resolve(err ? { data: null, error: err } : { data: chain.rows()[0] ? project(chain.rows()[0], columns) : null, error: null }),
          single: () => {
            const r = chain.rows()[0];
            return Promise.resolve(
              err ? { data: null, error: err } : r ? { data: project(r, columns), error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } }
            );
          },
        });
      },
      insert(input: Row | Row[]) {
        const rowsIn: Row[] = (Array.isArray(input) ? input : [input]).map((r) => defaults(name, { id: opts.uuidIds ? (++counter, crypto.randomUUID()) : `${name}-${++counter}`, ...r }));
        let error: PgError | null = opts.failInsert?.[name] ?? null;
        if (!error) {
          for (const key of opts.uniqueKeys?.[name] ?? []) {
            const existing = new Set(table(name).map((r) => r[key]));
            if (rowsIn.some((r) => existing.has(r[key]))) error = { message: `duplicate key value violates unique constraint (${key})`, code: "23505" };
          }
        }
        // The real variant key is UNIQUE NULLS NOT DISTINCT (post_id, platform, account_id).
        if (!error && name === "post_variants") {
          const keys = ["post_id", "platform", "account_id"];
          if (rowsIn.some((r) => r.post_id && r.platform && table(name).some((existing) => keys.every((key) => (r[key] ?? null) === (existing[key] ?? null))))) {
            error = { message: "duplicate variant key", code: "23505" };
          }
        }
        if (!error) {
          table(name).push(...rowsIn);
          ops.push(`insert:${name}`);
        }
        const result = { data: error ? null : rowsIn, error };
        return {
          select: () => ({
            single: () => Promise.resolve(error ? { data: null, error } : { data: rowsIn[0], error: null }),
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
          }),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: null, error }).then(res, rej),
        };
      },
      /** upsert(行, { onConflict: "a,b" })：按冲突列找已有行（null 也算相等，同 nulls not distinct）——有就合并写入，没有就插入。 */
      upsert(input: Row | Row[], upsertOpts?: { onConflict?: string }) {
        const keys = (upsertOpts?.onConflict ?? "id").split(",").map((k) => k.trim());
        const error: PgError | null = opts.failInsert?.[name] ?? null;
        const written: Row[] = [];
        if (!error) {
          for (const r of Array.isArray(input) ? input : [input]) {
            const existing = table(name).find((e) => keys.every((k) => (e[k] ?? null) === (r[k] ?? null)));
            if (existing) {
              assign(name, existing, r);
              written.push(existing);
            } else {
              const row = defaults(name, { id: opts.uuidIds ? (++counter, crypto.randomUUID()) : `${name}-${++counter}`, ...r });
              table(name).push(row);
              written.push(row);
            }
          }
          ops.push(`upsert:${name}`);
        }
        const result = { data: error ? null : written.map((r) => ({ ...r })), error };
        return {
          select: () => ({
            single: () => Promise.resolve(error ? { data: null, error } : { data: result.data?.[0] ?? null, error: null }),
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
          }),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: null, error }).then(res, rej),
        };
      },
      update(vals: Row) {
        const err = opts.failUpdate?.[name] ?? null;
        const apply = (rows: Row[]) => {
          if (err) return { data: null, error: err };
          // Same UNIQUE NULLS NOT DISTINCT (post_id, platform, account_id) as insert, for updates that move a variant's key.
          if (name === "post_variants" && ["post_id", "platform", "account_id"].some((k) => k in vals)) {
            const keys = ["post_id", "platform", "account_id"];
            const next = rows.map((r) => ({ ...r, ...vals }));
            if (next.some((r) => r.post_id && r.platform && table(name).some((e) => !rows.includes(e) && keys.every((k) => (r[k] ?? null) === (e[k] ?? null))))) {
              return { data: null, error: { message: "duplicate variant key", code: "23505" } };
            }
          }
          for (const r of rows) assign(name, r, vals);
          ops.push(`update:${name}`);
          return { data: rows.map((r) => ({ ...r })), error: null };
        };
        const chain = filterable(() => table(name), apply);
        return Object.assign(chain, {
          // update().….select()：先按条件取行再写（写完 status 等条件列就变了），结果只算一次；
          // 可直接 await，也可再接 .single()（0 行 → PGRST116，同 PostgREST）
          select: () => {
            let result: ReturnType<typeof apply> | null = null;
            const run = () => (result ??= apply(chain.rows()));
            return {
              single: () => {
                const r = run();
                if (r.error) return Promise.resolve(r);
                return Promise.resolve(
                  r.data.length ? { data: r.data[0], error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } }
                );
              },
              then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
            };
          },
        });
      },
      delete() {
        const chain = filterable(
          () => table(name),
          (rows) => {
            store[name] = table(name).filter((r) => !rows.includes(r));
            ops.push(`delete:${name}`);
            return { data: null, error: null };
          }
        );
        return chain;
      },
    };
  }

  /** createdAt：存储里的上传时间（list 返回的 created_at；测试可以直接 files.set 一个旧时间） */
  const files = new Map<string, { body: Blob | Uint8Array; contentType?: string; createdAt?: string }>();
  const storage = {
    from(bucket: string) {
      return {
        upload: async (path: string, body: Blob | Uint8Array, o?: { contentType?: string }) => {
          if (opts.failUpload) return { data: null, error: opts.failUpload };
          files.set(`${bucket}/${path}`, { body, contentType: o?.contentType, createdAt: new Date().toISOString() });
          ops.push(`upload:${bucket}/${path}`);
          return { data: { path }, error: null };
        },
        download: async (path: string) => {
          const f = files.get(`${bucket}/${path}`);
          if (!f) return { data: null, error: { message: "Object not found" } };
          return { data: f.body instanceof Blob ? f.body : new Blob([f.body as BlobPart], { type: f.contentType }), error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) files.delete(`${bucket}/${p}`);
          ops.push(`remove:${bucket}/${paths.join(",")}`);
          return { data: [], error: null };
        },
        /** 列出「文件夹」下一层的文件（名字相对该文件夹），同 Supabase Storage 的 list(path)。 */
        list: async (folder: string) => {
          const prefix = `${bucket}/${folder.replace(/\/+$/, "")}/`;
          const names = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length));
          const sizeOf = (name: string) => {
            const body = files.get(prefix + name)?.body;
            return body instanceof Blob ? body.size : (body?.byteLength ?? 0);
          };
          return { data: names.sort().map((name) => ({ name, created_at: files.get(prefix + name)?.createdAt ?? null, metadata: { size: sizeOf(name) } })), error: null };
        },
        createSignedUrl: async (path: string, expiresIn: number) => {
          if (!files.has(`${bucket}/${path}`)) return { data: null, error: { message: "Object not found" } };
          ops.push(`sign:${bucket}/${path}:${expiresIn}`);
          return { data: { signedUrl: `https://fake.storage/${bucket}/${path}?token=signed` }, error: null };
        },
        /** 签名上传地址：只记一笔；测试里用 files.set 模拟调用方 PUT 上去的文件。 */
        createSignedUploadUrl: async (path: string) => {
          ops.push(`sign-upload:${bucket}/${path}`);
          return { data: { signedUrl: `https://fake.storage/upload/${bucket}/${path}?token=up`, token: "up", path }, error: null };
        },
      };
    },
  };

  // 数据库函数：测试自己给实现（opts.rpc）；没给的返回空结果
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    ops.push(`rpc:${name}`);
    const handler = opts.rpc?.[name];
    return { data: handler ? handler(args, store) : null, error: null };
  };
  return { db: { from, storage, rpc } as unknown as SupabaseClient<Database>, store, ops, files };
}
