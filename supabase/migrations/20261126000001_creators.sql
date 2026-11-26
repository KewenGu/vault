-- 博主（2026-11-26）：把一个账号发过的作品整个存下来。
--
-- creators：收藏的一个账号（X / TikTok / 抖音），一个人同一个账号只有一行。
--   external_id：X、TikTok 是小写的用户名，抖音是 sec_uid（见 lib/sources/link.ts 的 AccountRef）。
--   status：listing 后台在列他的作品 → saving 在一条一条存 → ready（存完了，或者停下了）；failed = 这一轮没列成（error 里是原因）。
--   want：这一轮要列最近的多少条。notes：没列到的、没要的（转发、列到一半读不动…），页面上列出来。
--   usage / cost_usd：历次列作品用掉的量（每条作品自己的花费记在 items 上）。
--   started_at：这一轮开始的时间（后台任务按它认是不是自己这一轮；页面按 updated_at 判断卡没卡住）。
--
-- creator_posts：列出来的每一条作品，一行一条。
--   status：pending 排着队等存 → saved 已经是收藏库里的一条内容（item_id 指着它；内容后来被删了 item_id 变空）；
--           held 列出来了但没存（用户中途停下了）。
--   这一行的 id 就是存进收藏库时那条内容的 id：后台任务建到一半断了再来，认得出那条是不是自己建的。
--
-- 每条作品还是 items 里普通的一条内容，搜索、图谱、导图照常；这两张表只记「哪个账号、列出了哪些、存到哪了」。
-- 单独的表而不是 items 上加列：应用更新了、这个迁移还没推到 Supabase 时，只有「博主」用不了，别的页面照常。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- 外键带着 user_id：不能把作品挂到别人的账号上，也不能指着别人的内容。
-- 可以重复执行。

create unique index if not exists items_id_user_idx on items (id, user_id);

create table if not exists creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  platform text not null,
  external_id text not null,
  url text not null,
  handle text not null default '',
  name text not null default '',
  bio text not null default '',
  post_count integer,                            -- 平台说的作品总数（没给是空）
  status text not null default 'listing' check (status in ('listing', 'saving', 'ready', 'failed')),
  error text,
  want integer not null default 0,
  notes jsonb not null default '[]'::jsonb,      -- 一句句话
  usage jsonb not null default '{}'::jsonb,      -- 计数键 → 数量，见 lib/usage/prices.ts
  cost_usd numeric(10, 6) not null default 0,
  started_at timestamptz not null default now(),
  synced_at timestamptz,                         -- 最近一次把作品列完的时间
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists creators_account_key on creators (user_id, platform, external_id);
create unique index if not exists creators_id_user_idx on creators (id, user_id);

create table if not exists creator_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  creator_id uuid not null,
  external_id text not null,
  url text not null,
  kind text,
  title text not null default '',
  published_at timestamptz,
  pinned boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'saved', 'held')),
  item_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (creator_id, user_id) references creators (id, user_id) on delete cascade,
  foreign key (item_id, user_id) references items (id, user_id) on delete set null (item_id)
);
create unique index if not exists creator_posts_post_key on creator_posts (creator_id, external_id);
create index if not exists creator_posts_queue_idx on creator_posts (creator_id, status, published_at desc nulls last);
create index if not exists creator_posts_item_idx on creator_posts (item_id) where item_id is not null;
create index if not exists creator_posts_user_idx on creator_posts (user_id);

alter table creators enable row level security;
drop policy if exists "own rows" on creators;
create policy "own rows" on creators for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter table creator_posts enable row level security;
drop policy if exists "own rows" on creator_posts;
create policy "own rows" on creator_posts for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on creators, creator_posts to authenticated;
grant all on creators, creator_posts to service_role;

drop trigger if exists creators_touch on creators;
create trigger creators_touch before update on creators for each row execute function touch_updated_at();
drop trigger if exists creator_posts_touch on creator_posts;
create trigger creator_posts_touch before update on creator_posts for each row execute function touch_updated_at();
