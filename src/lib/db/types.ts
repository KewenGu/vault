/**
 * 数据库的类型（手写，对着 supabase/migrations 维护；改了表结构这里要跟着改）。
 * jsonb 列在这里都是 Json：读出来按形状收一遍再用（lib/vault/store.ts 的 toItem），不要直接断言。
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type ItemRow = {
  id: string;
  user_id: string;
  source: string;
  dedupe_key: string;
  platform: string | null;
  external_id: string | null;
  url: string | null;
  status: string;
  error: string | null;
  kind: string | null;
  title: string | null;
  author: string | null;
  post: Json | null;
  media: Json;
  transcript: string | null;
  user_text: string | null;
  understanding: Json | null;
  summary: string | null;
  content_type: string | null;
  category: string | null;
  tags: string[];
  tags_locked: boolean;
  note: string | null;
  search_text: string | null;
  /** pgvector 读回来是字符串 "[0.1,0.2,…]"，写进去可以给 number[] 的 JSON 字符串 */
  embedding: string | null;
  usage: Json;
  cost_usd: number;
  started_at: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

type EntityRow = {
  id: string;
  user_id: string;
  type: string;
  name: string;
  aliases: string[];
  summary: string;
  embedding: string | null;
  created_at: string;
  updated_at: string;
};

type ItemEntityRow = { item_id: string; entity_id: string; user_id: string; about: string };
type EntityEdgeRow = { item_id: string; src_id: string; dst_id: string; relation: string; user_id: string };

type ItemTraceRow = {
  item_id: string;
  user_id: string;
  status: string;
  error: string | null;
  result: Json | null;
  usage: Json;
  cost_usd: number;
  started_at: string;
  created_at: string;
  updated_at: string;
};

type MapRow = {
  id: string;
  user_id: string;
  title: string;
  nodes: Json;
  sources: string[];
  chat: Json;
  usage: Json;
  cost_usd: number;
  created_at: string;
  updated_at: string;
};

type JournalEntryRow = {
  id: string;
  user_id: string;
  /** 这一篇写的是哪一天：YYYY-MM-DD（写的人当地的日期） */
  day: string;
  title: string;
  style: string;
  mood: string;
  weather: string;
  doc: Json;
  rev: number;
  search_text: string;
  created_at: string;
  updated_at: string;
};

type JournalMediaRow = {
  id: string;
  user_id: string;
  entry_id: string;
  kind: string;
  status: string;
  error: string | null;
  path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  transcript: string | null;
  notes: string[];
  usage: Json;
  cost_usd: number;
  started_at: string;
  created_at: string;
  updated_at: string;
};

type JournalStickerRow = {
  id: string;
  user_id: string;
  status: string;
  path: string;
  width: number | null;
  height: number | null;
  bytes: number;
  created_at: string;
  updated_at: string;
};

type IntelWatchRow = {
  id: string;
  user_id: string;
  kind: string;
  query: string;
  keywords: string;
  min_score: number;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  last_notes: Json;
  created_at: string;
  updated_at: string;
};

type IntelSignalRow = {
  id: string;
  user_id: string;
  watch_id: string;
  source: string;
  external_id: string;
  url: string;
  discussion_url: string | null;
  title: string;
  excerpt: string;
  author: string | null;
  channel: string | null;
  score: number | null;
  comments: number | null;
  published_at: string | null;
  status: string;
  item_id: string | null;
  found_at: string;
  updated_at: string;
};

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      items: Table<ItemRow, "user_id" | "source" | "dedupe_key">;
      entities: Table<EntityRow, "user_id" | "type" | "name">;
      item_entities: Table<ItemEntityRow, "item_id" | "entity_id" | "user_id">;
      entity_edges: Table<EntityEdgeRow, "item_id" | "src_id" | "dst_id" | "relation" | "user_id">;
      item_traces: Table<ItemTraceRow, "item_id" | "user_id">;
      maps: Table<MapRow, "user_id">;
      journal_entries: Table<JournalEntryRow, "user_id" | "day">;
      journal_media: Table<JournalMediaRow, "user_id" | "entry_id" | "kind" | "path">;
      journal_stickers: Table<JournalStickerRow, "user_id" | "path">;
      intel_watches: Table<IntelWatchRow, "user_id" | "kind" | "query">;
      intel_signals: Table<IntelSignalRow, "user_id" | "watch_id" | "source" | "external_id" | "url" | "title">;
    };
    Views: { [_ in never]: never };
    Functions: {
      search_items: {
        Args: {
          p_user_id: string;
          p_terms?: string[];
          p_embedding?: string | null;
          p_min_similarity?: number;
          p_kind?: string | null;
          p_content_type?: string | null;
          p_category?: string | null;
          p_tag?: string | null;
          p_platform?: string | null;
          p_source?: string | null;
          p_entity_id?: string | null;
          p_limit?: number;
        };
        Returns: { id: string; keyword_hits: number; similarity: number | null; score: number }[];
      };
      match_entities: {
        Args: { p_user_id: string; p_type: string; p_embedding: string; p_count?: number };
        Returns: { id: string; name: string; aliases: string[]; summary: string; similarity: number }[];
      };
      prune_orphan_entities: { Args: { p_user_id: string }; Returns: number };
      tag_counts: { Args: { p_user_id: string }; Returns: { tag: string; n: number }[] };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type ItemRecord = ItemRow;
export type EntityRecord = EntityRow;
export type ItemTraceRecord = ItemTraceRow;
export type MapRecord = MapRow;
export type IntelWatchRecord = IntelWatchRow;
export type IntelSignalRecord = IntelSignalRow;
export type JournalEntryRecord = JournalEntryRow;
export type JournalMediaRecord = JournalMediaRow;
