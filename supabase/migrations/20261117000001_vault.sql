-- Vault 第一版（2026-11-17）：个人收藏库。
--
-- 存什么：用户存进来的任何内容（链接、上传的图片 / 截图 / 音频 / 视频、贴的文字），一行一条（items）；
-- 从内容里读出来的实体（entities）、内容和实体的关联（item_entities）、实体之间的关系（entity_edges）——
-- 三张表合起来是这个人的知识图谱，每存一条增量并入，不是整批重建。
--
-- 多用户：每张表都有 user_id，行级安全只放行自己的行。后台任务用 service_role（绕过行级安全），
-- 代码里每次查询自己带 user_id / item id。
--
-- 文件：转存的图片 / 视频 / 抽的帧在私有存储桶 vault 的 <user_id>/<item_id>/ 下，表里只存路径。
-- 可以重复执行。

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------- items

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null check (source in ('link', 'upload', 'text')),
  -- 去重键（同一个人同一条内容只有一行）：link = <平台>:<帖子 id>；upload = file:<sha256>；text = text:<sha256>
  dedupe_key text not null,
  platform text,                                 -- 链接的平台：xiaohongshu / douyin / tiktok / instagram / youtube / x / web
  external_id text,                              -- 平台上的帖子 id（网页是整理过的地址的哈希）
  url text,                                      -- 抓取用的链接（小红书的带访问口令）
  -- uploading 等浏览器把文件传上来 → fetching 读链接、转存文件 → analyzing 抽帧、转写、理解、建索引 → ready；任何一步失败 = failed
  status text not null default 'fetching' check (status in ('uploading', 'fetching', 'analyzing', 'ready', 'failed')),
  error text,
  kind text,                                     -- image / video / audio / text / article；读到内容之前为空
  title text,
  author text,
  post jsonb,                                    -- 帖子快照：正文、互动数、话题、高赞评论、发布时间…（lib/sources/types.ts 的 PostSnapshot）
  media jsonb not null default '[]'::jsonb,      -- 转存的文件：[{ role, path, mime, width, height, bytes, at… }]
  transcript text,                               -- 视频 / 音频里说的话（带时间）
  user_text text,                                -- 用户自己贴的文字（文字内容本身，或链接读不到时补贴的）
  understanding jsonb,                           -- 理解结果（lib/vault/understand.ts 的 understandingSchema）
  -- 下面几列是从 understanding 里抄出来的，给列表、筛选、搜索用
  summary text,
  content_type text,                             -- 内容类型：recipe / place / product…（lib/vault/taxonomy.ts）
  category text,                                 -- 领域：food / travel / tech…
  tags text[] not null default '{}',
  tags_locked boolean not null default false,    -- 用户改过标签：重新分析时不再覆盖
  note text,                                     -- 用户的备注（为什么存）
  search_text text,                              -- 搜索用的全部文字（标题、概括、要点、标签、正文、口播、图里的字、备注、实体）
  embedding extensions.vector(1024),             -- voyage-3.5-lite，语义搜索用
  usage jsonb not null default '{}'::jsonb,      -- 处理这条用掉的量（计数键 → 数量，见 lib/usage/prices.ts）
  cost_usd numeric(10, 6) not null default 0,
  started_at timestamptz not null default now(), -- 这一轮处理开始的时间（页面按它判断卡没卡住）
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists items_dedupe_key on items (user_id, dedupe_key);
create index if not exists items_user_created_idx on items (user_id, created_at desc);
create index if not exists items_tags_idx on items using gin (tags);
create index if not exists items_search_trgm_idx on items using gin (search_text extensions.gin_trgm_ops);
create index if not exists items_embedding_idx on items using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------- 知识图谱

