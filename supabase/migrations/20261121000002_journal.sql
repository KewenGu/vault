-- 日记本（2026-11-21）。
--
-- journal_entries：一行一篇日记。day 是这一篇写的是哪一天（写的人当地的日期，客户端给——服务器不知道他在哪个时区）；
-- 一天可以有多篇。doc 是这一页的内容（lib/vault/journal-doc.ts 的 JournalDoc）：
--   blocks  正文层：文字、照片、录音，一块接一块往下排；
--   decos / strokes  手帐层：贴纸、胶带、艺术字 / 手绘的笔画，各自挂在某一块正文上（第二期才有界面，格式先定下）。
-- rev 是自己保存了多少次：保存时带着上次看到的 rev，对不上就是别处改过了，不盖掉（两个设备同时改）。
-- search_text 是搜索用的全部文字（标题、正文、照片说明、录音转出来的文字）。
--
-- journal_media：日记里的文件（照片、录音），一行一个。doc 里的块按 id 指着它。单独一张表而不是塞进 doc：
-- 页面自动保存 doc 和后台转写同时在写，放一起会互相盖掉。transcript 是录音转出来的带时间的文字（和 items.transcript 同一种写法）。
-- status：uploading 等浏览器把文件传上来 → processing 后台在转文字 → ready；failed = 没成（error 里是原因）。
-- 没看到的（没识别出说话、只转了前 60 分钟、这台机器没有 ffmpeg…）记在 notes 里，页面上列出来。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- journal_media 的外键带着 user_id：不能把文件挂到别人的日记上。
-- 可以重复执行。

create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  title text not null default '',
  style text not null default 'fresh',           -- 风格：fresh / y2k / kawaii / geek / scenery（lib/vault/journal-doc.ts 的 JOURNAL_STYLES）
  mood text not null default '',
  weather text not null default '',
  doc jsonb not null default '{"v":1,"blocks":[],"decos":[],"strokes":[]}'::jsonb,
  rev integer not null default 0,
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists journal_entries_user_day_idx on journal_entries (user_id, day desc, created_at desc);
create index if not exists journal_entries_search_trgm_idx on journal_entries using gin (search_text extensions.gin_trgm_ops);

create table if not exists journal_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id uuid not null,
  kind text not null check (kind in ('image', 'audio')),
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'ready', 'failed')),
  error text,
  path text not null,                            -- 存储桶里的路径：<用户>/journal/<日记 id>/<文件>
  mime text not null default '',
  bytes bigint not null default 0,
  width integer,
  height integer,
  duration_s numeric(10, 2),
  transcript text,
  notes text[] not null default '{}',
  usage jsonb not null default '{}'::jsonb,      -- 转写用掉的量（计数键 → 数量，见 lib/usage/prices.ts）
  cost_usd numeric(10, 6) not null default 0,
  started_at timestamptz not null default now(), -- 这一轮处理开始的时间（页面按它判断卡没卡住）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (entry_id, user_id) references journal_entries (id, user_id) on delete cascade
);
create index if not exists journal_media_entry_idx on journal_media (entry_id);
create index if not exists journal_media_user_idx on journal_media (user_id);

alter table journal_entries enable row level security;
alter table journal_media enable row level security;
drop policy if exists "own rows" on journal_entries;
create policy "own rows" on journal_entries for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own rows" on journal_media;
create policy "own rows" on journal_media for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on journal_entries, journal_media to authenticated;
grant all on journal_entries, journal_media to service_role;

drop trigger if exists journal_entries_touch on journal_entries;
create trigger journal_entries_touch before update on journal_entries for each row execute function touch_updated_at();
drop trigger if exists journal_media_touch on journal_media;
create trigger journal_media_touch before update on journal_media for each row execute function touch_updated_at();
