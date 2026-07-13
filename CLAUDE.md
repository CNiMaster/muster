# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About Muster

Muster is a local multi-agent company workbench. Persistent employees collaborate through project-scoped Tasks while fixed CLI or API executors run their work in isolated worktrees.

**Agent personas and skills** — 3 local personas plus 200+ domain experts integrated from [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) into `personas/`. 20 skills from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) in `skills/`.

## Product Direction: Agent Company Workbench

Muster is a persistent, project-driven Agent company workbench. The former one-shot Leader → Worker → Verifier model is retained only as historical context.

Authoritative planning documents:

- `docs/PRD-agent-company-workbench.md` — product requirements and accepted domain semantics
- `docs/superpowers/specs/2026-07-11-platform-workspace-agent-memory-templates-design.md` — confirmed vNext workspace, employee memory, executor, permission, template, and UX design
- `docs/superpowers/plans/2026-07-11-vnext-guided-workspace-foundation.md` — delivered and verified vNext workspace/onboarding foundation
- `docs/superpowers/plans/2026-07-11-vnext-agent-profile-memory.md` — delivered and verified Agent Profile, Agent Home, layered memory, and context recovery
- `docs/agent-company-implementation-checklist.md` — completed historical implementation checklist and acceptance record

Key constraints for all new work:

- Do not preserve or extend the existing "quick task" mode as a product requirement. The current orchestrator and group chat are legacy implementation references, not the target architecture.
- Reuse low-level capabilities where appropriate: Claude Code process execution, streaming events, sandboxing, scheduling, backups, and path validation.
- Evolve the domain model toward Workspace, Agent Profile, Company Employee, Project, Project Agent Thread, Mirror, Task, Trigger, Artifact, Report Cycle, Usage, Executor Profile, Permission Policy, Memory Entry, Capability Package, and Company Template concepts from the PRD and vNext design.
- All real work belongs to a Project. Agent Profile is reusable and user-local; company employment, project context, runtime threads, sessions, permissions, and worktrees remain scoped and isolated.
- Employees bind fixed CLI or API executors. Company defaults may be inherited, but an employee does not silently switch executors during a Task.
- A mirror is a project-local temporary parallel execution thread for one employee, not a new formal company employee.
- Task is the single runtime abstraction for queues, collaboration, clarification, feedback, event triggers, scheduled work, and bounded discussions.
- The platform owns deterministic infrastructure; semantic decisions must be assigned to an explicit Agent.
- No concurrent operation may silently overwrite or lose project files.
- Writing is one built-in company template alongside general, software, and content companies. Multi-tenant SaaS, payments, and full PPT/Word/video editing remain outside the local workbench scope.
- Old `.muster` runtime data contains failed test runs, has no migration requirement, and may be removed when the new persistence layer is introduced.

> 当前成品边界是本地单用户多 Agent 公司工作台：公司向导、团队与员工档案、项目任务、固定执行器/权限、审批、会话健康和实时状态均已形成代码级闭环。旧 Leader→Worker→Verifier 单次编排器不参与当前运行。

## Commands

