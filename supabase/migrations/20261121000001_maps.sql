-- 自己建的思维导图（2026-11-21）。
--
-- 一行一张图：标题是中心主题，nodes 是按顺序排的一行行节点（和 items.understanding.outline 同一种形状，
-- 多一个出处 item = 收藏库里某条内容的 id）。sources 是这张图挂着的收藏（跟 AI 对话时带上它们的整理结果）；
-- 内容删了不清这里的 id，读的时候按「还在的」过滤。chat 是和 AI 的对话（最近的若干条）。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- 可以重复执行。

create table if not exists maps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  nodes jsonb not null default '[]'::jsonb,      -- [{ depth, text, item }]（lib/vault/map-nodes.ts 的 mapNodeSchema）
  sources uuid[] not null default '{}',          -- 挂着的收藏（items.id）
  chat jsonb not null default '[]'::jsonb,       -- 和 AI 的对话（lib/vault/map-store.ts 的 ChatMessage）
  usage jsonb not null default '{}'::jsonb,      -- 对话用掉的量（计数键 → 数量，见 lib/usage/prices.ts）
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists maps_user_updated_idx on maps (user_id, updated_at desc);

alter table maps enable row level security;
drop policy if exists "own rows" on maps;
create policy "own rows" on maps for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on maps to authenticated;
grant all on maps to service_role;

drop trigger if exists maps_touch on maps;
create trigger maps_touch before update on maps for each row execute function touch_updated_at();
