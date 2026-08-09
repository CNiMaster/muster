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
node scripts/smoke/capability-platform.mjs  # 能力平台 API 冒烟（需先 npm run dev，12 项 B1-B5 + transport 链路）
```

> **冒烟测试约定**：改 capability/plugin/project-readiness/mcp 相关代码后，启动 `npm run dev` 跑一次 `node scripts/smoke/capability-platform.mjs`，确认建项目→准备流程→plugin CRUD→marketplace→MCP transport 端到端可用。单测覆盖代码逻辑，冒烟覆盖真实 HTTP 链路。
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
- **项目状态机（准备流程）** `idle(兼容) | drafting | researching | equipping | staffing | ready | active | paused | completed | archived`：新建项目默认进 `drafting`，经六阶段准备流程（构思→调研→装备→员工→就绪）到 `active` 才能派工。`transitionProjectPhase` + `assertCanTransition` 做状态转换校验（向前需按序，回流任意允许），`validatePhaseExit` 校验向前跃迁的阶段产物（drafting 需 goal、researching 需摘要+候选能力、equipping 需启用 plugin、staffing 需分配员工）。readiness 存 `project.settings.onboarding`。任务连续失败 3 次（`failure_count >= TASK_CIRCUIT_BREAKER_THRESHOLD`）且项目 active 时自动熔断回流到 `researching`。`createProject` 接受可选 `initialState` 跳过准备流程（测试/模板用）。
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
- **安全成果工作区**：每 Task 一个隐藏 Git worktree + 专用分支；串行发布队列做文本三方合并和二进制独占锁。冲突时保留原 worktree，自动给项目第一负责人派发带 base/ours/theirs 快照的交互式裁决 Task；临时快照不会进入 Git 提交，裁决失败或取消会升级并允许原 Task 重试。裁决发布前必须同步预检任务链，Git 发布后若数据库收口失败则自动回滚；连续两轮仍冲突时整条发布链统一升级人工。仅真正落盘且尚未回滚的发布可人工回滚。
- **总工作区**：`workspace` 表持久化多个本地根目录并保证唯一激活；未显式指定路径的新项目写入 `{workspace}/companies/{公司}/projects/{项目-ID}`，Task 仍在项目专属 worktree 内执行。
- **员工档案、任职与运行态**：`agent_profile` 是全局稳定身份，`company_employee` 是公司任职，`project_task_thread` 是项目任务中的运行会话；员工页将三者分栏展示，同一档案可被多家公司引用。
- **Agent Home 与分层记忆**：每个档案在 `{MUSTER_HOME}/agents/{profileId}` 拥有隔离个人空间；个人、技能、公司、项目记忆先进入候选审核，再写入版本化 SQLite/FTS 索引，并将已批准内容原子同步为人可读 Markdown。待审内容、凭据、会话与本地路径不会进入能力导出。
- **可重建上下文**：上下文按身份原则→公司任职→项目→已批准分层记忆→Task 装配；自动/手动压缩先持久化记忆并保留前一 session 引用，失败时不清空旧 session。
- **长篇小说公司**：5 基础岗位（lead/writer/character/plot/inspector），第一负责人≠主写手；章节完成事件触发人物/情节维护；定时一致性检查；强制复盘按根员工聚合；闲置头脑风暴受限。
- **镜像**：项目内临时并行线程，共享根员工职责/上下文/Task 池，不重复领取；成果归入根员工。
- **能力中心（工具档案库）**：平台是"搬运工不是提供者"。`tools/` 目录是"能力→可用实现"的备选目录（不是安装清单），每个档案含 frontmatter（capability/implementation local|api/executor_kind/credential_keys/install/check/maturity）+ 正文。启动时 `syncToolRegistry()` 扫描入库到 `tool_registry` 表；后台设默认项，创建公司时 `dispatchDefaultToolsToCompany()` 派发到 `company_tool`。`assembleContext` 按"员工名下所有 capabilityBindings 的 recommendedToolIds"注入 `# 能力中心` system prompt 段，员工已具备相似工具时优先用自己的，缺少时参考推荐。是否安装/调用由员工自行决定，平台不做强制门禁，只做软诊断（`capability_tool_unavailable`/`capability_executor_mismatch` finding）。`capabilityBindingDefinitionSchema` 已扩展 `recommendedToolIds` 和 `requiresExecutorKind` 两字段。
- **Plugin 体系（能力接入/下载/自定义 + opt-out 治理）**：统一 Plugin 模型（kind: skill/mcp-server/tool/bridge-action/ai-generated；source: builtin/executor-native/company/project/marketplace/ai-generated；scope: platform/company/project/employee）。现有 skill/tool/bridge 通过 `plugin-adapter.ts` 包装为只读 Plugin 视图，零迁移。`plugin` 表 + `company_plugin` 决策表（启停需 `company.state==='off'`）。**opt-out 治理**（迁移 `20260809100000`）：平台插件默认对所有公司启用，公司可显式禁用（`company_plugin.decision='disabled'`）；公司独占插件（scope=company）仅目标公司可见。`getEffectivePluginsForCompany` 计算 effective = 平台插件 MINUS 禁用集 ∪ 公司独占插件。**接入**：`POST /api/plugins` 存任意 MCP 配置，`assembleTools` 在 pumpThread 时按 effective 列表连接 MCP server、探测工具、注册进 RuntimeToolRegistry。**管理页**：`/capabilities`（CapabilityCenterPage）按 kind 分 Tab，每插件展开后是公司开关矩阵（三态：default/enabled/disabled/exclusive）。**下载**：`marketplace.ts` 检索本地 `~/.zcode/skills` + GitHub(`gh search`)，`installMarketplaceEntry` 落库。**自定义**：`skill-author.ts` 调 LLM（`llm-call.ts`，OpenAI 兼容，三层凭据解析）起草 SKILL.md 作为兜底。RuntimeToolRegistry 替代原 FILE_TOOLS 硬编码 switch，内置 7 工具变注册项，第三方/MCP 工具同接口注册。
- **MCP 接入（三种 transport）**：`McpClientPool` 支持 stdio（本地子进程 command/args/env）、sse（SSEClientTransport，url/headers）、http（StreamableHTTPClientTransport，url/headers）。按 `McpServerConfig.transport` 分发到对应 SDK transport。MCP 工具经 `mcp/adapter.ts` 适配成 RuntimeTool 注册，命名 `mcp_<serverId>__<toolName>`，默认走 `network` 权限动作。连接失败的单个 server 不致命，记 health 错误后跳过。
- **项目准备流程编排（PlanVersion + 阶段历史）**：`project_plan` 表记录每次 spec/plan 版本（回流时开新版本，created_reason: initial/rollback-3x/scope-change/manual），`project_phase_history` 记录阶段进出（含 rollbackFrom/reason）。lifecycle 事件 `project.phase-entered/exited/readiness-passed/rollback` 驱动前端 wizard stepper 自动刷新（`realtime.ts` 的 `project.*` 事件 invalidate `['project', id]`）。
- **B2B 跨组织任务委派（外包）**：「公司」是软件内本地组织概念。`outsourcing_contract` 契约表（迁移 `20260810100000`）记录甲方 source → 乙方 target 的委派全生命周期：pending→accepted→in_progress→delivered→reviewing→completed/changes_requested/rejected。task 表增 `outsourcing_contract_id` 列标记承接任务。**全自动决策树**（`outsourcing-decision.ts`）：内部能做（`capability_binding` 有 employee_id 命中）→ 外包（跨公司扫描找具备能力的乙方）→ 招聘。**跨公司守卫旁路**：createTask 的同公司检查通过 `outsourcingContext` 显式参数绕过（默认不传=零回归），唯一跨公司入口是 `createOutsourcedTask`。承接任务在乙方项目里（assignee/project 同属乙方，thread 守卫自然通过）。**文件交付**：engine.ts 检测 `outsourcing_contract_id`，承接任务 worktree 基于**甲方 source project 的 git repo** 切出（`createWorktree(sourceProject.rootDir,...)`），publish 目标指向甲方 rootDir，readonlyDirs 追加甲方资料路径（复用全部三方合并管线，baseCommit 在甲方 repo 有效）。**跨公司依赖恢复**：`resumeDependents`（task.ts）扫描 `task_dependency` 全表唤醒等待方（补齐 parentTaskId 单链之外的跨公司依赖），在 completeTask completed 分支调用。验收返工（changes_requested）复用 business-review 模式：继承 acceptanceCriteria 另起返工任务。API：`POST /api/companies/:id/outsource/dispatch`（含决策树）/ `contracts/:id/accept|review|cancel`。管理页 `/outsourcing`（OutsourcingCenterPage）两栏契约看板。
- **临时工模型 + 员工评级（批次 A）**：`company_employee` 增 `employment_type`('permanent'|'temp')/`temp_status`('active'|'greyed'|'dismissed')/`source_contract_id`（迁移 `20260811000000`）；`agent_profile` 增 `is_temp_only`(0|1)/`rating`(1-5)。临时工是 B2B 决策树 recruit 路径落地。**选拔优先级链**（`selectTempForNeed`）：公司内部→复用 greyed 临时工（`reactivateGreyedTemp`，高星优先）→人才库（`is_temp_only=0`）→创建新临时工（`is_temp_only=1`）。**临时工小范围关系**：`contactAllow` 仅含发起者（对其他人隐形）。**招聘豁免**：temp 招聘允许 online 态（`assertUnlocked` 的 `tempRecruit` 参数），**绝不导致公司离线**。**两种开除**：`is_temp_only=0`（人才市场来的）开除保留 profile+Home、只清公司记忆分区；`is_temp_only=1`（临时新建未转正）开除连 profile+Agent Home 一起删、不进人才市场。**完成→greyed**：承接任务完成后（`onOutsourcedTaskCompleted`）temp+active 自动 greyed，不参与派工（`claimNextTask` 排除非 active temp）。**评级**（`employee-rating.ts`）：多维度自动计算（任务完成+记忆+任职+外包验收加权）→ 1-5 星，任务完成时 `applyRating` 异步重算；用户可 `adjustRating` 手动调；影响人才市场推荐排序与外包优先。API：`POST /companies/:id/employees/temp|:id/convert|:id/dismiss|:id/reactivate`、`POST /agent-profiles/:id/rating`。
- **权限委托链 + 审计（批次 B）**：`permission_change_request` 表（迁移 `20260812000000`）记录下级申请权限变更（临时/项目/永久+原因），上级审批后生成 `permission_rule`。**委托链路由**（`permission-delegation.ts`）：员工超权→`findDirectManager`（org 边上溯 source_id）→公司第一负责人→用户，不让人逐个批。**审计日志**（`artifact_change_log`）：`upsertPublishedArtifact` 自动记 create/update；`transferArtifactOwnership`/`transferAllArtifactsOfOwner` 记 transfer（含接手人），交接时 owner 单一指针更新（不叠加）。**按角色模板**（`permission-templates.ts`）：经理(project/no-approval)/员工(task/ask-by-rule)/临时工(task/deny)三档幂等种子。API：`/permission-changes` CRUD、`/projects/:id/audit-log`、`/permission-templates/seed`。
- **离职交接工作流（批次 C）**：`handover_record` 表（迁移 `20260812010000`），按人整体交接（跨所有项目）。**四阶段**（`handover.ts`）：drafting（系统自动汇总产物清单+审计）→awaiting（用户选接手人）→receiving（逐项目 `transferArtifactsInHandover` 转移 owner）→completed（删任职+归档记忆分区）。`completeHandover` 处理 first_agent 转移（防 FK 冲突）。**连环交接**：previous_handover_id 链表追溯，但 owner 始终单一指针（A→B→C 最终 owner=C）。`offboardEmployee` 创建交接入口。产物留项目原路径（检索不遗漏），owner 指针指向接手人。Agent Home 记忆分区归档到 archive/{companyId}-{date}/。API：`/handover` CRUD + assign/receive/transfer/complete、`/companies/:id/employees/:id/offboard`。
- **凭据库（平台级基本能力）**：所有 API/CLI 接入的凭据凌驾于公司之上，统一管理。启动时 `seedDefaultCredentialDefinitions()` 幂等注入 LLM 默认凭据定义（Anthropic/OpenAI/Google 三家，`credential_definition` 表）；后台可设默认派发项；创建公司时 `dispatchDefaultCredentialsToCompany()` 派发到 `company_credential`。执行时三层解析环境变量名：① 员工级覆盖（Agent Home `profile/credentials.json`，只存变量名不存明文）→ ② 公司级覆盖（`company_credential.override_key`）→ ③ 平台默认（`credential_definition.credential_key`）→ ④ 系统回退（`PROVIDER_DEFAULT_API_KEY_ENV` 或 legacy `agent.executor.apiKeyEnv`）。`engine.ts` 的 `resolveExecutorCredentialForTask()` 统一装配，三个 adapter（Claude/OpenAI/Gemini）无需改动——它们已消费 `ctx.apiKeyEnv`。明文值始终由系统环境变量提供，不进 DB、不进日志、不进迁移。
- **素材区（项目级）**：每个项目有素材库（原料/需求/源文件），三选一导入：link（存路径/URL 引用，不复制文件，源不动）→ moved（copy+unlink 移入，源删除）→ copied（copyFile 复制，源保留）。素材存储在 `{project.rootDir}/materials/_copied/`，路径校验防目录穿越（对照 `resolveArtifactPath`）。`assembleContext` 注入 `# 项目素材` 摘要清单让员工知道可用素材。素材健康检查（link 型本地源文件是否存在）。
- **成品区泛化 + 多媒体**：`ArtifactKind` 从小说专用 12 种枚举泛化为 `NovelArtifactKind | GenericArtifactKind | string`（通用公司可用 video/audio/image/markdown/binary 等）。`artifactTypeDefinitionSchema.format` 扩展 `video|audio`。`publish-queue` 的 `isBinaryPath` 扩展音视频扩展名，video/audio/binary kind 走 `exclusive_lock`（整文件替换，不走三方合并）。ArtifactsPage 前端按格式渲染：image(`<img>`)、video(`<video controls>`)、audio(`<audio controls>`)、pdf(`<iframe>`)。成品画廊聚合查询（`artifactGallery` 按 time/type 分组，`companyArtifactGallery` 跨项目聚合）。

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
| `tools/` | 能力中心工具档案库（能力→实现备选目录，启动扫描入 `tool_registry` 表） |
| `src/server/domain/tool-registry.ts` | 工具档案扫描/CRUD/默认派发（`syncToolRegistry`/`listTools`/`dispatchDefaultToolsToCompany`） |
| `src/server/domain/tool-recommendation.ts` | Task 执行时工具推荐解析 + `# 能力中心` system prompt 段构建 |
| `src/server/api/tools.ts` | 工具档案管理 REST 路由 |
| `src/server/executors/tools/registry.ts` | **RuntimeToolRegistry** — 运行时工具注册表（替代 FILE_TOOLS 硬编码），register/resolve/definitions + 7 内置工具 handler |
| `src/server/executors/tools/mcp/client-pool.ts` | **McpClientPool** — stdio/sse/http 三种 transport 的 MCP 连接池（懒连接/复用/探测/超时/关闭） |
| `src/server/executors/tools/mcp/adapter.ts` | MCP 工具 → RuntimeTool 适配（注册进 registry） |
| `src/server/executors/tool-assembly.ts` | 装配函数：内置工具 + 已启用 MCP 工具 → 合并 RuntimeToolRegistry（pumpThread 调用） |
| `src/shared/plugin.ts` | **Plugin 统一模型**（kind/source/scope/manifest 判别联合） |
| `src/server/domain/plugin-adapter.ts` | Plugin 读侧：skill/tool/bridge 三源包装为 Plugin 只读视图 + parsePluginRow |
| `src/server/domain/plugin-install.ts` | Plugin 写侧：install/remove/upsert + 公司启停 + 健康检查 |
| `src/server/domain/marketplace.ts` | 能力市场检索（local ~/.zcode/skills + github gh search）+ installMarketplaceEntry |
| `src/server/domain/skill-author.ts` | AI 兜底起草 SKILL.md（调 llm-call） |
| `src/server/domain/llm-call.ts` | 平台级 LLM 调用（OpenAI 兼容 fetch，三层凭据解析） |
| `src/server/domain/outsourcing-contract.ts` | **B2B 外包契约**：状态机 CRUD + accept/review/deliver + createOutsourcedTask（跨公司任务唯一入口） |
| `src/server/domain/outsourcing-decision.ts` | **B2B 决策树**：hasInternalCapability / findVendorCompany / runOutsourcingDecisionTree（内部→外包→招聘） |
| `src/server/domain/outsourcing-delivery.ts` | **B2B 交付协调**：onOutsourcedTaskCompleted（承接任务完成→契约 delivered + 临时工 greyed，幂等） |
| `src/server/domain/temp-worker.ts` | **临时工生命周期**：createTempEmployment/convertTempToPermanent/markTempGreyed/reactivateGreyedTemp/dismissTempWorker/findGreyedTempForReuse |
| `src/server/domain/employee-rating.ts` | **员工评级**：calculateRating（多维度加权）/applyRating/adjustRating/recalculateAllRatings |
| `src/server/api/outsourcing.ts` | B2B REST 路由：dispatch（含决策树+选拔链）/ contracts / accept / review / cancel |
| `src/server/api/temp-worker.ts` | 临时工 + 评级 REST 路由：temp/convert/dismiss/reactivate/rating |
| `src/server/domain/permission-delegation.ts` | **权限委托链**：findDirectManager（org 上溯）/createPermissionChangeRequest/approveChangeRequest |
| `src/server/domain/artifact-audit.ts` | **产物审计**：logArtifactChange/listArtifactHistory/listProjectAuditLog |
| `src/server/domain/permission-templates.ts` | **按角色权限模板**：经理/员工/临时工三档幂等种子 |
| `src/server/domain/handover.ts` | **离职交接四阶段**：createHandover/assignReceiver/startReceiving/transferArtifacts/completeHandover |
| `src/server/api/permission-delegation.ts` | 权限委托 + 审计 REST 路由：permission-changes/audit-log/permission-templates |
| `src/server/api/handover.ts` | 离职交接 REST 路由：handover CRUD + assign/receive/transfer/complete |
| `src/server/domain/project-readiness.ts` | **HARD-GATE**：assertCanTransition + transitionProjectPhase + assertProjectActive（派工闸门） |
| `src/server/domain/project-onboarding.ts` | readiness 读写（存 settings.onboarding）+ validatePhaseExit 阶段产物校验 |
| `src/server/domain/project-plan.ts` | PlanVersion CRUD（版本自增+supersede）+ phase history 记录 |
| `src/server/api/plugins.ts` | Plugin CRUD + MCP 连接测试 + 公司启停 + marketplace 检索/安装 + AI 起草路由 |
| `src/client/components/workbench/WorkbenchShell.tsx` | 三栏工作台唯一壳层：顶栏（品牌菜单+栏位开关+面包屑+⌘K 命令面板+主操作）、三栏 grid、抽屉遮罩、WorkbenchGuide |
| `src/client/components/workbench/useWorkbenchPreferences.ts` | 栏位偏好：桌面持久化（localStorage `muster:workbench:{scopeKey}`）+ 移动 ephemeral 抽屉状态解耦；`normalizeWorkbenchPreferencesForWidth` 只在 ≥1180px 收起被挤压栏 |
| `src/client/components/workbench/ProjectWorkNavigation.tsx` | 项目左栏：正在进行/需要处理/团队与沟通/固定入口+更多（按工作状态组织，非系统模块） |
| `src/client/components/workbench/CompanyWorkNavigation.tsx` | 公司左栏：日常工作/团队与沟通/固定入口 |
| `src/client/components/workbench/ProjectContextInspector.tsx` | 项目右栏：当前对象摘要（联系人/任务/运行/待处理 + 折叠协作设置） |
| `src/client/components/workbench/CompanyContextInspector.tsx` | 公司右栏：当前公司摘要 + 团队现场 SeatWall 折叠 |
| `src/client/components/workbench/WorkbenchContextSwitcher.tsx` | 面包屑切换器：公司/项目/当前对象（不承载完整功能目录） |
| `src/client/components/workbench/ProjectToolPageShell.tsx` | 项目工具页（tasks/plans/dashboard/artifacts/...）复用同一三栏壳，不重新出现全局顶栏 |
| `src/client/components/company/CompanyAttention.tsx` | 公司"需要处理"视图（`?view=attention`）：聚合审批/配置缺口/项目关注/风险/下一步 |
| `src/client/components/workbench/WorkbenchGuide.tsx` | 一次性三步引导（选择工作/完成工作/查看现场） |
| `src/client/components/project/ProjectOnboardingWizard.tsx` | 六阶段准备流程 wizard（drafting→researching→equipping→staffing→ready→active，允许回流） |
| `src/client/components/project/phases/` | 5 个阶段表单组件（DraftingPhase/ResearchingPhase/EquippingPhase/StaffingPhase/ReadyPhase） |
| `scripts/smoke/capability-platform.mjs` | 能力平台 API 冒烟测试（12 项，覆盖 B1-B5 + transport 关键链路） |
| `docs/superpowers/specs/2026-07-26-capability-platform-design.md` | 能力与流程平台总架构 spec（4 子系统 A/B/C/D + 6 批次 B1-B6） |
| `src/server/domain/credential-store.ts` | 凭据库（平台级）：三层解析 + CRUD + seed + 公司派发 |
| `src/server/api/credentials.ts` | 凭据库管理 REST 路由（平台级 + 公司级） |
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

