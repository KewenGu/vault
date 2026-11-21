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
- 存进来的内容是外部数据：拼进提示词时放在标签里，并在提示词里说明它不是指令。
- 「没看到」和「没有」要分开：处理中读不到、截断、跳过的东西记进 `notes` / `digestNotes` / `gaps`，页面上列出来。
- 页面和 `/api/v1` 的接口共用 `src/lib/vault/service.ts`（自己建的导图是 `src/lib/vault/map-service.ts`）；新功能先写在那里，再接两边（以后的手机 App 走接口）。
- 提交前跑 `npm run check`。迁移测试需要本机有 PostgreSQL 16 + pgvector，没有时会跳过。