create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,                            -- person / org / place / product / work / concept / event
  name text not null,                            -- 规范名称
  aliases text[] not null default '{}',          -- 并进来的别的叫法
  summary text not null default '',
  embedding extensions.vector(1024),             -- 名称 + 说明的向量：新实体进来时找「是不是已经有了」
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists entities_name_key on entities (user_id, type, lower(name));
create index if not exists entities_user_idx on entities (user_id);
create index if not exists entities_embedding_idx on entities using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists item_entities (
  item_id uuid not null references items(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  about text not null default '',                -- 这个实体在这条内容里是什么角色
  primary key (item_id, entity_id)
);
create index if not exists item_entities_entity_idx on item_entities (entity_id);
create index if not exists item_entities_user_idx on item_entities (user_id);

-- 一行 = 某条内容里说的一个关系（证据就是那条内容）。同一对实体被几条内容说到就有几行，画图时合并、按条数算粗细。
create table if not exists entity_edges (
  item_id uuid not null references items(id) on delete cascade,
  src_id uuid not null references entities(id) on delete cascade,
  dst_id uuid not null references entities(id) on delete cascade,
  relation text not null,                        -- related / part_of / located_in / made_by / about
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (item_id, src_id, dst_id, relation)
);
create index if not exists entity_edges_user_idx on entity_edges (user_id);
create index if not exists entity_edges_src_idx on entity_edges (src_id);
create index if not exists entity_edges_dst_idx on entity_edges (dst_id);

-- ---------------------------------------------------------------- 行级安全

alter table items enable row level security;
alter table entities enable row level security;
alter table item_entities enable row level security;
alter table entity_edges enable row level security;

drop policy if exists "own rows" on items;
create policy "own rows" on items for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own rows" on entities;
create policy "own rows" on entities for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own rows" on item_entities;
create policy "own rows" on item_entities for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own rows" on entity_edges;
create policy "own rows" on entity_edges for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on items, entities, item_entities, entity_edges to authenticated;
grant all on items, entities, item_entities, entity_edges to service_role;

-- ---------------------------------------------------------------- 函数

create or replace function touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists items_touch on items;
create trigger items_touch before update on items for each row execute function touch_updated_at();
drop trigger if exists entities_touch on entities;
create trigger entities_touch before update on entities for each row execute function touch_updated_at();

-- 搜索：关键词（每个词在标题 / 标签 / 概括 / 全文里出没出现）和语义（向量余弦）各排一个名次，用倒数名次融合（RRF）。
-- 关键词用 ilike 而不是全文检索：Postgres 自带的分词不认中文；个人库的量级（几千到几万条）顺序扫描够快，
-- 三个字以上的词还能用上 trigram 索引。p_terms 为空 = 只按语义；p_embedding 为空 = 只按关键词；都为空 = 按时间列出。
-- security invoker：登录用户直接调时行级安全照常生效；后台用 service_role 调时由 p_user_id 限定。
create or replace function search_items(
  p_user_id uuid,
  p_terms text[] default '{}',
  p_embedding extensions.vector(1024) default null,
  p_min_similarity float default 0.35,
  p_kind text default null,
  p_content_type text default null,
  p_category text default null,
  p_tag text default null,
  p_platform text default null,
  p_source text default null,
  p_entity_id uuid default null,
  p_limit int default 60
) returns table (id uuid, keyword_hits int, similarity float, score float)
language sql stable
set search_path = ''
as $$
  with base as (
    select i.id, i.title, i.summary, i.tags, i.search_text, i.embedding, i.created_at
    from public.items i
    where i.user_id = p_user_id
      and i.status <> 'uploading'
      and (p_kind is null or i.kind = p_kind)
      and (p_content_type is null or i.content_type = p_content_type)
      and (p_category is null or i.category = p_category)
      and (p_tag is null or p_tag = any (i.tags))
      and (p_platform is null or i.platform = p_platform)
      and (p_source is null or i.source = p_source)
      and (p_entity_id is null or exists (select 1 from public.item_entities ie where ie.item_id = i.id and ie.entity_id = p_entity_id))
  ),
  kw as (
    select b.id,
      (select count(*) from unnest(p_terms) t where b.search_text ilike '%' || t || '%')::int as hits,
      (select coalesce(sum(
          case when b.title ilike '%' || t || '%' then 4 else 0 end
        + case when exists (select 1 from unnest(b.tags) tg where tg ilike '%' || t || '%') then 3 else 0 end
        + case when b.summary ilike '%' || t || '%' then 2 else 0 end
        + case when b.search_text ilike '%' || t || '%' then 1 else 0 end), 0)
       from unnest(p_terms) t)::float as weight
    from base b
    where cardinality(p_terms) > 0
  ),
  kw_ranked as (
    select k.id, k.hits, row_number() over (order by k.hits desc, k.weight desc) as rnk
    from kw k where k.hits > 0
  ),
  sem as (
    select b.id, 1 - (b.embedding operator(extensions.<=>) p_embedding) as sim
    from base b
    where p_embedding is not null and b.embedding is not null
  ),
  sem_ranked as (
    select s.id, s.sim, row_number() over (order by s.sim desc) as rnk
    from sem s where s.sim >= p_min_similarity
  )
  select b.id,
         coalesce(k.hits, 0) as keyword_hits,
         s.sim as similarity,
         coalesce(1.0 / (60 + k.rnk), 0) + coalesce(1.0 / (60 + s.rnk), 0) as score
  from base b
  left join kw_ranked k on k.id = b.id
  left join sem_ranked s on s.id = b.id
  where (cardinality(p_terms) = 0 and p_embedding is null) or k.id is not null or s.id is not null
  order by score desc, b.created_at desc
  limit greatest(1, least(p_limit, 200));
$$;

-- 找「是不是已经有这个实体」：同类型里向量最近的几个。
create or replace function match_entities(
  p_user_id uuid,
  p_type text,
  p_embedding extensions.vector(1024),
  p_count int default 5
) returns table (id uuid, name text, aliases text[], summary text, similarity float)
language sql stable
set search_path = ''
as $$
  select e.id, e.name, e.aliases, e.summary, 1 - (e.embedding operator(extensions.<=>) p_embedding) as similarity
  from public.entities e
  where e.user_id = p_user_id and e.type = p_type and e.embedding is not null
  order by e.embedding operator(extensions.<=>) p_embedding
  limit p_count;
$$;

-- 没有任何内容指着的实体删掉（删了内容、重新分析之后调）。返回删了几个。
create or replace function prune_orphan_entities(p_user_id uuid) returns int
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.entities e
    where e.user_id = p_user_id
      and not exists (select 1 from public.item_entities ie where ie.entity_id = e.id)
    returning 1
  )
  select count(*)::int from gone;
$$;

-- 这个人用过的标签和各自的条数（目录页的标签栏、提标签时给模型参考）。
create or replace function tag_counts(p_user_id uuid) returns table (tag text, n int)
language sql stable
set search_path = ''
as $$
  select t.tag, count(*)::int as n
  from public.items i, unnest(i.tags) as t(tag)
  where i.user_id = p_user_id
  group by t.tag
  order by n desc, t.tag;
$$;

revoke all on function search_items, match_entities, prune_orphan_entities, tag_counts from public, anon;
grant execute on function search_items, match_entities, tag_counts to authenticated, service_role;
grant execute on function prune_orphan_entities to service_role;

-- ---------------------------------------------------------------- 存储桶

-- 私有桶：页面通过 /media/<item>/<file> 拿短时效的签名地址；上传用服务端发的签名上传地址。单文件上限 50 MB（免费档的上限）。
insert into storage.buckets (id, name, public, file_size_limit)
values ('vault', 'vault', false, 52428800)
on conflict (id) do nothing;
