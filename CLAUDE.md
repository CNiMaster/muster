# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About Muster

Muster is a local multi-agent orchestration system that spawns Claude Code CLI processes as agent backends and provides a web UI for visualization and interaction.

**Agent personas and skills** — 3 local personas plus 200+ domain experts integrated from [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) into `personas/`. 20 skills from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) in `skills/`.

## Product Direction: Agent Company Workbench

Muster is being redesigned from a one-shot Leader → Worker → Verifier orchestrator into a persistent, project-driven Agent company workbench.

Authoritative planning documents:

- `docs/PRD-agent-company-workbench.md` — product requirements and accepted domain semantics
- `docs/agent-company-implementation-checklist.md` — phased implementation and acceptance checklist

Key constraints for all new work:

- Do not preserve or extend the existing "quick task" mode as a product requirement. The current orchestrator and group chat are legacy implementation references, not the target architecture.
- Reuse low-level capabilities where appropriate: Claude Code process execution, streaming events, sandboxing, scheduling, backups, and path validation.
- Replace the orchestration and state model with Company, Project, Agent Definition, Project Agent Thread, Mirror, Task, Trigger, Artifact, Report Cycle, and Usage concepts from the PRD.
- All real work belongs to a Project. Employee identity is company-scoped; working context and runtime threads are project-scoped.
- A mirror is a project-local temporary parallel execution thread for one employee, not a new formal company employee.
- Task is the single runtime abstraction for queues, collaboration, clarification, feedback, event triggers, scheduled work, and bounded discussions.
- The platform owns deterministic infrastructure; semantic decisions must be assigned to an explicit Agent.
- No concurrent operation may silently overwrite or lose project files.
- The first validated vertical is a local single-user long-form novel company. Multi-tenant SaaS, payments, and full PPT/Word/video editing are later work.
- Old `.muster` runtime data contains failed test runs, has no migration requirement, and may be removed when the new persistence layer is introduced.

> 已完成 8 阶段重写（Phase 0–7 + Phase 8 验收）。旧 Leader→Worker→Verifier 单次编排器和 group-chat 已废弃，代码移到 `legacy/` 仅供历史参考，不参与构建。下面文档反映当前实现。

## Commands

```bash
npm install              # 安装依赖（express, ws, better-sqlite3, react, react-flow, vitest, playwright 等）
npm run dev              # 开发模式：tsx watch src/server/server.ts，Express 挂 Vite middleware
npm start                # 生产模式：node dist/server/server.js（需先 build）
npm run typecheck        # TypeScript 项目引用全量检查
npm test                 # Vitest 单测 + 集成（70 项）
npm run test:e2e         # Playwright 端到端（需先 `npx playwright install`，未在 CI 跑过）
npm run build            # tsup 编译 server + vite build 客户端 → dist/
```

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MUSTER_PORT` | `3456` | 服务端口 |
| `MUSTER_HOST` | `127.0.0.1` | 绑定地址（本地单用户） |
| `MUSTER_HOME` | `~/.muster` | 数据目录（muster.db、worktrees/） |
| `CLAUDE_BIN` | `claude` | Claude Code CLI 路径 |
| `MUSTER_SKIP_PERMISSIONS` | `false` | `true` 时给 Agent 传 `--dangerously-skip-permissions` |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | 项目目录允许的根列表（冒号分隔） |
| `NODE_ENV` | — | `production` 时 Express 服务 dist/client；否则挂 Vite middleware |

无构建无测试的旧时代已结束。SQLite 是公司配置、项目、Task、事件、用量的唯一权威源；文件成果保存在用户项目目录，由 Git worktree 隔离写、串行发布队列合并。

**Language**: UI 和 prompts 中文优先。Task 标题、日志、用户消息默认中文；代码标识符英文+中文混合。

## Architecture（当前实现）

### 顶层布局

```
src/
  shared/    # 类型、Zod schema、错误码、事件契约、常量（前后端共享）
  server/
    db/          # better-sqlite3 client + migrations/*.sql（14 张表）
    domain/      # company / agent / project / thread / graph / task /
                 # task-event / task-message / artifact / usage / report /
                 # inspector / brainstorm / triggers / novel-template / workflow
    task-engine/ # ExecutionAdapter 接口 + FakeExecutor + TaskEngine
    executors/   # ClaudeCodeAdapter + 上下文装配 + 安全检查
    worktree/    # Git worktree 管理 + 串行发布队列
    api/         # Express 路由（companies/agents/projects/graphs/tasks/workflows/...）
    realtime.ts  # WebSocket 广播 RealtimeEvent
    server.ts    # 入口：单端口 3456，dev 挂 Vite，prod 服务 dist/client
  client/      # React 19 + Router 7 + React Flow 12 + TanStack Query 5
    pages/       # Home / Company / Graph / Project / Tasks / Usage / Artifacts / Reports / Dashboard / WorkflowGraph
    hooks/       # React Query hooks
    api/         # fetch client + DTO