- Vitest 单元与集成测试覆盖运行闭环、workspace 引导、全局员工档案、跨公司任职、Agent Home、分层记忆、项目任务会话、CLI 探测、审批桥、上下文恢复、复用与安全重置；准确数量以 `npm test` 当前输出为准（当前 100 文件 / 613 测试，含能力平台 B1-B5：RuntimeToolRegistry、Plugin CRUD、MCP client 三种 transport、项目状态机+HARD-GATE、readiness 校验、PlanVersion+熔断、marketplace+AI 起草，以及三栏工作台 shell/导航/inspector/响应式偏好）。
  - 测试环境需要真实 git 仓库作为 `project.rootDir`（`createWorktree` 需要 `git rev-parse HEAD` 成功）。`tests/integration/setup.ts` 的 `makeTempGitRepo()` 创建临时 git 仓库（含初始 commit）供测试使用。
  - `project.rootDir` 与 `firstAgentId` 均为可选：建项目时留空，`createProject` 自动使用当前激活总工作区，并生成 `{workspace}/companies/{公司名}/projects/{项目名}-{项目ID}`；项目 ID 后缀保证同名项目不会共享目录。`ensureGitRepo()` 会在首个 worktree 创建时自动 `mkdir + git init`。
- Playwright 覆盖建司→团队→项目→首 Task、向导式创建完整公司、在线建项目、最近项目恢复、公司上下文导航与工作台信息架构（总览/需要处理/团队/项目）、员工库、执行器中心（折叠式安装引导）、权限中心、窄屏工作台抽屉以及窄屏设置页；准确数量以 `npm run test:e2e` 当前输出为准（当前 4 文件 / 15 测试）。
- `npm run test:claude-smoke` 已使用真实 Claude Code 连续完成两个 Task，验证跨 worktree 的 `--session-id`/`--resume`、文件发布、Artifact 登记和 Token/缓存用量。

