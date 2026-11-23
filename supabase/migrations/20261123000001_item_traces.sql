-- 溯源（2026-11-23）。
--
-- 一条收藏的内容常常是转述别人的东西。用户在详情页点「溯源」时，后台让 Claude 联网去找它引用的东西的第一手出处、
-- 读原文核对（lib/vault/trace.ts），结果存在这里：一条内容一行，重新溯源就换掉。
-- status：running 后台在查 → ready；failed = 这一轮没成（error 里是原因；上一轮的 result 留着）。
-- result 是 lib/vault/trace.ts 的 TraceResult（引用的每一样东西：出处的地址、核对的结论、原话；没查到 / 没读到的在 notes 里）。
-- usage / cost_usd 是这条内容历次溯源累计用掉的量（联网搜索按次另算，见 lib/usage/prices.ts）。
--
-- 单独一张表而不是 items 上加一列：应用更新了、这个迁移还没推到 Supabase 时，只有「溯源」用不了，别的页面照常。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- 外键带着 user_id：不能给别人的内容建一行。内容删了，这一行跟着删。
-- 可以重复执行。

create unique index if not exists items_id_user_idx on items (id, user_id);

create table if not exists item_traces (
  item_id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'ready', 'failed')),
  error text,
  result jsonb,
  usage jsonb not null default '{}'::jsonb,      -- 计数键 → 数量，见 lib/usage/prices.ts
  cost_usd numeric(10, 6) not null default 0,
  started_at timestamptz not null default now(), -- 这一轮开始的时间（页面按它判断卡没卡住；后台任务按它认是不是自己这一轮）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (item_id, user_id) references items (id, user_id) on delete cascade
);
create index if not exists item_traces_user_idx on item_traces (user_id);

alter table item_traces enable row level security;
drop policy if exists "own rows" on item_traces;
create policy "own rows" on item_traces for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on item_traces to authenticated;
grant all on item_traces to service_role;

drop trigger if exists item_traces_touch on item_traces;
create trigger item_traces_touch before update on item_traces for each row execute function touch_updated_at();