```bash
npm install              # 安装依赖（express, ws, better-sqlite3, react, react-flow, vitest, playwright 等）
npm run dev              # 开发模式：tsx watch src/server/server.ts，Express 挂 Vite middleware
npm start                # 生产模式：node dist/server/server.js（需先 build）
npm run typecheck        # TypeScript 项目引用全量检查
npm test                 # Vitest 单测 + 集成（需 git 可用）
npm run test:product-acceptance # 无真实模型请求的成品领域验收
npm run test:e2e         # Playwright 端到端
npm run test:claude-smoke # 真实 Claude 两轮 Task/session/artifact/usage 冒烟
npm run build            # tsup 编译 server + vite build 客户端 → dist/
```

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MUSTER_PORT` | `3456` | 服务端口 |
| `MUSTER_HOST` | `127.0.0.1` | 绑定地址（本地单用户） |
| `MUSTER_HOME` | `~/.muster` | 数据目录（muster.db、worktrees/） |
| `CLAUDE_BIN` | `claude` | Claude Code CLI 路径 |
| `MUSTER_MODEL` | 留空 | 显式模型标识；留空使用 Claude Code 默认模型 |
| `MUSTER_SKIP_PERMISSIONS` | `false` | `true` 时给 Agent 传 `--dangerously-skip-permissions` |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | 项目目录允许的根列表（冒号分隔） |
| `MUSTER_TRIGGER_POLL_INTERVAL_MS` | `1000` | 持久化定时触发器的轮询间隔 |
| `NODE_ENV` | — | `production` 时 Express 服务 dist/client；否则挂 Vite middleware |

无构建无测试的旧时代已结束。SQLite 是公司配置、项目、Task、事件、用量的唯一权威源；文件成果保存在用户项目目录，由 Git worktree 隔离写、串行发布队列合并。

**Language**: UI 和 prompts 中文优先。Task 标题、日志、用户消息默认中文；代码标识符英文+中文混合。

## Architecture（当前实现）

### 顶层布局

```
src/
  shared/    # 类型、Zod schema、错误码、事件契约、常量（前后端共享）
  server/
    db/          # better-sqlite3 client + migrations/*.sql（含持久化 workspace）
    domain/      # company / agent / project / thread / graph / task /
                 # task-event / task-message / artifact / usage / report /
                 # inspector / brainstorm / triggers / novel-template / workflow /
                 # event-feed（关键事件聚合）/ graph-proposal（自然语言改图）/
                 # character-graph（只读人物关系图解析）/ speech-queue（loop protection + dedup）
    task-engine/ # ExecutionAdapter 接口 + FakeExecutor + TaskEngine + RunWatchdog + agentExecutor 覆盖
    trigger-scheduler.ts # 轮询持久化 schedule trigger，原子推进并派发巡检 Task
    executors/   # Claude/Codex/Gemini CLI + OpenAICompatible/Gemini API adapters +
                 # 上下文装配 + 安全检查 + 会话压缩 + 时间轮换 + apiKeyEnv 凭据注入 +
                 # tool-loop（function calling 工具循环）+ file-tools（worktree 文件工具 + notify_host）+
                 # CLI 权限桥（Codex app-server JSON-RPC / Claude PreToolUse fail-closed Hook）+
                 # model-pricing（成本估算）+ provider（多执行器分发）+ result-schema（共享 schema）
    worktree/    # Git worktree 管理 + 串行发布队列 + artifact 独占锁
    bridge.ts    # Agent Bridge：loopback HTTP（/bridge/:action），Agent 可主动通知宿主进度
    api/         # Express 路由（companies(status-board/usage)/agents/projects(character-graph)/
                 # graphs(propose/apply)/artifacts(open/rollback)/events/usage/workflows/brainstorm/...）
    realtime.ts  # WebSocket 广播 RealtimeEvent
    server.ts    # 入口：单端口 3456，dev 挂 Vite，prod 服务 dist/client
  client/      # React 19 + Router 7 + React Flow 12 + TanStack Query 5
    pages/       # Home / Company / Graph / Project / Tasks / Usage / Artifacts / Reports / Dashboard / WorkflowGraph / CharacterGraph / Settings
    components/  # StatusBoard / EventFeedList / ActivityPanel / ConversationPanel / OnboardingGuide / ErrorBoundary / NaturalLanguageGraphPanel / ...
    hooks/       # React Query hooks
    realtime.ts  # WebSocket 断线重连 + 精确失效 React Query 缓存
    api/         # fetch client + DTO
tests/
  unit/ integration/ e2e/   # Vitest + Playwright regression/product flows
