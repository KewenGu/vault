-- 情报（2026-11-24）：盯几个来源，有新的热门内容就列出来，挑着存进收藏库。
--
-- intel_watches 一行是「盯着的一个来源」：Reddit 的一个版块（kind = subreddit，query 是版块名），
-- 或者 Hacker News 上的一组关键词（kind = hn，query 是关键词）。min_score 是多少分以上才算（Reddit 的赞数 / HN 的分数）；
-- keywords 是版块里再按词筛（空格隔开，标题或正文开头带任意一个才要；空 = 全要）。
-- last_checked_at / last_error / last_notes 是上一次去看的结果：notes 是「没看到」的（帖子太多只看了最近多少小时…）。
--
-- intel_signals 一行是发现的一条内容：只有标题、链接、一小段开头和几个数字，不下载、不交给模型。
-- status：new 新的 / saved 存进收藏库了（item_id 指着那条） / dismissed 不要。同一条内容一个人只有一行
-- （两个来源都碰到它，算先碰到的那个的）。来源删了，它发现的跟着删；存进去的那条内容删了，item_id 清空。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台定时去看时用 service_role、代码里自己带 user_id。
-- 可以重复执行。

create table if not exists intel_watches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('subreddit', 'hn')),
  query text not null,
  keywords text not null default '',
  min_score integer not null default 50 check (min_score >= 0),
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_error text,
  last_notes jsonb not null default '[]'::jsonb,   -- 上次没看到的（字符串数组）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists intel_watches_once_idx on intel_watches (user_id, kind, lower(query));
create index if not exists intel_watches_due_idx on intel_watches (last_checked_at nulls first) where enabled;

create table if not exists intel_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  watch_id uuid not null references intel_watches(id) on delete cascade,
  source text not null check (source in ('reddit', 'hackernews')),
  external_id text not null,                      -- Reddit 的帖子 id / HN 的条目 id
  url text not null,                              -- 存入时用的链接：Reddit 是帖子，HN 是它指向的文章（没有就是讨论页）
  discussion_url text,                            -- HN 的讨论页
  title text not null,
  excerpt text not null default '',
  author text,
  channel text,                                   -- 「r/LocalLLaMA」「Hacker News」
  score integer,
  comments integer,
  published_at timestamptz,
  status text not null default 'new' check (status in ('new', 'saved', 'dismissed')),
  item_id uuid references items(id) on delete set null,
  found_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, external_id)
);
create index if not exists intel_signals_list_idx on intel_signals (user_id, status, published_at desc);
create index if not exists intel_signals_watch_idx on intel_signals (watch_id);

alter table intel_watches enable row level security;
drop policy if exists "own rows" on intel_watches;
create policy "own rows" on intel_watches for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 发现的内容还得挂在自己的来源上、指着自己的内容：不能把一行塞到别人的来源下面，也不能指到别人存的东西上
alter table intel_signals enable row level security;
drop policy if exists "own rows" on intel_signals;
create policy "own rows" on intel_signals for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from intel_watches w where w.id = watch_id and w.user_id = (select auth.uid()))
    and (item_id is null or exists (select 1 from items i where i.id = item_id and i.user_id = (select auth.uid())))
  );

grant select, insert, update, delete on intel_watches, intel_signals to authenticated;
grant all on intel_watches, intel_signals to service_role;

drop trigger if exists intel_watches_touch on intel_watches;
create trigger intel_watches_touch before update on intel_watches for each row execute function touch_updated_at();
drop trigger if exists intel_signals_touch on intel_signals;
create trigger intel_signals_touch before update on intel_signals for each row execute function touch_updated_at();
