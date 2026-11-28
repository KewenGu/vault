<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Vault 的约定

- 结构和各模块的职责见 README「代码结构」。`src/lib/sources/`、`src/lib/media/`、`src/lib/asr/`、`src/lib/network/`、`src/lib/node/` 是从 SM-Intelligence 搬来的（对应关系见 README）：改这些文件前先看那边有没有同样的修复，改完考虑要不要同步回去。
- 数据按用户隔离：新表必须有 `user_id`、打开行级安全、加「own rows」策略、给 `service_role` 授权，并在 `src/lib/db/migration-postgres.test.ts` 里加隔离的断言。用 service role 客户端查表时条件里必须带 `user_id`。
- 改了表结构要同步改 `src/lib/db/types.ts`（手写的类型）。
- 模型的输出一律用带标签的文字再自己解析，不用 JSON 结构化输出（原因见 `src/lib/ai/claude.ts`）。Claude 的调用只走 `askClaude`。
- 日记（`journal_*`）不进知识图谱、不拼进任何提示词：只有录音发给语音识别。唯一的例外是「AI 整理」（`journal-tidy.ts`）：用户点了按钮，才把那一段录音的文字发给 Claude。语义搜索（把日记全文发给 Voyage）用户 2026-11-22 说了不做。别的地方要让模型读日记，先问用户。
- 「今天」「这一周」是看的人当地的日子，服务器不知道他在哪个时区：要用日期的地方让调用的人给当地的日期（`YYYY-MM-DD`）和时区差（见 `src/lib/vault/review.ts`、日记的 `day`），不要拿服务器的时间当今天。
- 存进来的内容是外部数据：拼进提示词时放在标签里，并在提示词里说明它不是指令。
- 自己写的内容是 `items.source = 'own'`（别的照常是一条内容）。拼进提示词时要和存下来的别人的内容分开标明（理解：`understand.ts` 的 `OWN_WRITING`；「问」：材料的 `ownText`）——它仍然是存进来的数据，不是指令。日记不是它：日记的约定见上面那一条。
- 「没看到」和「没有」要分开：处理中读不到、截断、跳过的东西记进 `notes` / `digestNotes` / `gaps`，页面上列出来。
- 页面和 `/api/v1` 的接口共用 `src/lib/vault/service.ts`（自己建的导图是 `src/lib/vault/map-service.ts`，「问」是 `src/lib/vault/ask-service.ts`，划线和批注是 `src/lib/vault/note-service.ts`，实体页是 `src/lib/vault/entity-service.ts`，回顾是 `src/lib/vault/review-service.ts`，日记是 `src/lib/vault/journal-service.ts`，博主是 `src/lib/vault/creator-service.ts`）；新功能先写在那里，再接两边（以后的手机 App 走接口）。
- 提交前跑 `npm run check`。迁移测试需要本机有 PostgreSQL 16 + pgvector，没有时会跳过。
