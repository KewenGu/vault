-- 日记本的「我的贴纸」（2026-11-22）：自己传的图片，贴在哪一篇日记上都行。
--
-- 一行一张。文件在存储桶里：<用户>/journal-stickers/<id>.webp（传上来的原件处理成不超过 512 像素、保留透明底的 WebP）。
-- 日记里贴着的那一件（doc.decos 里 kind = mine）按 id 指着这里；这里删了，日记上那一件就画不出来了。
-- status：uploading 等浏览器把文件传上来 → ready。
--
-- 和别的表一样按用户隔离：user_id + 行级安全只放行自己的行，后台用 service_role 时代码里自己带 user_id。
-- 可以重复执行。

create table if not exists journal_stickers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'uploading' check (status in ('uploading', 'ready')),
  path text not null,
  width integer,
  height integer,
  bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists journal_stickers_user_idx on journal_stickers (user_id, created_at desc);

alter table journal_stickers enable row level security;
drop policy if exists "own rows" on journal_stickers;
create policy "own rows" on journal_stickers for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on journal_stickers to authenticated;
grant all on journal_stickers to service_role;

drop trigger if exists journal_stickers_touch on journal_stickers;
create trigger journal_stickers_touch before update on journal_stickers for each row execute function touch_updated_at();
