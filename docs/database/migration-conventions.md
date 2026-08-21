# 数据库迁移约定（不可随意修改）

状态：implemented

本节是项目数据库操作契约（2026-08-21 自 CLAUDE.md 整体搬入，规则原文未弱化）。任何 AI、脚本或协作者不得删除、弱化或绕过本节规则，除非用户在当前任务中明确要求修改该约定。

- 引擎：`better-sqlite3` + `src/server/db/migrations/*.sql`（含持久化 workspace）。**当前为 SQLite 单源**，无 `supabase/migrations` 目录。
- 不默认使用 `supabase db push`。只有在确认本地 `supabase/migrations` 与远端 `supabase_migrations.schema_migrations` 历史完全一致时，才允许使用。
- 新增 migration 必须使用官方时间戳命名：`YYYYMMDDHHMMSS_description.sql`（优先 `supabase migration new <name>` 生成）；不得手写连续数字新迁移。
- 已有短编号历史 migration 保留不动，不为整理账本而重命名旧文件。
- 远端执行优先使用 Supabase MCP `apply_migration`（migration name 与本地文件一致）；没有 MCP 时使用 `supabase db query --linked --file supabase/migrations/<file>.sql`。
- 如果项目使用共享 Supabase 或双数据库，必须同时遵守项目级数据库路径和部署说明，并在所有目标数据库执行对应 SQL。
- 每次远端迁移后必须执行验证 SQL，确认关键列、函数、约束、RLS/policy、数据修复结果已经落库。
- 不主动执行 `supabase migration repair`、不手动改 `supabase_migrations.schema_migrations`，除非用户明确发起"迁移历史整理/修复"专项任务。
- 不把 Supabase access token、数据库连接串、service role key、数据库密码写入代码、文档、migration 或日志输出。