legacy/        # 旧 Leader/Worker/Verifier 代码（不参与构建，仅历史参考）
```

### 核心运行模型

- **公司状态机** `off | online | draining | review_paused`：上班锁定正式组织配置；镜像扩缩容例外。
- **Task 是唯一运行单元**：10 态状态机 `queued|claimed|running|waiting_input|waiting_dependency|paused|blocked|completed|failed|cancelled`。
- **项目任务边界由用户控制**：后台自动规划只能进入已有的 active `project_task`；没有用户项目任务时不得暗中创建新的上下文边界。
- **原子领取**：`BEGIN IMMEDIATE` + `UPDATE ... WHERE state='queued' ... RETURNING`，租约 + 心跳 + 过期恢复。
- **追问 3 轮上限**：超限自动给项目第一负责人派发上报 Task。
- **执行器抽象**：统一 Manifest/Profile 已落地；认证执行器包含 Codex CLI、Claude Code、Antigravity CLI 与 Muster API，自定义 CLI 以受限非交互模式运行。员工任职固定绑定执行器，基础探测使用 CLI 默认模型。
- **执行生命周期**：`RunWatchdog` 统一限制启动、空闲与总运行时长；`SessionManager` 独立处理上下文软阈值压缩、硬阈值换代和有限恢复链。
- **引擎驱动**：`ProjectRuntimeCoordinator` 在 server 启动时定时轮询 online 公司，补线程、处理中断/排空/复盘并调用 `TaskEngine.pumpThread()` 完成领取→worktree→执行→发布；也提供 `POST /api/projects/:id/pump` 手动触发。
- **定时触发**：`TriggerScheduler` 轮询 `trigger.next_run_at`；小说项目自动注册遗漏、连续性、长期一致性检查。下班期间不派发，上班后补派发；下一执行时间与 Task 创建在同一事务推进，避免重复。
- **实时状态**：服务端通过 `/ws` 发布 Task、项目任务、审批、会话压缩/换代/恢复和 Watchdog 事件；前端精确失效项目任务、员工运行态、审批和公司驾驶舱缓存，轮询仅作断线兜底。
- **通信边界**：带 `dispatcherAgentId` 的 Task 创建必须满足同公司和 `contact_allow`，不能绕过通信图直接派发。
- **安全成果工作区**：每 Task 一个隐藏 Git worktree + 专用分支；串行发布队列做文本三方合并、同段冲突阻塞、二进制独占锁、可回滚。
- **总工作区**：`workspace` 表持久化多个本地根目录并保证唯一激活；未显式指定路径的新项目写入 `{workspace}/companies/{公司}/projects/{项目-ID}`，Task 仍在项目专属 worktree 内执行。
- **员工档案、任职与运行态**：`agent_profile` 是全局稳定身份，`company_employee` 是公司任职，`project_task_thread` 是项目任务中的运行会话；员工页将三者分栏展示，同一档案可被多家公司引用。
- **Agent Home 与分层记忆**：每个档案在 `{MUSTER_HOME}/agents/{profileId}` 拥有隔离个人空间；个人、技能、公司、项目记忆先进入候选审核，再写入版本化 SQLite/FTS 索引，并将已批准内容原子同步为人可读 Markdown。待审内容、凭据、会话与本地路径不会进入能力导出。
- **可重建上下文**：上下文按身份原则→公司任职→项目→已批准分层记忆→Task 装配；自动/手动压缩先持久化记忆并保留前一 session 引用，失败时不清空旧 session。
- **长篇小说公司**：5 基础岗位（lead/writer/character/plot/inspector），第一负责人≠主写手；章节完成事件触发人物/情节维护；定时一致性检查；强制复盘按根员工聚合；闲置头脑风暴受限。
- **镜像**：项目内临时并行线程，共享根员工职责/上下文/Task 池，不重复领取；成果归入根员工。

### 多 Agent 协作增强（平台级能力）

以下能力均为通用机制，不绑定特定模板（写作模板可以不用，编码模板可以按需配置）：

- **立场锁定（stance）**：AgentDefinition 有 `stance` 字段，在 `assembleContext` 中注入 `# 你的立场` 到 system prompt，指示 Agent 在讨论/辩论中坚持预设立场。写作场景用于角色一致性，编码场景可用于 code review 立场。
- **活动流面板（ActivityPanel）**：Agent 间的 outboundTasks 派发（`spawned_child` 事件）和交接活动显式化，在 ProjectPage/CompanyPage 的独立面板展示 `@A → @B` 协作摘要。WebSocket 实时刷新（`project-events`/`company-events` key）。
- **Loop Protection**：`speech-queue.ts` 的 `isDispatchLoop()` 追踪 Agent→Agent 派发链，检测 A→B→A 回环和连续调用超限（阈值 3），在 `task.ts` 的 outboundTasks 派发处阻断并记录 `dispatch_loop_blocked` 事件。
- **去重（dedup）**：`speech-queue.ts` 的 `isDuplicateContent()` 用 Jaccard 关键词相似度检查 assistant 回复是否与近期消息重复（>80% 抑制），在 `engine.ts` 回复写入前调用。
- **Agent Bridge**：`bridge.ts` 提供 loopback HTTP 通道（`/bridge/:action`，action=progress/notify/preview），让 Agent 执行中主动通知宿主进度。OpenAI/Gemini 通过 `notify_host` 工具调用，Claude-cli 通过 systemPrompt 中的 curl 指令。taskId 格式校验防注入。
- **工作流条件边 + 受控回环**：`WorkflowEdge` 有 `condition`（5 种：always/auto_review/outcome_equals/manual_approval/agent_label）和 `maxTraversals`（回环保护）。`advanceWorkflowTask` 按条件优先级求值而非仅靠 LLM label 匹配；`auto_review` 解析 `REVIEW_STATUS: PASS/FAIL` 标记（借鉴 FreeBuddy）。`assembleContext` 注入 `workflowBranches` 让 Agent 看到可选出边。

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/server/server.ts` | Express + WebSocket 入口，挂载所有 REST 路由 + Vite middleware + bridge |
| `src/server/db/migrations/0001_init.sql` | 14 张表 schema |
| `src/server/domain/task.ts` | Task 状态机、原子领取、租约、依赖、追问、自动规划、loop protection |
| `src/server/domain/speech-queue.ts` | isDispatchLoop（循环检测）+ isDuplicateContent（去重） |
| `src/server/domain/workflow.ts` | 工作流图 + 条件边求值 + 受控回环（maxTraversals） |
| `src/server/bridge.ts` | Agent Bridge loopback HTTP（/bridge/:action） |
| `src/server/task-engine/engine.ts` | pumpThread 驱动领取→执行→完成 |
| `src/server/trigger-scheduler.ts` | 持久化定时触发器轮询与生命周期 |
| `src/client/realtime.ts` | WebSocket 实时查询同步 + bridge.notify toast |
| `src/server/executors/context.ts` | 上下文装配（stance 注入 + workflowBranches + bridge prompt） |
| `src/server/executors/claude-code-adapter.ts` | Claude CLI 适配器 + AgentRunResult Zod 校验 |
| `src/server/executors/tools/file-tools.ts` | worktree 文件工具 + notify_host（Agent Bridge） |
| `src/server/worktree/publish-queue.ts` | 串行发布 + 三方合并 + 冲突阻塞 |
| `src/server/domain/novel-template.ts` | 长篇小说公司一键模板 |
| `src/server/domain/report.ts` | 强制复盘周期（review_paused → 看板 → 备注转修正） |
| `src/server/db/migrations/0003_settings.sql` | 系统设置表 |
| `src/server/db/migrations/0004_trigger_schedule_state.sql` | 定时触发器执行游标 |
| `src/server/db/migrations/0012_agent_stance.sql` | Agent stance 字段 |
| `src/server/db/migrations/0014_workflow_edge_condition.sql` | 工作流边条件 + 回环上限 |
| `src/server/db/migrations/0015_workspace.sql` | 总工作区根目录与唯一激活状态 |
| `src/server/db/migrations/0016_agent_profile.sql` | 全局 Agent Profile 与公司任职兼容迁移 |
| `src/server/db/migrations/0017_agent_memory.sql` | 分层记忆候选、条目、版本与 FTS 索引 |
| `src/server/db/migrations/0018_session_memory_flush.sql` | 压缩前记忆持久化与上一 session 引用 |
| `src/server/db/migrations/0019_agent_profile_base.sql` | 可恢复的员工基础能力快照 |
| `src/server/domain/agent-home.ts` | 隔离 Agent Home、身份/能力导出和记忆文件同步 |
| `src/server/domain/memory.ts` | 记忆审核、作用域、版本、检索与安全扫描 |

### WebSocket 事件

统一 `RealtimeEvent<T>` 格式（id/type/companyId?/projectId?/taskId?/occurredAt/payload），`/ws` 路径广播。React Query 管 REST 状态，WS 事件负责精确失效相关 Task、线程和用量缓存。

### 沙盒与安全

`src/server/sandbox.ts` 维护 22 条危险命令黑名单 + 工具白名单。Claude Code 默认只能访问当前 Task worktree + 用户授权只读参考项目。

### 测试

- Vitest 单元与集成测试覆盖运行闭环、workspace 引导、全局员工档案、跨公司任职、Agent Home、分层记忆、项目任务会话、CLI 探测、审批桥、上下文恢复、复用与安全重置；准确数量以 `npm test` 当前输出为准。
  - 测试环境需要真实 git 仓库作为 `project.rootDir`（`createWorktree` 需要 `git rev-parse HEAD` 成功）。`tests/integration/setup.ts` 的 `makeTempGitRepo()` 创建临时 git 仓库（含初始 commit）供测试使用。
  - `project.rootDir` 与 `firstAgentId` 均为可选：建项目时留空，`createProject` 自动使用当前激活总工作区，并生成 `{workspace}/companies/{公司名}/projects/{项目名}-{项目ID}`；项目 ID 后缀保证同名项目不会共享目录。`ensureGitRepo()` 会在首个 worktree 创建时自动 `mkdir + git init`。
- Playwright 覆盖建司→团队→项目→首 Task、在线建项目、最近项目恢复、公司上下文导航、员工库、执行器中心、权限中心以及窄屏设置页；准确数量以 `npm run test:e2e` 当前输出为准。
- `npm run test:claude-smoke` 已使用真实 Claude Code 连续完成两个 Task，验证跨 worktree 的 `--session-id`/`--resume`、文件发布、Artifact 登记和 Token/缓存用量。

`publish_record` 由 `0002_conversation.sql` 创建，记录 Task 发布提交、合并文件、冲突与阻塞状态，供成果修改历史页读取。

### 已知工程取舍
- `noUncheckedIndexedAccess` 关闭（为绕过 express `req.params` 类型摩擦）。代价：数组下标访问不强制 undefined 检查。如需更严格，重开后主要修 `src/shared/utils.ts` 和 domain 的 row 映射。
- Claude Code 的模型可用性由用户本机或代理服务决定。先在“系统设置”填写实际支持的模型标识并运行桥接测试；错误模型会直接返回诊断，不会用 FakeExecutor 冒充成功。
- 当前认证接入包含 Codex CLI、Claude Code、Antigravity CLI、OpenAI-compatible API 和 Gemini API，并完成统一 Manifest/Profile、项目任务会话、审批/Turbo 权限、分层记忆和平台化公司入口。
- OpenCode/Pi 等更多 CLI 需通过同一兼容性门禁后再加入；完整多模态和多租户 SaaS 不属于当前本地成品边界。

### UI 分层约定
- **低门槛优先**：首次主流程固定为“创建公司→组建团队→创建项目→发布 Task”；首屏只提供一个状态相关主行动，rootDir/firstAgentId 后端自动。
- **看板纯前端增强**：DashboardPage 用 `useProjectEvents`/`useStatusBoard`/`useTasks` reduce/`useProjectUsage.byModel` 在客户端做状态分布条、负载柱状图、事件时间线、模型用量拆分；不引入图表库，用 CSS（`.dashboard-*` 类）可视化。新增聚合趋势（吞吐/费用时序）需后端补端点，不属于前端职责。
- **低频配置收口**：项目目录、说明、复盘阈值和讨论预算集中到“项目设置”；项目页仅将线程扩容和脑暴收进协作工具折叠区。员工编辑折叠立场/技能/权限/执行器；系统设置首屏只显示默认执行器、连接测试与保存。
- **员工中心的项目工作台**：项目仍是工作空间与上下文边界，但日常观察对象是员工。左栏固定为组织与联系人树（第一负责人置顶、固定项目群聊、部门员工及其名下工作单）；中栏展示员工单聊/派发、项目任务、群聊或工具；右栏只放可点击的员工工作与项目运行入口。项目任务是用户目标边界，员工工作单归在员工名下。
- **工作流与计划边界**：员工上下级、引用许可、步骤条件与任务交接格式属于公司级配置，项目暂不覆盖公司工作流；项目只配置计划任务、任务领取清单和运行状态。所有项目工具页复用同一个三栏外壳，子工具页不得重新出现全局顶栏。
- **模板优先创建**：员工库默认先展示与四类公司模板对应的整套团队，再展示单岗位快捷模板，空白自定义表单只作为低频入口；公司创建继续以模板向导为主入口。
- **内联 style**：历史代码大量 `style={{...}}`，新增复杂区块优先抽 `.details-collapse` 等语义类进 `global.css`；简单 grid/gap 保留内联可接受。

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
