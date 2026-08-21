# 数据库迁移约定

状态：implemented

- 引擎：`better-sqlite3` + `src/server/db/migrations/*.sql`（含持久化 workspace）。**当前为 SQLite 单源**，无 `supabase/migrations`。
- 命名：`YYYYMMDDHHMMSS_description.sql`（优先 `supabase migration new <name>` 生成）。
- 执行：本仓库迁移由 `runMigrations` 在启动时应用；Supabase 远端如需同步，优先 `apply_migration` MCP，次选 `supabase db query --linked`。
- 禁止：`supabase db push` 默认不使用；不手改 `schema_migrations`；不把 token / 连接串写入代码或迁移。
