# CLAUDE.md

> 本文件 120–150 行薄契约：怎么启动、怎么验证、当前默认行为。碰到某域再跳对应专文，不在热上下文里叠全文。

## About Muster

本地单用户多智能体工作台：项目任务、智能体/人设、蓝图与归档协同。方向「组织 = f(活)」——组织形状在蓝图里（自动复盘进化）。**当前默认**：双模式（`uiMode simple|pro`，默认 simple，壳顶栏切换 + ModeGate 16 条）+ 存储管理 `/storage`（详见「Workspace 治理」）。

## 组织与名词（四固定岗）

负责人 / 养蜂人 / 人事 / 验收员（+ 自动化管家：仅自动化页可见；裁决法庭为隐形岗）。记忆四域：personal / workspace / project / skill。详见 `docs/superpowers/specs/org-model.md`。

## Workspace 治理

- **简单/专业双模式**：`uiMode simple|pro`（默认 simple），壳切换 `→ useUiMode()`；`/api/settings/ui-mode`。
- **存储管理** `/storage`：回收站 `GET /api/projects/trash` + 磁盘对账 `GET /api/workspaces/audit`，详见 `docs/superpowers/plans/2026-08-20-workspace-governance.md`。
- **迁移口径**：`projects/<纯名>`（撞名 `-YYYYMMDD/-HHmm/-2`）；`$MUSTER_HOME/MusterWorkspace`（`src/server/domain/workspace-layout.ts`）。历史见 `docs/superpowers/plans/CHANGELOG.md`。

## Product Direction（约束摘要）

All real work belongs to a Project；平台管确定性，不抢语义决策；并发不得丢文件。全文约束见 `docs/superpowers/specs/product-direction.md`。

## Commands

```bash
npm run dev              # tsx watch，Express + Vite
npm run typecheck        # tsc 全量
npm test                 # vitest 全量
npm run test:e2e         # playwright
npm run build            # dist/
```

> 改 capability/plugin/project-readiness 等域后，`npm run dev` 下跑一遍 `npm run smoke`（77 项）。第三方引入登记 `THIRD_PARTY_NOTICES.md`。spec/plan 头部标 `状态：proposed|implemented|rejected`；重大修复落 `docs/postmortem/NNNN-*.md`。pre-push 仅 `typecheck`，全量由 CI 兜底。

## Configuration

| Variable | Default |
|---|---|
| `MUSTER_PORT` | `3456` |
| `MUSTER_HOME` | `~/.muster` |
| `CLAUDE_BIN` | `claude` |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` |
| `NODE_ENV` | `production`→`dist/client`，否则 Vite |

`SQLite` 为唯一权威源（`src/server/db/migrations/*.sql`），`Language` 中文优先。

## Architecture

`src/shared|server|client|tests|legacy`；`Task` 10 态、`project_task` 载体、staging 看门狗、worktree 隔离写。详见 `docs/superpowers/specs/architecture.md`。

## Integrations & Dependencies

- 第三方：`THIRD_PARTY_NOTICES.md` + `ACKNOWLEDGEMENTS.md`
- iHome：规范源 `/Users/master/Project/iHome/docs/Api规范/` — 详见 `docs/integrations/ihome-api.md`

## 指令入口约定（不可随意修改）

- `CLAUDE.md` 为唯一主指令文件；`AGENTS.md` / `GEMINI.md` 仅 `@CLAUDE.md`，不分叉。
- `/init` 只更新 `CLAUDE.md`。

## Supabase 数据库迁移约定（不可随意修改）

- 单源 SQLite（`better-sqlite3`），时间戳命名 `YYYYMMDDHHMMSS_description.sql`；`supabase db push` 默认不用。
- 详规见 `docs/database/migration-conventions.md`。

> 旧 Leader/Worker/Verifier、临时群聊、`.muster/config.json` 文件持久化已全部废弃。