`publish_record` 由 `0002_conversation.sql` 创建，记录 Task 发布提交、合并文件、冲突与阻塞状态，供成果修改历史页读取。

### 已知工程取舍
- **工具注册表优先于硬编码**：新增可执行工具（MCP/自定义/AI 生成）一律走 `RuntimeToolRegistry.register()`，不要再扩展 `file-tools.ts` 的 FILE_TOOLS 或 `executeFileTool` switch。`file-tools.ts` 已瘦身为"类型定义 + 工具定义数据"，运行时分发在 `registry.ts` 的 `executeTool`。
- **Plugin 体系是新能力的统一入口**：接入 MCP/skill/tool 都经 `POST /api/plugins` 落库 + `company_plugin` 启停 + `assembleTools` 装配。不要再为单个能力写硬编码 adapter。
- **项目状态机改动需同步三处**：`server/domain/project.ts`（ProjectState 类型）+ `server/db/migrations`（CHECK 约束）+ `client/api/types.ts`（前端字面量）+ `shared/lifecycle-events.ts`（ProjectPhase 内联类型）。漏一处会 typecheck 或运行时失败。
- `noUncheckedIndexedAccess` 关闭（为绕过 express `req.params` 类型摩擦）。代价：数组下标访问不强制 undefined 检查。如需更严格，重开后主要修 `src/shared/utils.ts` 和 domain 的 row 映射。
- Claude Code 的模型可用性由用户本机或代理服务决定。先在“系统设置”填写实际支持的模型标识并运行桥接测试；错误模型会直接返回诊断，不会用 FakeExecutor 冒充成功。
- 当前认证接入包含 Codex CLI、Claude Code、Antigravity CLI、OpenAI-compatible API 和 Gemini API，并完成统一 Manifest/Profile、项目任务会话、审批/Turbo 权限、分层记忆和平台化公司入口。
- OpenCode/Pi 等更多 CLI 需通过同一兼容性门禁后再加入；完整多模态和多租户 SaaS 不属于当前本地成品边界。

