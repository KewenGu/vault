/**
 * Vault 的分类体系（单一来源：提示词、解析、页面筛选、数据库里存的值都从这里来）。
 *
 * 三个互相独立的维度：
 * - 内容类型（contentType）：这条内容「是什么东西」——食谱、地点、商品、教程…… 决定详情页的卡片上提取哪些字段。
 * - 领域（category）：这条内容「关于什么」——美食、旅行、科技…… 用来做目录的大类。
 * - 标签（tags）：自由的细粒度主题，由模型提、用户可以改；提的时候会给模型看这个人已有的标签，尽量复用。
 *
 * 键（英文）存进库里，标签（中文）只在页面和提示词里用：以后做别的语言只需要换一张标签表。
 */

export const CONTENT_TYPES = [
  "recipe",
  "place",
  "travel",
  "product",
  "review",
  "tutorial",
  "knowledge",
  "opinion",
  "news",
  "tool",
  "inspiration",
  "entertainment",
  "event",
  "document",
  "other",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** label 页面上叫什么；hint 给模型看的判断标准；fields 这类内容的卡片上建议提取的字段（有就写，没有不编） */
export const CONTENT_TYPE_INFO: Record<ContentType, { label: string; hint: string; fields: string[] }> = {
  recipe: { label: "食谱", hint: "一道菜 / 饮品怎么做", fields: ["菜名", "食材", "步骤", "用时", "份量", "关键技巧"] },
  place: { label: "地点", hint: "一家店、餐厅、景点、酒店等具体去处", fields: ["名称", "类型", "城市", "地址", "营业时间", "人均 / 价格", "推荐", "避雷"] },
  travel: { label: "攻略", hint: "一趟行程、一个目的地的玩法（涉及多个地点）", fields: ["目的地", "天数", "行程", "交通", "住宿", "预算", "注意事项"] },
  product: { label: "商品", hint: "一件具体能买的东西（商品页、种草、开箱）", fields: ["名称", "品牌", "价格", "规格", "购买渠道", "亮点", "缺点"] },
  review: { label: "测评", hint: "多件东西的对比、横评、榜单", fields: ["对比对象", "结论", "各项表现", "推荐人群"] },
  tutorial: { label: "教程", hint: "一步步教你做成一件事（软件操作、手工、健身动作、技能）", fields: ["目标", "准备", "步骤", "工具", "常见错误"] },
  knowledge: { label: "知识", hint: "讲清一个概念、原理、事实、方法论", fields: ["主题", "核心结论", "依据", "适用范围"] },
  opinion: { label: "观点", hint: "作者的看法、评论、经验之谈", fields: ["核心观点", "论据", "反方 / 局限"] },
  news: { label: "资讯", hint: "新近发生的事、发布、公告", fields: ["事件", "时间", "相关方", "影响"] },
  tool: { label: "工具", hint: "软件、网站、模板、资源合集", fields: ["名称", "用途", "网址", "价格", "平台", "替代品"] },
  inspiration: { label: "灵感", hint: "主要看画面和感觉的参考：穿搭、家居、设计、摄影、妆容", fields: ["风格", "元素", "配色", "单品 / 物料", "场景"] },
  entertainment: { label: "娱乐", hint: "看个乐：搞笑、剧情、音乐、影视片段、游戏、八卦", fields: ["作品 / 出处", "看点"] },
  event: { label: "活动", hint: "有具体时间地点、可以去参加的事（展览、演出、讲座、促销）", fields: ["名称", "时间", "地点", "票价 / 门槛", "报名方式", "截止日期"] },
  document: { label: "记录", hint: "自己的资料：聊天记录、票据、订单、证件、会议记录、备忘", fields: ["类型", "日期", "相关方", "金额", "编号", "要点"] },
  other: { label: "其他", hint: "以上都不是", fields: [] },
};

export const CATEGORIES = [
  "food",
  "travel",
  "shopping",
  "tech",
  "business",
  "finance",
  "learning",
  "health",
  "home",
  "style",
  "entertainment",
  "design",
  "family",
  "society",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  food: "美食",
  travel: "旅行",
  shopping: "购物",
  tech: "科技",
  business: "职场与商业",
  finance: "理财",
  learning: "学习",
  health: "健康与健身",
  home: "家居与生活",
  style: "时尚与美妆",
  entertainment: "娱乐",
  design: "艺术与设计",
  family: "亲子与家庭",
  society: "社会与时事",
  other: "其他",
};

/** 知识图谱的节点类型 */
export const ENTITY_TYPES = ["person", "org", "place", "product", "work", "concept", "event"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_INFO: Record<EntityType, { label: string; hint: string }> = {
  person: { label: "人物", hint: "真实的人（作者、博主、公众人物）" },
  org: { label: "机构", hint: "公司、品牌、店、学校、组织" },
  place: { label: "地方", hint: "国家、城市、街区、景点、具体场所" },
  product: { label: "产品", hint: "具体的商品、型号、App、软件、菜品" },
  work: { label: "作品", hint: "书、电影、剧、歌、游戏、课程、节目" },
  concept: { label: "概念", hint: "方法、技术、理论、风格、话题" },
  event: { label: "事件", hint: "有时间的事：发布会、比赛、展览、新闻事件" },
};

/** 节点之间的关系。related 是兜底；其余是有方向的（from → to）。 */
export const RELATIONS = ["related", "part_of", "located_in", "made_by", "about"] as const;
export type Relation = (typeof RELATIONS)[number];

export const RELATION_INFO: Record<Relation, { label: string; hint: string }> = {
  related: { label: "相关", hint: "有关系但不属于下面几种" },
  part_of: { label: "属于", hint: "A 是 B 的一部分 / 一种（「低温慢煮」属于「烹饪方法」）" },
  located_in: { label: "位于", hint: "A 在 B 这个地方（「某餐厅」位于「三亚」）" },
  made_by: { label: "出自", hint: "A 由 B 制作 / 出品 / 创作（「iPhone」出自「Apple」）" },
  about: { label: "关于", hint: "A（作品 / 事件）讲的是 B" },
};

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => list.find((x) => x === (typeof v === "string" ? v.trim().toLowerCase() : v)) ?? fallback;

export const toContentType = (v: unknown): ContentType => pick(CONTENT_TYPES, v, "other");
export const toCategory = (v: unknown): Category => pick(CATEGORIES, v, "other");
export const toEntityType = (v: unknown): EntityType | null => ENTITY_TYPES.find((x) => x === (typeof v === "string" ? v.trim().toLowerCase() : v)) ?? null;
export const toRelation = (v: unknown): Relation => pick(RELATIONS, v, "related");

/** 标签整理：去掉 #、首尾空白，中间的空白压成一个空格，最多 24 个字；空的丢掉。 */
export function cleanTag(raw: string): string {
  return Array.from(raw.replace(/^#+/, "").replace(/\s+/g, " ").trim()).slice(0, 24).join("");
}

/** 一组标签去重（不分大小写，留第一次出现的写法），最多 max 个。 */
export function cleanTags(raw: string[], max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = cleanTag(r);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** 用户在输入框里写的标签（逗号、顿号、空格、换行分隔都认）。 */
export function parseTagInput(input: string): string[] {
  return cleanTags(input.split(/[,，、;；\n]+|\s{2,}/).flatMap((t) => (t.includes("#") ? t.split(/\s+/) : [t])));
}