tests/
  unit/ integration/ e2e/   # 86 项 Vitest + Playwright regression & smoke
legacy/        # 旧 Leader/Worker/Verifier 代码（不参与构建，仅历史参考）
```

### 核心运行模型

- **公司状态机** `off | online | draining | review_paused`：上班锁定正式组织配置；镜像扩缩容例外。
- **Task 是唯一运行单元**：10 态状态机 `queued|claimed|running|waiting_input|waiting_dependency|paused|blocked|completed|failed|cancelled`。
- **原子领取**：`BEGIN IMMEDIATE` + `UPDATE ... WHERE state='queued' ... RETURNING`，租约 + 心跳 + 过期恢复。
- **追问 3 轮上限**：超限自动给项目第一负责人派发上报 Task。
- **执行器抽象**：`ExecutionAdapter` 接口；首个实现 `ClaudeCodeAdapter`（spawn claude，stream-json，session 持久化，Zod 校验 AgentRunResult）。
- **引擎驱动**：`TaskEngine.start()` 在 server 启动时定时轮询所有 online 公司的活跃线程（`pollIntervalMs` 默认 2s），每轮 `pumpThread` 领取→创建 worktree→执行→发布；也提供 `POST /api/projects/:id/pump` 手动触发。
- **安全成果工作区**：每 Task 一个隐藏 Git worktree + 专用分支；串行发布队列做文本三方合并、同段冲突阻塞、二进制独占锁、可回滚。
- **长篇小说公司**：5 基础岗位（lead/writer/character/plot/inspector），第一负责人≠主写手；章节完成事件触发人物/情节维护；定时一致性检查；强制复盘按根员工聚合；闲置头脑风暴受限。
- **镜像**：项目内临时并行线程，共享根员工职责/上下文/Task 池，不重复领取；成果归入根员工。

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/server/server.ts` | Express + WebSocket 入口，挂载所有 REST 路由 + Vite middleware |
| `src/server/db/migrations/0001_init.sql` | 14 张表 schema |
| `src/server/domain/task.ts` | Task 状态机、原子领取、租约、依赖、追问、自动规划 |
| `src/server/task-engine/engine.ts` | pumpThread 驱动领取→执行→完成 |
| `src/server/executors/claude-code-adapter.ts` | Claude CLI 适配器 + AgentRunResult Zod 校验 |
| `src/server/worktree/publish-queue.ts` | 串行发布 + 三方合并 + 冲突阻塞 |
| `src/server/domain/novel-template.ts` | 长篇小说公司一键模板 |
| `src/server/domain/report.ts` | 强制复盘周期（review_paused → 看板 → 备注转修正） |

### WebSocket 事件

统一 `RealtimeEvent<T>` 格式（id/type/companyId?/projectId?/taskId?/occurredAt/payload），`/ws` 路径广播。React Query 管 REST 状态，WS 事件负责失效。

### 沙盒与安全

`src/server/sandbox.ts` 维护 22 条危险命令黑名单 + 工具白名单。Claude Code 默认只能访问当前 Task worktree + 用户授权只读参考项目。

### 测试

- Vitest 集成测试 70 项（公司状态机、组织锁、跨项目只读、Task 并发领取/租约恢复/依赖/追问、worktree 三方合并/冲突阻塞、章节事件、复盘、头脑风暴、**engine→worktree→publish 编排链路**、MVP 验收剧本、重启恢复）。
- Playwright E2E smoke 已写（首页、创建公司、健康接口），但**未在本机执行过**——需 `npx playwright install` 后手动 `npm run test:e2e`。

