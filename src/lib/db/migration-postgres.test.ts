import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STORE_MAX_CEILING_MB } from "@/lib/vault/limits";

/**
 * 迁移脚本在真实的 PostgreSQL 上跑一遍（本机临时起一个实例，测完删掉）：表、行级安全、搜索函数、图谱函数。
 * 需要本机有 PostgreSQL 16 + pgvector；没有就跳过（CI 里设 REQUIRE_POSTGRES=1 让它必须跑）。
 * Supabase 自带的东西（auth.users、auth.uid()、storage.buckets、三个角色）在这里用最小的替身。
 */

function postgres(): { bin: string; asPostgres: boolean } | null {
  try {
    const bin = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
    const share = execFileSync("pg_config", ["--sharedir"], { encoding: "utf8" }).trim();
    if (!existsSync(join(bin, "initdb")) || !existsSync(join(share, "extension", "vector.control"))) return null;
    // initdb 不许 root 跑：root 下换成 postgres 用户（没有 runuser 就跳过）
    if (process.getuid?.() === 0) {
      execFileSync("runuser", ["-u", "postgres", "--", "true"], { stdio: "ignore" });
      return { bin, asPostgres: true };
    }
    return { bin, asPostgres: false };
  } catch {
    return null;
  }
}
const pg = postgres();
if (!pg && process.env.REQUIRE_POSTGRES === "1") throw new Error("PostgreSQL 16 + pgvector required for the migration test");

const PORT = "15441";
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
/** 第 n 维是 1、其余是 0 的 1024 维向量（两条内容的余弦只有 0 和 1 两种，好断言） */
const axis = (n: number) => `(select array_agg(case when g = ${n} then 1 else 0 end)::extensions.vector from generate_series(1, 1024) g)`;

