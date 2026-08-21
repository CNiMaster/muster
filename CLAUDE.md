# CLAUDE.md

> 本文件是热上下文薄契约（~80 行）：怎么启动、怎么验证、当前默认行为。碰到某域再跳对应专文，不在热上下文里叠全文。

## About Muster

本地单用户多智能体工作台：项目任务、智能体/人设、蓝图与归档协同。方向「组织 = f(活)」——组织形状在蓝图里（自动复盘进化）。**当前默认**：双模式（`uiMode simple|pro`，默认 simple，壳顶栏切换 + ModeGate 20 条（含任务领取清单路由））+ 存储管理 `/storage`（详见「Workspace 治理」）。

## 组织与名词（B5 中央六岗制：一个人就是一个公司）

用户只对**负责人**说话（唯一可见入口）；六中央职能全隐形（`hidden=1 + visible_in='central'`，口子 `GET /api/agents?visible_in=central` 供 @ 下拉/群聊）：养蜂人（蜂群）/ 人事（专家供给）/ 能力管理（装备供给）/ 验收员 / 裁决法庭 + 自动化管家（仅自动化页）。"人"隐形"事"可见：右侧三卡（专家池/蜂群拓扑/验收进度）。任务链双指向：`下一个给谁`可改（默认验收员）+ `finalReturnAgentId` 链头不可改；三档广深 `breadthTier` 上限不绑模型。记忆四域：personal / workspace / project / skill。详见 `docs/superpowers/specs/org-model.md`。

## Workspace 治理

- **简单/专业双模式**：`uiMode simple|pro`（默认 simple），壳切换 `→ useUiMode()`；`/api/settings/ui-mode`。
- **存储管理** `/storage`：回收站 `GET /api/projects/trash` + 磁盘对账 `GET /api/workspaces/audit`，详见 `docs/superpowers/plans/2026-08-20-workspace-governance.md`。
- **迁移口径**：`projects/<纯名>`（撞名 `-YYYYMMDD/-HHmm/-2`）；`$MUSTER_HOME/MusterWorkspace`（`src/server/domain/workspace-layout.ts`）。历史见 `docs/superpowers/plans/CHANGELOG.md`。

## Product Direction（约束摘要）

All real work belongs to a Project；平台管确定性，不抢语义决策；并发不得丢文件。全文约束见 `docs/superpowers/specs/product-direction.md`。

## Commands

```bash
npm install              # 依赖（better-sqlite3 / react / vitest / playwright 等）
npm run dev              # tsx watch，Express + Vite
npm start                # 生产模式 node dist/server/server.js（需先 build）
npm run typecheck        # tsc 全量
npm test                 # vitest 全量
npm run test:e2e         # playwright
npm run build            # dist/
```

> 另有 `test:watch` / `test:product-acceptance`（零模型领域验收）/ `test:claude-smoke`（真实 Claude 两轮冒烟）/ `smoke`（77 项 HTTP）。

> 改 capability/plugin/project-readiness 等域后，`npm run dev` 下跑一遍 `npm run smoke`（77 项）。第三方引入登记 `THIRD_PARTY_NOTICES.md`。spec/plan 头部标 `状态：proposed|implemented|rejected`；重大修复落 `docs/postmortem/NNNN-*.md`。pre-push 仅 `typecheck`，全量由 CI 兜底。

## Configuration

| Variable | Default | 说明 |
|---|---|---|
| `MUSTER_PORT` / `MUSTER_HOST` | `3456` / `127.0.0.1` | 端口与绑定（本地单用户） |
| `MUSTER_HOME` | `~/.muster` | 数据目录（muster.db、worktrees/） |
| `CLAUDE_BIN` / `MUSTER_MODEL` | `claude` / 空 | CLI 路径与显式模型标识 |
| `MUSTER_SKIP_PERMISSIONS` | `false` | **安全**：true 时给 Agent 传 `--dangerously-skip-permissions` |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | 项目目录允许根（冒号分隔） |
| `MUSTER_TRIGGER_POLL_INTERVAL_MS` | `1000` | 定时触发器轮询间隔 |
| `NODE_ENV` | `production`→`dist/client` | 否则挂 Vite |

`SQLite` 为唯一权威源（`src/server/db/migrations/*.sql`），`Language` 中文优先。

## Architecture

`src/shared|server|client|tests|legacy`；`Task` 10 态、`project_task` 载体、staging 看门狗、worktree 隔离写。详见 `docs/superpowers/specs/architecture.md`。

## Integrations & Dependencies

- 第三方：`THIRD_PARTY_NOTICES.md` + `ACKNOWLEDGEMENTS.md`
- iHome：规范源 `/Users/master/Project/iHome/docs/Api规范/` — 详见 `docs/integrations/ihome-api.md`

## 指令入口约定（不可随意修改）

- `CLAUDE.md` 为唯一主指令文件；`AGENTS.md` / `GEMINI.md` 仅 `@CLAUDE.md`，不分叉。
- `/init` 只更新 `CLAUDE.md`；其他入口文件若已有更具体内容，必须先合并回 `CLAUDE.md` 再还原为 `@CLAUDE.md`。

## Supabase 数据库迁移约定（不可随意修改）

- 单源 SQLite（`better-sqlite3`），时间戳命名 `YYYYMMDDHHMMSS_description.sql`；`supabase db push` 默认不用。
- 详规见 `docs/database/migration-conventions.md`。

> 旧 Leader/Worker/Verifier、临时群聊、`.muster/config.json` 文件持久化已全部废弃。