### 已知工程取舍
- `noUncheckedIndexedAccess` 关闭（为绕过 express `req.params` 类型摩擦）。代价：数组下标访问不强制 undefined 检查。如需更严格，重开后主要修 `src/shared/utils.ts` 和 domain 的 row 映射。
- 真实 Claude CLI 端到端（`ClaudeCodeAdapter` 实际 spawn）未自动化测试，只测了 `FakeExecutor`。生产使用前需手动验证 `claude` 可执行且 `--session-id`/`--resume` 行为符合预期。

旧 Leader/Worker/Verifier、临时群聊、`.muster/config.json` 文件持久化等已全部废弃，不再参与运行。

## Related Projects

| Project | Description | Relevance |
|---------|-------------|-----------|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Agent personas & skills source | Current `agents/` + `skills/` derived from this |
| [jnMetaCode/superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) | 20 AI work methodology skills (Chinese) | Expand skills library |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | 211 AI expert personas (46 Chinese originals) | `personas/` imported from this |
| [jnMetaCode/agency-orchestrator](https://github.com/jnMetaCode/agency-orchestrator) | Multi-agent orchestration engine | DAG parallel execution patterns |
| [jnMetaCode/shellward](https://github.com/jnMetaCode/shellward) | 8-layer security middleware | Sandbox blacklist patterns inspired by this |
| [jnMetaCode/ai-coding-guide](https://github.com/jnMetaCode/ai-coding-guide) | 66 Claude Code tips & best practices | Optimize prompts & workflows |

## iHome API 接入规则

- iHome API 以 `/Users/master/Project/iHome/docs/Api规范/` 为唯一规范源。
- 收到 iHome API 变更通知时，先读 `变更通知/INDEX.md` 筛选出 `must_check` 项，再只读对应通知文件，不要整包加载全部规范。
- 本项目维护一份"实际使用的 iHome API 清单"，每次变更先搜索这些端点。
- STT WebSocket 必须发送 16kHz / 16bit / mono PCM 分片；浏览器 MediaRecorder 的 webm/opus 不能直接按 PCM 发。

## 指令入口约定（不可随意修改）

- `CLAUDE.md` 是本项目唯一主指令文件。
- `AGENTS.md`、`GEMINI.md` 只能保留 `@CLAUDE.md` 引用和本约定说明，不得复制、分叉或新增独立规则。
- 执行 /init、刷新项目记忆或更新 agent 规则时，只更新 `CLAUDE.md`。
- 如果其他入口文件已有更具体内容，必须先合并回 `CLAUDE.md`，再把入口文件恢复为 `@CLAUDE.md`。


## Supabase 数据库迁移约定（不可随意修改）

本节是项目数据库操作契约。任何 AI、脚本或协作者不得删除、弱化或绕过本节规则，除非用户在当前任务中明确要求修改该约定。

- 不默认使用 `supabase db push`。只有在确认本地 `supabase/migrations` 与远端 `supabase_migrations.schema_migrations` 历史完全一致时，才允许使用。
- 新增 Supabase migration 必须使用官方时间戳命名：`YYYYMMDDHHMMSS_description.sql`。优先通过 `supabase migration new <name>` 生成文件；不得再手写 `067_xxx.sql` 这类连续数字新迁移。
- 已有短编号历史 migration 保留不动，不为整理账本而重命名旧文件；从本约定生效后，所有新迁移一律使用官方时间戳形式。
- 远端执行优先使用 Supabase MCP `apply_migration`，并使用与本地 migration 文件一致的 migration name；没有 MCP 时使用 `supabase db query --linked --file supabase/migrations/<file>.sql`。
- 如果项目使用共享 Supabase 或双数据库，必须同时遵守项目级数据库路径和部署说明，并在所有目标数据库执行对应 SQL。
- 每次远端迁移后必须执行验证 SQL，确认关键列、函数、约束、RLS/policy、数据修复结果已经落库。
- 不主动执行 `supabase migration repair`、不手动改 `supabase_migrations.schema_migrations`，除非用户明确发起“迁移历史整理/修复”专项任务。
- 不把 Supabase access token、数据库连接串、service role key、数据库密码写入代码、文档、migration 或日志输出。