describe.skipIf(!pg)("migrations — isolated PostgreSQL", () => {
  let root = "";
  let started = false;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  const run = (program: string, args: string[], asPostgres = false) =>
    asPostgres
      ? execFileSync("runuser", ["-u", "postgres", "--", join(pg!.bin, program), ...args], { encoding: "utf8", env, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })
      : execFileSync(join(pg!.bin, program), args, { encoding: "utf8", env, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  const query = (sql: string) => run("psql", ["-X", "-h", root, "-p", PORT, "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
  /** 以登录用户的身份查（行级安全生效） */
  const as = (user: string, sql: string) => query(`begin; set local role authenticated; set local request.jwt.claim.sub = '${user}'; ${sql}; commit;`);
  const migrations = readdirSync(resolve("supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vault-pg-"));
    if (pg!.asPostgres) {
      const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }));
      chownSync(root, uid, uid);
    }
    run("initdb", ["-D", join(root, "data"), "-U", "postgres", "-A", "trust", "--no-locale", "--encoding=UTF8"], pg!.asPostgres);
    run("pg_ctl", ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-o", `-F -p ${PORT} -k ${root} -c listen_addresses=''`, "start"], pg!.asPostgres);
    started = true;
    query(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema extensions; create schema auth; create schema storage;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
      grant usage on schema public, extensions, auth to authenticated, service_role;
      insert into auth.users values ('${alice}'), ('${bob}');`);
    for (const file of migrations) query(readFileSync(resolve("supabase/migrations", file), "utf8"));
  }, 60_000);

  afterAll(() => {
    if (started) run("pg_ctl", ["-D", join(root, "data"), "-m", "immediate", "-w", "stop"], pg!.asPostgres);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const item = (user: string, key: string, cols: Record<string, string> = {}) => {
    const all = { user_id: `'${user}'`, source: `'link'`, dedupe_key: `'${key}'`, status: `'ready'`, ...cols };
    return query(`insert into items (${Object.keys(all).join(",")}) values (${Object.values(all).join(",")}) returning id`);
  };
  const search = (user: string, args: string) => as(user, `select string_agg(i.dedupe_key, ',' order by s.score desc, i.created_at desc) from search_items('${user}'${args ? `, ${args}` : ""}) s join items i on i.id = s.id`);

  beforeEach(() => {
    query("truncate items, entities, maps, asks, journal_entries, journal_media, journal_stickers, creators cascade");
  });

  it("migrations can be applied twice", () => {
    for (const file of migrations) query(readFileSync(resolve("supabase/migrations", file), "utf8"));
    expect(query("select count(*) from storage.buckets where id = 'vault' and not public")).toBe("1");
    // 桶的单文件上限 = 代码里存档上限能调到的最大值（实际用多少由 VAULT_STORE_MAX_MB 定，默认 50 MB）
    expect(Number(query("select file_size_limit from storage.buckets where id = 'vault'"))).toBe(STORE_MAX_CEILING_MB * 1024 * 1024);
  });

  it("row level security shows each user only their own rows, and blocks writing as someone else", () => {
    item(alice, "a1", { title: `'alice 的'` });
    item(bob, "b1", { title: `'bob 的'` });
    expect(as(alice, "select string_agg(dedupe_key, ',') from items")).toBe("a1");
    expect(as(bob, "select string_agg(dedupe_key, ',') from items")).toBe("b1");
    expect(() => as(alice, `insert into items (user_id, source, dedupe_key) values ('${bob}', 'text', 'x')`)).toThrow(/row-level security/);
    // 传别人的 user_id 调搜索函数也看不到别人的
    expect(as(alice, `select count(*) from search_items('${bob}')`)).toBe("0");
    // 默认填当前用户
    as(alice, "insert into items (source, dedupe_key) values ('text', 'mine')");
    expect(query(`select user_id from items where dedupe_key = 'mine'`)).toBe(alice);
  });

  it("maps are private to their owner", () => {
    query(`insert into maps (user_id, title) values ('${alice}', 'alice 的图'), ('${bob}', 'bob 的图')`);
    expect(as(alice, "select string_agg(title, ',') from maps")).toBe("alice 的图");
    expect(as(bob, "select string_agg(title, ',') from maps")).toBe("bob 的图");
    expect(() => as(alice, `insert into maps (user_id, title) values ('${bob}', 'x')`)).toThrow(/row-level security/);
    // 改 / 删别人的：行级安全让它一行都碰不到
    expect(as(alice, `update maps set title = '抢' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from maps where user_id = '${bob}' returning id`)).toBe("");
    expect(query(`select title from maps where user_id = '${bob}'`)).toBe("bob 的图");
    // 默认填当前用户；节点、来源、对话默认是空的
    as(alice, "insert into maps (title) values ('默认是我的')");
    expect(query(`select user_id || ' ' || nodes::text || ' ' || sources::text || ' ' || chat::text from maps where title = '默认是我的'`)).toBe(`${alice} [] {} []`);
    // 后台（service_role）读得到，代码里自己带 user_id
    expect(query(`begin; set local role service_role; select count(*) from maps where user_id = '${bob}'; commit;`)).toBe("1");
  });

  it("asks are private to their owner", () => {
    query(`insert into asks (user_id, title) values ('${alice}', 'alice 问的'), ('${bob}', 'bob 问的')`);
    expect(as(alice, "select string_agg(title, ',') from asks")).toBe("alice 问的");
    expect(as(bob, "select string_agg(title, ',') from asks")).toBe("bob 问的");
    expect(() => as(alice, `insert into asks (user_id, title) values ('${bob}', 'x')`)).toThrow(/row-level security/);
    // 改 / 删别人的：行级安全让它一行都碰不到
    expect(as(alice, `update asks set title = '抢' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from asks where user_id = '${bob}' returning id`)).toBe("");
    expect(query(`select title from asks where user_id = '${bob}'`)).toBe("bob 问的");
    // 默认填当前用户；对话、引用过的内容、用量默认是空的
    as(alice, "insert into asks (title) values ('默认是我的')");
    expect(query(`select user_id || ' ' || chat::text || ' ' || sources::text || ' ' || usage::text || ' ' || cost_usd from asks where title = '默认是我的'`)).toBe(`${alice} [] {} {} 0.000000`);
    // 改了之后 updated_at 跟着走（列表按它排）
    query(`update asks set created_at = now() - interval '1 day', updated_at = now() - interval '1 day' where title = '默认是我的'`);
    as(alice, `update asks set chat = '[{"role":"user","text":"问","at":"t"}]' where title = '默认是我的'`);
    expect(query(`select updated_at > created_at from asks where title = '默认是我的'`)).toBe("t");
    // 后台（service_role）读得到，代码里自己带 user_id
    expect(query(`begin; set local role service_role; select count(*) from asks where user_id = '${bob}'; commit;`)).toBe("1");
  });

  it("traces are private to their owner, cannot be attached to someone else's item, and go away with the item", () => {
    item(alice, "a1");
    item(bob, "b1");
    const mine = query(`select id from items where dedupe_key = 'a1'`);
    const theirs = query(`select id from items where dedupe_key = 'b1'`);
    query(`insert into item_traces (item_id, user_id, status, result) values ('${mine}', '${alice}', 'ready', '{"overview":"alice 的"}'), ('${theirs}', '${bob}', 'ready', '{"overview":"bob 的"}')`);
    expect(as(alice, "select string_agg(result->>'overview', ',') from item_traces")).toBe("alice 的");
    expect(as(bob, "select string_agg(result->>'overview', ',') from item_traces")).toBe("bob 的");
    // 改 / 删别人的：行级安全让它一行都碰不到
    expect(as(alice, `update item_traces set status = 'failed' where user_id = '${bob}' returning item_id`)).toBe("");
    expect(as(alice, `delete from item_traces where user_id = '${bob}' returning item_id`)).toBe("");
    expect(query(`select status from item_traces where user_id = '${bob}'`)).toBe("ready");
    // 不能替别人写，也不能给别人的内容建一行（外键带着 user_id）
    query(`delete from item_traces where item_id = '${theirs}'`);
    expect(() => as(alice, `insert into item_traces (item_id, user_id) values ('${theirs}', '${bob}')`)).toThrow(/row-level security/);
    expect(() => as(alice, `insert into item_traces (item_id) values ('${theirs}')`)).toThrow(/foreign key/);
    // 一条内容只有一行；默认是自己的、正在查
    expect(() => as(alice, `insert into item_traces (item_id) values ('${mine}')`)).toThrow(/duplicate key/);
    expect(() => query(`update item_traces set status = 'done' where item_id = '${mine}'`)).toThrow(/item_traces_status_check/);
    as(bob, `insert into item_traces (item_id) values ('${theirs}')`);
    expect(query(`select user_id || ' ' || status || ' ' || usage::text || ' ' || cost_usd from item_traces where item_id = '${theirs}'`)).toBe(`${bob} running {} 0.000000`);
    // 后台（service_role）读得到、写得了，代码里自己带 user_id
    expect(query(`begin; set local role service_role; update item_traces set status = 'ready' where item_id = '${theirs}' and user_id = '${bob}' returning status; commit;`)).toBe("ready");
    // 内容删了，溯源结果跟着删
    as(alice, `delete from items where id = '${mine}'`);
    expect(query(`select count(*) from item_traces where user_id = '${alice}'`)).toBe("0");
  });

  it("notes are private to their owner, cannot hang on someone else's item, need a highlight or some words, and go away with the item", () => {
    const mine = item(alice, "a1");
    const theirs = item(bob, "b1");
    query(`insert into item_notes (user_id, item_id, quote, body, at) values ('${alice}', '${mine}', '应急金放货币基金', '我放余额宝', 72.5), ('${bob}', '${theirs}', 'bob 划的', '', null)`);
    expect(as(alice, "select string_agg(quote, ',') from item_notes")).toBe("应急金放货币基金");
    expect(as(bob, "select string_agg(quote, ',') from item_notes")).toBe("bob 划的");
    // 改 / 删别人的：行级安全让它一行都碰不到
    expect(as(alice, `update item_notes set body = '抢' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from item_notes where user_id = '${bob}' returning id`)).toBe("");
    expect(query(`select body from item_notes where user_id = '${bob}'`)).toBe("");
    // 不能替别人写，也不能在别人的内容上写（外键带着 user_id）
    expect(() => as(alice, `insert into item_notes (user_id, item_id, body) values ('${bob}', '${theirs}', 'x')`)).toThrow(/row-level security/);
    expect(() => as(alice, `insert into item_notes (item_id, body) values ('${theirs}', 'x')`)).toThrow(/foreign key/);
    // 划线和自己写的话至少要有一样
    expect(() => as(alice, `insert into item_notes (item_id) values ('${mine}')`)).toThrow(/item_notes_not_empty/);
    // 默认是自己的；搜索用的那一列数据库自己拼，改了跟着变，中文按 ilike 搜得到（换行两边的都算）
    as(alice, `insert into item_notes (item_id, body) values ('${mine}', '下个月开始定投')`);
    expect(query(`select user_id || ' ' || quote || '|' || coalesce(at::text, 'null') from item_notes where body = '下个月开始定投'`)).toBe(`${alice} |null`);
    expect(as(alice, `select count(*) from item_notes where search_text ilike '%货币基金%' and search_text ilike '%余额宝%'`)).toBe("1");
    as(alice, `update item_notes set body = '改成放国债' where at = 72.5`);
    expect(as(alice, `select string_agg(body, ',') from item_notes where search_text ilike '%国债%'`)).toBe("改成放国债");
    expect(as(alice, `select count(*) from item_notes where search_text ilike '%余额宝%'`)).toBe("0");
    expect(query(`select updated_at >= created_at from item_notes where at = 72.5`)).toBe("t");
    // 后台（service_role）读得到，代码里自己带 user_id
    expect(query(`begin; set local role service_role; select count(*) from item_notes where user_id = '${alice}'; commit;`)).toBe("2");
    // 内容删了，它上面的笔记跟着删；别人的不受影响
    as(alice, `delete from items where id = '${mine}'`);
    expect(query(`select count(*) || ' ' || string_agg(quote, ',') from item_notes`)).toBe("1 bob 划的");
  });

  it("creators and their post lists are private to their owner; posts cannot hang on someone else's creator or point at someone else's item", () => {
    const [mine, theirs] = query(`insert into creators (user_id, platform, external_id, url, name) values ('${alice}', 'x', 'karpathy', 'https://x.com/karpathy', 'alice 的'), ('${bob}', 'x', 'karpathy', 'https://x.com/karpathy', 'bob 的') returning id`).split("\n");
    const myItem = item(alice, "x:101");
    const theirItem = item(bob, "x:101");
    query(`insert into creator_posts (user_id, creator_id, external_id, url, status, item_id) values ('${alice}', '${mine}', '101', 'https://x.com/karpathy/status/101', 'saved', '${myItem}'), ('${bob}', '${theirs}', '101', 'https://x.com/karpathy/status/101', 'saved', '${theirItem}')`);

    // 两个人加的是同一个账号，各看各的
    expect(as(alice, "select string_agg(name, ',') from creators")).toBe("alice 的");
    expect(as(bob, "select string_agg(name, ',') from creators")).toBe("bob 的");
    expect(as(alice, "select count(*) from creator_posts")).toBe("1");
    expect(as(alice, `update creators set status = 'failed' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from creators where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `update creator_posts set status = 'held' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from creator_posts where user_id = '${bob}' returning id`)).toBe("");
    expect(query(`select status from creator_posts where user_id = '${bob}'`)).toBe("saved");

    // 不能替别人写；不能把作品挂到别人的博主上，也不能指着别人的内容（外键带着 user_id）
    expect(() => as(alice, `insert into creators (user_id, platform, external_id, url) values ('${bob}', 'x', 'someone', 'https://x.com/someone')`)).toThrow(/row-level security/);
    expect(() => as(alice, `insert into creator_posts (user_id, creator_id, external_id, url) values ('${bob}', '${theirs}', '102', 'u')`)).toThrow(/row-level security/);
    expect(() => as(alice, `insert into creator_posts (creator_id, external_id, url) values ('${theirs}', '102', 'u')`)).toThrow(/foreign key/);
    expect(() => as(alice, `insert into creator_posts (creator_id, external_id, url, item_id) values ('${mine}', '102', 'u', '${theirItem}')`)).toThrow(/foreign key/);

    // 一个人同一个账号只有一行；同一个博主的同一条作品只有一行；状态只有那几种
    expect(() => as(alice, "insert into creators (platform, external_id, url) values ('x', 'karpathy', 'https://x.com/karpathy')")).toThrow(/duplicate key/);
    expect(() => as(alice, `insert into creator_posts (creator_id, external_id, url) values ('${mine}', '101', 'u')`)).toThrow(/duplicate key/);
    expect(() => query(`update creators set status = 'done' where id = '${mine}'`)).toThrow(/creators_status_check/);
    expect(() => query(`update creator_posts set status = 'done' where creator_id = '${mine}'`)).toThrow(/creator_posts_status_check/);

    // 默认值：是我的，正在列；新列出来的作品排队等存
    as(alice, `insert into creators (platform, external_id, url) values ('tiktok', 'tedtoks', 'https://www.tiktok.com/@tedtoks')`);
    expect(query(`select user_id || ' ' || status || ' ' || want || ' ' || notes::text || ' ' || usage::text || ' ' || cost_usd from creators where external_id = 'tedtoks'`)).toBe(`${alice} listing 0 [] {} 0.000000`);
    as(alice, `insert into creator_posts (creator_id, external_id, url) values ('${mine}', '102', 'u')`);
    expect(query(`select user_id || ' ' || status || ' ' || pinned || ' ' || coalesce(item_id::text, '空') from creator_posts where external_id = '102'`)).toBe(`${alice} pending false 空`);

    // 后台任务（service_role）靠代码里带的 user_id
    expect(query(`begin; set local role service_role; update creator_posts set status = 'held' where creator_id = '${theirs}' and user_id = '${bob}' returning status; commit;`)).toBe("held");

    // 内容删了：清单那一行留着，只是不再指着它（「存过、后来删掉了」）；博主删了，清单跟着删，内容留着
    query(`delete from items where id = '${myItem}'`);
    expect(query(`select status || ' ' || coalesce(item_id::text, '空') || ' ' || user_id from creator_posts where creator_id = '${mine}' and external_id = '101'`)).toBe(`saved 空 ${alice}`);
    query(`delete from creators where id = '${theirs}'`);
    expect(query(`select count(*) from creator_posts where user_id = '${bob}'`)).toBe("0");
    expect(query(`select count(*) from items where id = '${theirItem}'`)).toBe("1");
  });

  it("journal entries and their files are private to their owner", () => {
    const [mine, theirs] = query(`insert into journal_entries (user_id, day, title) values ('${alice}', '2026-11-21', 'alice 的日记'), ('${bob}', '2026-11-21', 'bob 的日记') returning id`).split("\n");
    query(`insert into journal_media (user_id, entry_id, kind, path) values ('${alice}', '${mine}', 'audio', 'a/1.m4a'), ('${bob}', '${theirs}', 'image', 'b/1.jpg')`);
    expect(as(alice, "select string_agg(title, ',') from journal_entries")).toBe("alice 的日记");
    expect(as(bob, "select string_agg(title, ',') from journal_entries")).toBe("bob 的日记");
    expect(as(alice, "select string_agg(path, ',') from journal_media")).toBe("a/1.m4a");
    expect(as(bob, "select string_agg(path, ',') from journal_media")).toBe("b/1.jpg");
    // 不能替别人写一篇、不能替别人登记文件
    expect(() => as(alice, `insert into journal_entries (user_id, day) values ('${bob}', '2026-11-21')`)).toThrow(/row-level security/);
    expect(() => as(alice, `insert into journal_media (user_id, entry_id, kind, path) values ('${bob}', '${theirs}', 'image', 'x')`)).toThrow(/row-level security/);
    // 也不能把自己的文件挂到别人的日记上（外键带着 user_id）
    expect(() => as(alice, `insert into journal_media (entry_id, kind, path) values ('${theirs}', 'image', 'x')`)).toThrow(/foreign key/);
    // 改 / 删别人的：行级安全让它一行都碰不到
    expect(as(alice, `update journal_entries set title = '抢' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from journal_entries where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `update journal_media set path = '抢' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from journal_media where user_id = '${bob}' returning id`)).toBe("");
    expect(query(`select title from journal_entries where user_id = '${bob}'`)).toBe("bob 的日记");
    expect(query(`select path from journal_media where user_id = '${bob}'`)).toBe("b/1.jpg");
    // 默认填当前用户；内容默认是空的一页，版本号从 0 开始
    as(alice, "insert into journal_entries (day, title) values ('2026-11-22', '默认是我的')");
    expect(query(`select user_id || ' ' || style || ' ' || rev || ' ' || (doc->'blocks')::text || ' ' || (doc->'decos')::text from journal_entries where title = '默认是我的'`)).toBe(`${alice} fresh 0 [] []`);
    as(alice, `insert into journal_media (entry_id, kind, path) values ('${mine}', 'image', 'a/2.jpg')`);
    expect(query(`select user_id || ' ' || status || ' ' || notes::text from journal_media where path = 'a/2.jpg'`)).toBe(`${alice} uploading {}`);
    // 只收照片和录音，状态只有那四种
    expect(() => query(`insert into journal_media (user_id, entry_id, kind, path) values ('${alice}', '${mine}', 'video', 'x')`)).toThrow(/journal_media_kind_check/);
    expect(() => query(`update journal_media set status = 'done' where path = 'a/1.m4a'`)).toThrow(/journal_media_status_check/);
    // 后台（service_role）读得到、写得了，代码里自己带 user_id
    expect(query(`begin; set local role service_role; update journal_media set status = 'ready', transcript = '[0:02] 今天风特别大' where user_id = '${alice}' and path = 'a/1.m4a' returning status; commit;`)).toBe("ready");
    // 删一篇日记，它的文件的登记跟着删
    as(alice, `delete from journal_entries where id = '${mine}'`);
    expect(query(`select count(*) from journal_media where user_id = '${alice}'`)).toBe("0");
    expect(query(`select count(*) from journal_media where user_id = '${bob}'`)).toBe("1");
  });

  it("my stickers are private to their owner", () => {
    query(`insert into journal_stickers (user_id, path) values ('${alice}', 'a/s1.webp'), ('${bob}', 'b/s1.webp')`);
    expect(as(alice, "select string_agg(path, ',') from journal_stickers")).toBe("a/s1.webp");
    expect(as(bob, "select string_agg(path, ',') from journal_stickers")).toBe("b/s1.webp");
    expect(() => as(alice, `insert into journal_stickers (user_id, path) values ('${bob}', 'x')`)).toThrow(/row-level security/);
    expect(as(alice, `update journal_stickers set path = '抢' where user_id = '${bob}' returning id`)).toBe("");
    expect(as(alice, `delete from journal_stickers where user_id = '${bob}' returning id`)).toBe("");
    expect(query(`select path from journal_stickers where user_id = '${bob}'`)).toBe("b/s1.webp");
    // 默认填当前用户，一开始是「等上传」；状态只有两种
    as(alice, "insert into journal_stickers (path) values ('a/s2-raw.png')");
    expect(query(`select user_id || ' ' || status from journal_stickers where path = 'a/s2-raw.png'`)).toBe(`${alice} uploading`);
    expect(() => query(`update journal_stickers set status = 'done' where path = 'a/s1.webp'`)).toThrow(/journal_stickers_status_check/);
    // 后台（service_role）读得到、写得了，代码里自己带 user_id
    expect(query(`begin; set local role service_role; update journal_stickers set status = 'ready', width = 200 where user_id = '${alice}' and path = 'a/s2-raw.png' returning status; commit;`)).toBe("ready");
  });

  it("journal search finds Chinese text with ilike, and saving bumps updated_at", () => {
    const id = query(`insert into journal_entries (user_id, day, search_text, updated_at) values ('${alice}', '2026-11-21', '去了趟江边\n买了一杯热的桂花拿铁 100% 好喝', now() - interval '1 hour') returning id`);
    expect(as(alice, `select count(*) from journal_entries where search_text ilike '%桂花拿铁%'`)).toBe("1");
    expect(as(alice, `select count(*) from journal_entries where search_text ilike '%100\\%%'`)).toBe("1");
    expect(as(alice, `select count(*) from journal_entries where search_text ilike '%没写过%'`)).toBe("0");
    // 带着版本号保存：对得上才写
    expect(as(alice, `update journal_entries set title = '改', rev = 1 where id = '${id}' and rev = 0 returning rev`)).toBe("1");
    expect(as(alice, `update journal_entries set title = '旧标签页', rev = 1 where id = '${id}' and rev = 0 returning rev`)).toBe("");
    expect(query(`select title || ' ' || (updated_at > now() - interval '1 minute') from journal_entries where id = '${id}'`)).toBe("改 true");
  });

  it("the same content is stored once per user", () => {
    item(alice, "xiaohongshu:abc");
    expect(() => item(alice, "xiaohongshu:abc")).toThrow(/items_dedupe_key/);
    item(bob, "xiaohongshu:abc");
  });

  it("keyword search finds two-character Chinese words and ranks title hits above body hits", () => {
    item(alice, "body", { title: `'周末去哪玩'`, search_text: `'周末去哪玩\n视频里提到三亚的亲子酒店'` });
    item(alice, "title", { title: `'三亚亲子酒店推荐'`, search_text: `'三亚亲子酒店推荐'` });
    item(alice, "none", { title: `'红烧肉做法'`, search_text: `'红烧肉做法'` });
    expect(search(alice, "array['三亚']")).toBe("title,body");
    // 两个词：都中的排在只中一个的前面
    item(alice, "one", { title: `'三亚海鲜'`, search_text: `'三亚海鲜'` });
    expect(search(alice, "array['三亚', '酒店']")).toBe("title,body,one");
    // ilike 的通配符按字面处理由调用方转义（lib/vault/search.ts），这里确认大小写不敏感
    item(alice, "en", { title: `'Sous Vide Steak'`, search_text: `'Sous Vide Steak'` });
    expect(search(alice, "array['sous vide']")).toBe("en");
  });

  it("semantic search returns items above the similarity floor, and fuses with keyword hits", () => {
    item(alice, "near", { title: `'海边度假'`, search_text: `'海边度假'`, embedding: axis(1) });
    item(alice, "far", { title: `'编程入门'`, search_text: `'编程入门'`, embedding: axis(2) });
    item(alice, "both", { title: `'三亚海边'`, search_text: `'三亚海边'`, embedding: axis(1) });
    expect(search(alice, `'{}', ${axis(1)}`).split(",").sort()).toEqual(["both", "near"]);
    // 关键词 + 语义都中的排最前；只中语义的也在
    expect(search(alice, `array['三亚'], ${axis(1)}`)).toBe("both,near");
    // 「相关的内容」的调法（lib/vault/related.ts）：拿一条内容自己存着的向量、带更高的门槛、不带关键词。它自己也在结果里，调用方去掉
    expect(search(alice, `p_embedding => (select embedding from items where dedupe_key = 'near'), p_min_similarity => 0.68`).split(",").sort()).toEqual(["both", "near"]);
    expect(search(bob, `p_embedding => ${axis(1)}, p_min_similarity => 0.68`)).toBe("");
  });

  it("filters by kind, type, category, tag, platform, source and entity; no query lists by time", () => {
    const a = item(alice, "a", { kind: `'video'`, content_type: `'recipe'`, category: `'food'`, tags: `array['家常菜','快手菜']`, platform: `'douyin'`, created_at: `now() - interval '2 hours'` });
    item(alice, "b", { kind: `'image'`, content_type: `'place'`, category: `'travel'`, tags: `array['三亚']`, platform: `'xiaohongshu'`, created_at: `now() - interval '1 hour'` });
    item(alice, "c", { source: `'upload'`, kind: `'image'`, content_type: `'document'`, category: `'other'` });
    item(alice, "uploading", { source: `'upload'`, status: `'uploading'` });
    expect(search(alice, "")).toBe("c,b,a");
    expect(search(alice, "p_kind => 'image'")).toBe("c,b");
    expect(search(alice, "p_content_type => 'recipe'")).toBe("a");
    expect(search(alice, "p_category => 'travel'")).toBe("b");
    expect(search(alice, "p_tag => '快手菜'")).toBe("a");
    expect(search(alice, "p_platform => 'douyin'")).toBe("a");
    expect(search(alice, "p_source => 'upload'")).toBe("c");
    // 自己写的是另一种来源（迁移 20261126000004 放宽的检查）：存得进、单独筛得出；乱写的来源还是不收
    item(alice, "mine", { source: `'own'`, kind: `'text'`, user_text: `'定投别停'` });
    expect(search(alice, "p_source => 'own'")).toBe("mine");
    expect(search(alice, "p_source => 'text'")).not.toContain("mine");
    expect(() => item(alice, "bogus", { source: `'diary'` })).toThrow(/items_source_check/);
    query("delete from items where dedupe_key = 'mine'");
    const e = query(`insert into entities (user_id, type, name) values ('${alice}', 'concept', '家常菜') returning id`);
    query(`insert into item_entities (item_id, entity_id, user_id) values ('${a}', '${e}', '${alice}')`);
    expect(search(alice, `p_entity_id => '${e}'`)).toBe("a");
    expect(as(alice, `select string_agg(tag || ':' || n, ',') from tag_counts('${alice}')`)).toBe("三亚:1,家常菜:1,快手菜:1");
  });

  it("match_entities returns the nearest entities of the same type; orphans are pruned when their items go away", () => {
    const sanya = query(`insert into entities (user_id, type, name, embedding) values ('${alice}', 'place', '三亚', ${axis(1)}) returning id`);
    query(`insert into entities (user_id, type, name, embedding) values ('${alice}', 'place', '成都', ${axis(2)})`);
    query(`insert into entities (user_id, type, name, embedding) values ('${alice}', 'concept', '三亚攻略', ${axis(1)})`);
    query(`insert into entities (user_id, type, name, embedding) values ('${bob}', 'place', '三亚', ${axis(1)})`);
    expect(as(alice, `select name || ':' || round(similarity::numeric, 2) from match_entities('${alice}', 'place', ${axis(1)}, 1)`)).toBe("三亚:1.00");
    // 同一个人同类型不能有两个同名实体（不分大小写）
    expect(() => query(`insert into entities (user_id, type, name) values ('${alice}', 'place', '三亚')`)).toThrow(/entities_name_key/);

    const it1 = item(alice, "i1");
    const chengdu = query(`select id from entities where user_id = '${alice}' and name = '成都'`);
    query(`insert into item_entities (item_id, entity_id, user_id) values ('${it1}', '${sanya}', '${alice}'), ('${it1}', '${chengdu}', '${alice}')`);
    query(`insert into entity_edges (item_id, src_id, dst_id, relation, user_id) values ('${it1}', '${sanya}', '${chengdu}', 'related', '${alice}')`);
    // alice 的「三亚攻略」没有内容指着：清掉；bob 的不动
    expect(query(`select prune_orphan_entities('${alice}')`)).toBe("1");
    query(`delete from items where id = '${it1}'`);
    expect(query("select count(*) from item_entities")).toBe("0");
    expect(query("select count(*) from entity_edges")).toBe("0");
    expect(query(`select prune_orphan_entities('${alice}')`)).toBe("2");
    expect(query("select count(*) from entities")).toBe("1");
  });
});