### UI 分层约定
- **低门槛优先**：首次主流程固定为“创建公司→组建团队→创建项目→发布 Task”；首屏只提供一个状态相关主行动，rootDir/firstAgentId 后端自动。
- **看板纯前端增强**：DashboardPage 用 `useProjectEvents`/`useStatusBoard`/`useTasks` reduce/`useProjectUsage.byModel` 在客户端做状态分布条、负载柱状图、事件时间线、模型用量拆分；不引入图表库，用 CSS（`.dashboard-*` 类）可视化。新增聚合趋势（吞吐/费用时序）需后端补端点，不属于前端职责。
- **低频配置收口**：项目目录、说明、复盘阈值和讨论预算集中到“项目设置”；项目页仅将线程扩容和脑暴收进协作工具折叠区。员工编辑折叠立场/技能/权限/执行器；系统设置首屏只显示默认执行器、连接测试与保存。
- **三栏工作台信息架构（公司页 + 项目页统一）**：`WorkbenchShell` 是唯一壳层，三栏语义固定——左栏"选择工作"、中栏"完成工作"、右栏"查看当前对象状态"。设计规格见 `docs/superpowers/specs/2026-07-13-three-pane-workbench-design.md`。重构后的入口纪律：
  - **左栏按工作状态组织，不按系统模块组织**。项目左栏四组：正在进行（活跃项目任务 + 任务领取清单 + 新建入口）/ 需要处理（阻塞·等待补充·待审批）/ 团队与沟通（项目群聊 + 第一负责人 + 部门员工树）/ 固定入口（运行概览·成果·**更多**）。公司左栏三组：日常工作（总览·项目·需要处理）/ 团队与沟通（团队·沟通活动）/ 固定入口（更多设置）。低频工具（计划·素材·复盘·用量·人物关系·设置）收入单层**更多**（`work-nav-more`，内联展开列表，**不**做 popover——左栏 `overflow:auto` 会裁剪绝对定位弹出层）。
  - **右栏是对象摘要不是运营仪表盘**。`ProjectContextInspector`/`CompanyContextInspector` 统一为：当前对象 + 状态 + 1~3 关键指标 + 一个主行动 + 紧急待处理直显 + 折叠的协作/设置/团队现场。空状态不显示空告警卡。
  - **中栏只突出一条主线**：项目任务工作面 = 任务标题+状态+目标 → 制作前提 → 工作单 Composer → 高级协作折叠。有活跃任务时"新建项目任务"默认收起。员工工作面统计卡收敛为 3 项。
  - **顶部工具栏唯一**：品牌入口是全局菜单（首页·公司·员工库·执行器·权限·审批·设置），`WorkbenchContextSwitcher` 只切公司/项目/当前对象，不再承载完整功能目录。`⌘K` 是可搜索命令面板（`WorkbenchShell` 接 `commandOptions` prop，按 group 分组，公司页/项目页/工具页各传入上下文相关选项）。
  - **响应式分层**：`useWorkbenchPreferences` 区分**桌面栏位**（持久化到 localStorage `muster:workbench:{scopeKey}`，`normalizeWorkbenchPreferencesForWidth` 只在 ≥1180px 收起被挤压的栏）和**移动抽屉**（<1180px 的 ephemeral `drawers` 状态，不持久化、互斥单开、遮罩+Escape 关闭）。两者解耦是为了：窄屏 toggle 抽屉不被 normalize 立即覆盖，回到桌面时桌面偏好完整恢复。
  - **新增公司"需要处理"视图**：`CompanyAttention`（`?view=attention`）聚合权限审批、员工配置缺口、项目关注、风险和下一步行动，是 `CompanySectionKey` 的第六个值。
