-- 划线和批注（2026-11-26）：用户在一条收藏的内容上自己留下的东西。
--
-- 一行是一条笔记，挂在一条内容上：quote 是划下来的那段原话（没有划线、只写了想法的是空），body 是他自己写的话
-- （只划线、没写的是空），两样至少有一样。at 是划的那段话在视频 / 音频里的时间（秒），不是从带时间的地方划的是空。
-- 和 items.note（存的时候写的「为什么存」，一条内容一句）是两回事：这里一条内容可以有很多条，是读的过程中留下的。
--
-- 单独一张表而不是 items 上加一列：应用更新了、这个迁移还没推到 Supabase 时，只有笔记用不了，别的页面照常。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- 外键带着 user_id：不能在别人的内容上写笔记。内容删了，它上面的笔记跟着删。
-- 可以重复执行。

create unique index if not exists items_id_user_idx on items (id, user_id);

create table if not exists item_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id uuid not null,
  quote text not null default '',
  body text not null default '',
  at numeric(10, 2),
  -- 「笔记」页按字面搜用：划的话和写的话拼在一起，数据库自己维护
  search_text text generated always as (quote || E'\n' || body) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (item_id, user_id) references items (id, user_id) on delete cascade,
  constraint item_notes_not_empty check (quote <> '' or body <> '')
);
create index if not exists item_notes_item_idx on item_notes (item_id, created_at);
create index if not exists item_notes_user_created_idx on item_notes (user_id, created_at desc);
create index if not exists item_notes_search_trgm_idx on item_notes using gin (search_text extensions.gin_trgm_ops);

alter table item_notes enable row level security;
drop policy if exists "own rows" on item_notes;
create policy "own rows" on item_notes for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on item_notes to authenticated;
grant all on item_notes to service_role;

drop trigger if exists item_notes_touch on item_notes;
create trigger item_notes_touch before update on item_notes for each row execute function touch_updated_at();
