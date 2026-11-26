-- 「问 Vault」（2026-11-26）：对着收藏库提问，回答带出处。
--
-- 一行是一次提问和它后面的追问：title 是第一个问题，chat 是一问一答（回答里带着它引用了哪几条收藏、这次没看到什么，
-- 见 lib/vault/ask-store.ts 的 AskMessage）。sources 是这些回答引用过的收藏（追问时带上它们的整理结果）；
-- 内容删了不清这里的 id，读的时候按「还在的」过滤。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- 可以重复执行。

create table if not exists asks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  chat jsonb not null default '[]'::jsonb,       -- 一问一答（lib/vault/ask-store.ts 的 AskMessage）
  sources uuid[] not null default '{}',          -- 回答引用过的收藏（items.id）
  usage jsonb not null default '{}'::jsonb,      -- 用掉的量（计数键 → 数量，见 lib/usage/prices.ts）
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists asks_user_updated_idx on asks (user_id, updated_at desc);

alter table asks enable row level security;
drop policy if exists "own rows" on asks;
create policy "own rows" on asks for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on asks to authenticated;
grant all on asks to service_role;

drop trigger if exists asks_touch on asks;
create trigger asks_touch before update on asks for each row execute function touch_updated_at();