- **工作流与计划边界**：员工上下级、引用许可、步骤条件与任务交接格式属于公司级配置，项目暂不覆盖公司工作流；项目只配置计划任务、任务领取清单和运行状态。所有项目工具页复用同一个三栏外壳，子工具页不得重新出现全局顶栏。
- **模板优先创建**：员工库默认先展示与四类公司模板对应的整套团队，再展示单岗位快捷模板，空白自定义表单只作为低频入口；公司创建继续以模板向导为主入口。
- **Schema 驱动公司蓝图**：行业模板必须输出 `CompanyTemplateDraft` 结构化数据并通过服务端确定性校验；客户端只用受信任 React 模块渲染，不接收或执行模型 HTML。创建必须经过“生成蓝图→六模块确认→运行配置→创建”，不可恢复一键绕过确认。
- **Skill 绑定与加载边界**：系统级 `company-template-architect` 只生成公司草案，不生成或审核新 Skill。业务 Skill 绑定到员工、字段或 Task，并只在 Task 明确 Skill、能力或知识目标命中时加载；缺失项进入诊断，禁止执行时搜索或自动安装外部 Skill。
- **模板运行健康**：公司模板安装必须保存确认快照与版本。字段负责人、能力绑定、Skill 和计划目标的运行问题使用稳定 fingerprint 去重，向用户解释原因、影响、建议与配置入口；修复不得静默覆盖用户调整。
- **内联 style**：历史代码大量 `style={{...}}`，新增复杂区块优先抽 `.details-collapse` 等语义类进 `global.css`；简单 grid/gap 保留内联可接受。
- **工作台改动约束**：
  - 改三栏布局/栏宽/折叠阈值，同步三处：`global.css` 的 `--work-left`/`--work-right`/`--work-surface-min` + `useWorkbenchPreferences.ts` 的 `normalizeWorkbenchPreferencesForWidth`/`MIN_WORKBENCH_SURFACE_WIDTH` + 响应式断点（1179px/819px）。桌面栏位收起只由 normalize 决定，移动抽屉开关只由 ephemeral `drawers` 状态决定——两者不可交叉干预，否则窄屏 toggle 会被立即覆盖。
  - 左栏"更多"用内联展开列表（`work-nav-more-list`），**不要**用 `position:absolute` popover——左栏 `overflow:auto` 会裁剪。
  - `⌘K` 命令面板选项经 `WorkbenchShell` 的 `commandOptions` prop 注入，按 `group` 分组渲染；公司页/项目页/`ProjectToolPageShell` 各自传入上下文相关选项，全局选项（首页/公司/员工库/执行器/权限/审批/设置）由 shell 自动追加。
  - 工作台相关测试：`workbench-shell.spec.tsx`（壳层/抽屉/命令面板）、`workbench-preferences.spec.ts`（偏好 normalize/toggle 语义）、`project-workbench.spec.tsx`（左栏导航）、`project-context-layout.spec.tsx`（任务工作面+右栏）、`company-page-layout.spec.tsx`（公司导航）。改左栏分组/文案/视图时同步这些测试。
  - 改产品流程（如项目创建后是否直接进工作台 vs onboarding wizard）会连锁影响 E2E：`smoke.spec.ts`、`regression.spec.ts`、`product-completion.spec.ts` 假设了特定入口路径，流程变更后需同步断言。

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
