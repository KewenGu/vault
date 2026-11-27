-- 手动整理知识图谱（实体页用）：
--   merge_entities      把一个实体并进另一个——模型没认出是同一个的（「芒格」和「查理·芒格」）；
--   move_entity_links   把几条内容从一个实体移到另一个——模型并错了的，拆开。
--
-- 都是几步要一起成、一起不成的改动（关联、关系、别名、删掉空了的那个），所以写成数据库函数，一次调用在一个事务里做完。
-- 没有 security definer：以调用的人的身份跑，行级安全照常拦着；函数里再带一遍 user_id（后台用 service_role 调时只靠这个）。
-- 可以重复执行。

-- 把 p_from 的关联和关系改挂到 p_into 上。p_item_ids 给了就只动这几条内容上的，不给是全部。返回动了几条关联。
-- 两个实体都得是这个人的；p_from 自己不删（移走一部分时它还在；全并过去时由 merge_entities 删）。
create or replace function move_entity_links(p_user_id uuid, p_from uuid, p_into uuid, p_item_ids uuid[] default null) returns int
language plpgsql
set search_path = ''
as $$
declare
  moved int := 0;
  n int;
begin
  if p_from = p_into then
    return 0;
  end if;
  if (select count(*) from public.entities e where e.user_id = p_user_id and e.id in (p_from, p_into)) <> 2 then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;

  -- 内容和实体的关联（主键是 内容 + 实体）：这条内容已经连着目标的，旧的那行删掉；其余改指向目标
  delete from public.item_entities ie
  where ie.user_id = p_user_id and ie.entity_id = p_from
    and (p_item_ids is null or ie.item_id = any (p_item_ids))
    and exists (select 1 from public.item_entities x where x.item_id = ie.item_id and x.entity_id = p_into);
  get diagnostics n = row_count;
  moved := moved + n;
  update public.item_entities ie set entity_id = p_into
  where ie.user_id = p_user_id and ie.entity_id = p_from
    and (p_item_ids is null or ie.item_id = any (p_item_ids));
  get diagnostics n = row_count;
  moved := moved + n;

  -- 关系（一行 = 某条内容里说的一个关系）：两头分别改。改了会变成自己连自己的、会和目标已有的那行重复的，删掉
  delete from public.entity_edges e
  where e.user_id = p_user_id and e.src_id = p_from
    and (p_item_ids is null or e.item_id = any (p_item_ids))
    and (e.dst_id = p_into or exists (
      select 1 from public.entity_edges x
      where x.item_id = e.item_id and x.src_id = p_into and x.dst_id = e.dst_id and x.relation = e.relation));
  update public.entity_edges e set src_id = p_into
  where e.user_id = p_user_id and e.src_id = p_from
    and (p_item_ids is null or e.item_id = any (p_item_ids));

  delete from public.entity_edges e
  where e.user_id = p_user_id and e.dst_id = p_from
    and (p_item_ids is null or e.item_id = any (p_item_ids))
    and (e.src_id = p_into or exists (
      select 1 from public.entity_edges x
      where x.item_id = e.item_id and x.dst_id = p_into and x.src_id = e.src_id and x.relation = e.relation));
  update public.entity_edges e set dst_id = p_into
  where e.user_id = p_user_id and e.dst_id = p_from
    and (p_item_ids is null or e.item_id = any (p_item_ids));

  return moved;
end;
$$;

-- 把 p_from 整个并进 p_into：关联和关系都挂过去，p_from 的名字和别名记成 p_into 的别名（以后的内容再提到这个叫法，直接认到 p_into），
-- p_into 没有说明的用 p_from 的，最后删掉 p_from。返回动了几条关联。
create or replace function merge_entities(p_user_id uuid, p_from uuid, p_into uuid) returns int
language plpgsql
set search_path = ''
as $$
declare
  moved int;
begin
  if p_from = p_into then
    raise exception 'cannot merge an entity into itself' using errcode = '22023';
  end if;
  moved := public.move_entity_links(p_user_id, p_from, p_into, null);

  update public.entities t
  set aliases = t.aliases || array(
        select u.a
        from unnest(array[f.name] || f.aliases) with ordinality as u(a, i)
        where lower(u.a) <> lower(t.name)
          and not exists (select 1 from unnest(t.aliases) as had(a) where lower(had.a) = lower(u.a))
        order by u.i),
      summary = case when t.summary = '' then f.summary else t.summary end
  from public.entities f
  where t.id = p_into and t.user_id = p_user_id and f.id = p_from and f.user_id = p_user_id;

  delete from public.entities e where e.id = p_from and e.user_id = p_user_id;
  return moved;
end;
$$;

revoke all on function move_entity_links, merge_entities from public, anon;
grant execute on function move_entity_links, merge_entities to authenticated, service_role;
