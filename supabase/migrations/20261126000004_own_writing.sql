-- 自己写的内容：收藏库里除了存下来的别人的内容，也能放自己写的一个想法、一段笔记。
--
-- 它就是一条普通的内容（items 里的一行，照常理解、归类、进搜索和知识图谱），只是来源（source）多了一种「own」：
-- 整理的时候提示词不一样（不把他自己的话写成「作者认为」、不替他展开），页面上、「问」的材料里都标明是他自己写的。
-- 以前当成「文字」（text）存进来的，也可以在详情页上改标成自己写的（source 在 text 和 own 之间换）。
--
-- 没有新表、新列：只是放宽 source 能取的值。可以重复执行。

alter table items drop constraint if exists items_source_check;
alter table items add constraint items_source_check check (source in ('link', 'upload', 'text', 'own'));
