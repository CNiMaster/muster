# Muster Agent Company Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 Muster 改造成可持续运行、不会错派 Task 或丢失成果，并完整跑通长篇小说公司的本地单用户 Agent 公司工作台。

**Architecture:** 保留 React、Express、SQLite、Claude Code 和 Git worktree 外壳，新增 Project Runtime Coordinator 统一驱动生命周期。TaskEngine 只负责单线程执行，所有完成副作用经统一 Finalizer 处理，成果发布成功后才能把 Task 标记完成。

**Tech Stack:** Node.js 22.12+、TypeScript、Express 5、React 19、SQLite/better-sqlite3、Claude Code CLI、Git worktree、Vitest、Playwright。

> **执行结果（2026-07-05）：** Tasks 1–8 与 Task 9 的代码、文档和验证均已完成。最终证据为 typecheck 通过、Vitest 123/123、生产构建通过、Playwright 5/5，以及真实 Claude Code 两轮 Task 冒烟通过。真实冒烟期间发现并修复了 session 随 cwd 存储导致跨 worktree 无法 `--resume` 的问题。下方复选框是实施时的 TDD 操作脚本，不再作为当前状态源；当前范围以实施清单顶部的验收记录为准。

## Global Constraints

- `CLAUDE.md` 是唯一项目指令源。
- 所有生产代码修改必须先有能正确失败的测试。
- 不得在 worktree 创建或发布失败时降级写正式项目目录。
- Task 只能由指定员工或该员工的镜像线程领取。
- SQLite 是运行状态权威源，项目文件由 Git 管理。
- 上班期间正式组织配置只读；镜像扩缩容是唯一例外。
- 本轮范围是本地单用户长篇小说 MVP，不加入多租户、支付或云端沙盒。

---

### Task 1: 固化接手基线与核心回归测试

**Files:**
- Modify: `tests/integration/task-engine.spec.ts`
- Modify: `tests/integration/engine-wiring.spec.ts`
- Create: `tests/integration/runtime-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `claimNextTask(db, threadId, assigneeAgentId)`、`TaskEngine.pumpThread()`
- Produces: 后续任务必须保持通过的核心不变量测试。

- [ ] **Step 1: 增加错领 Task 回归测试**

测试创建 A、B 两名员工，只给 B 派 Task，让 A 的线程调用 `claimNextTask()`，断言返回 `null` 且 Task 负责人仍为 B。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/integration/task-engine.spec.ts`

Expected: 新测试因 A 错误领取 B 的 Task 而失败。

- [ ] **Step 3: 增加线程自动建立、发布冲突状态和 worktree 失败测试**

测试分别断言：

- 小说项目上班后具有全部基础岗位 primary thread。
- 发布冲突后 Task 为 `blocked` 而非 `completed`。
- worktree 创建失败时执行器不在正式根目录运行。

- [ ] **Step 4: 运行新增测试并记录红灯**

Run: `npx vitest run tests/integration/task-engine.spec.ts tests/integration/engine-wiring.spec.ts tests/integration/runtime-lifecycle.spec.ts`

Expected: 三类未实现行为均失败。

- [ ] **Step 5: 提交测试基线**

```bash
git add tests/integration/task-engine.spec.ts tests/integration/engine-wiring.spec.ts tests/integration/runtime-lifecycle.spec.ts
git commit -m "test: capture agent company runtime invariants"
```

### Task 2: 修复 Task 归属、项目线程与生命周期

**Files:**
- Modify: `src/server/domain/task.ts`
- Modify: `src/server/domain/thread.ts`
- Modify: `src/server/domain/project.ts`
- Modify: `src/server/domain/company.ts`
- Modify: `src/server/api/companies.ts`
- Modify: `src/server/api/projects.ts`
- Modify: `src/server/task-engine/engine.ts`
- Test: `tests/integration/task-engine.spec.ts`
- Test: `tests/integration/runtime-lifecycle.spec.ts`

**Interfaces:**
- Produces: `ensureProjectThreads(db, projectId): ProjectAgentThread[]`
- Produces: `requestClockOut(db, companyId): Company`
- Produces: `settleDrainingCompanies(db): string[]`

- [ ] **Step 1: 限制原子领取候选**

在领取 SQL 中加入：

```sql
AND (
  t.assignee_agent_id = ?
  OR (
    t.assignee_agent_id IS NULL
    AND ? = (SELECT first_agent_id FROM project WHERE id = t.project_id)
  )
)
```

移除 `assignee_agent_id=COALESCE(?, assignee_agent_id)`，领取只设置线程和租约。

- [ ] **Step 2: 验证 Task 归属测试转绿**

Run: `npx vitest run tests/integration/task-engine.spec.ts`

Expected: A 不能领取 B 的任务；primary 与 mirror 仍可原子领取同一员工的不同任务。

- [ ] **Step 3: 实现项目负责人继承和线程建立**

`createProject()` 在未传负责人时继承公司第一负责人，并校验负责人属于同公司。`ensureProjectThreads()` 为公司所有有效员工创建 primary thread，小说项目至少包含基础五岗位。

- [ ] **Step 4: 把线程建立接到上班和项目创建**

`clock-in` API 在状态变更前执行公司健康检查，状态变更后为未归档项目建立线程。小说项目创建后立即建立线程，使初始 Task 在公司再次上班后可运行。

- [ ] **Step 5: 维护真实线程状态**

TaskEngine 在领取后设置 `running`，等待输入或依赖时设置 `waiting`，完成后设置 `idle`，异常时设置 `failed`。镜像删除接口拒绝删除存在 `claimed|running` Task 的线程。

- [ ] **Step 6: 实现安全排空**

`clock-out` 把在线公司置为 `draining`；协调器检测无运行 Task 后转 `off`。`draining` 不领取新 Task。

- [ ] **Step 7: 运行生命周期测试**

Run: `npx vitest run tests/integration/company.spec.ts tests/integration/project.spec.ts tests/integration/runtime-lifecycle.spec.ts`

Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add src/server/domain/task.ts src/server/domain/thread.ts src/server/domain/project.ts src/server/domain/company.ts src/server/api/companies.ts src/server/api/projects.ts src/server/task-engine/engine.ts tests/integration
git commit -m "fix: enforce task ownership and project lifecycle"
```

### Task 3: 重构安全成果发布与 Task 完成顺序

**Files:**
- Modify: `src/server/worktree/manager.ts`
- Modify: `src/server/worktree/publish-queue.ts`
- Create: `src/server/task-engine/finalizer.ts`
- Modify: `src/server/task-engine/engine.ts`
- Modify: `src/server/domain/task.ts`
- Modify: `src/server/domain/artifact.ts`
- Create: `src/server/db/migrations/0005_runtime_finalization.sql`
- Test: `tests/integration/worktree.spec.ts`
- Test: `tests/integration/engine-wiring.spec.ts`

**Interfaces:**
- Produces: `finalizeRun(db, input): FinalizeResult`
- Produces: `blockTask(db, taskId, summary, checkpoint?): Task`
- Produces: 幂等 Artifact upsert 与发布记录。

- [ ] **Step 1: 增加发布失败和成果登记测试**

断言缺失声明文件、路径逃逸、Git 失败和文本冲突都返回阻塞；成功发布后 Artifact 自动登记并关联创建 Task。

- [ ] **Step 2: 运行验证红灯**

Run: `npx vitest run tests/integration/worktree.spec.ts tests/integration/engine-wiring.spec.ts`

Expected: 缺失文件仍被静默跳过、冲突 Task 仍完成，因此失败。

- [ ] **Step 3: 让 PublishQueue 失败显式化**

- 缺失 source 加入 conflicts 并写原因。
- 删除操作使用 `rmSync()` 并检查结果。
- Git 命令非零立即抛 `WORKTREE_CONFLICT`。
- 回滚只使用 `git revert`；失败保持记录为 blocked，不执行 `reset --hard`。

- [ ] **Step 4: 新增 Task Finalizer**

`finalizeRun()` 顺序固定为：

1. 校验 AgentRunResult。
2. 对 completed 成果执行发布。
3. upsert Artifact。
4. 标记 Task completed。
5. 执行幂等完成副作用。

发布失败调用 `blockTask()`，不得先完成。

- [ ] **Step 5: 禁止 worktree 失败降级**

TaskEngine 创建 worktree 失败时直接 `blockTask()`，不调用执行器。

- [ ] **Step 6: 保存等待状态工作**

若 `waiting_input|waiting_dependency` 结果包含文件变化，提交 Task 分支并在 migration 新增的 `task_runtime` 表记录 worktree/branch/base commit；恢复时复用。没有变化才清理。

- [ ] **Step 7: 运行发布测试**

Run: `npx vitest run tests/integration/worktree.spec.ts tests/integration/engine-wiring.spec.ts tests/integration/artifacts.spec.ts`

Expected: 全部通过，日志不再出现成功测试中的 `publish: source missing`。

- [ ] **Step 8: 提交**

```bash
git add src/server/worktree src/server/task-engine src/server/domain src/server/db/migrations tests/integration
git commit -m "fix: finalize tasks only after safe artifact publish"
```

### Task 4: 接通上下文、用量、预算和对话反馈

**Files:**
- Modify: `src/server/task-engine/executor.ts`
- Modify: `src/server/executors/claude-code-adapter.ts`
- Modify: `src/server/task-engine/fake-executor.ts`
- Modify: `src/server/executors/context.ts`
- Modify: `src/server/task-engine/finalizer.ts`
- Modify: `src/server/domain/usage.ts`
- Modify: `src/server/domain/conversation.ts`
- Test: `tests/integration/executor.spec.ts`
- Test: `tests/integration/conversation.spec.ts`
- Create: `tests/integration/context-references.spec.ts`

**Interfaces:**
- Produces: `ExecutionResult { result, usage, sessionId }`
- Produces: `loadContextReferences(db, task): ReferencedContext[]`
- Produces: `replyToOriginatingConversation(db, task, summary): void`

- [ ] **Step 1: 写上下文和反馈红灯测试**

测试当前项目 Artifact、授权跨项目文件、父 Task 摘要会进入上下文；未授权跨项目文件被拒绝；用户消息 Task 完成后出现 assistant 回复。

- [ ] **Step 2: 写真实用量归集红灯测试**

FakeExecutor 返回固定 usage，Task 完成后按项目、员工、Task 和模型查询必须得到同样数值；硬预算到达后新运行进入 blocked。

- [ ] **Step 3: 运行红灯**

Run: `npx vitest run tests/integration/executor.spec.ts tests/integration/conversation.spec.ts tests/integration/context-references.spec.ts`

Expected: 引用为空、反馈缺失、用量未写入。

- [ ] **Step 4: 扩展 ExecutionAdapter 返回值**

执行器返回：

```ts
interface ExecutionResult {
  result: AgentRunResult;
  usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    toolCalls: number;
    durationMs: number;
    costUSD: number;
  };
  sessionId?: string;
}
```

- [ ] **Step 5: 实现受限上下文读取**

只读取注册 Artifact 和授权 project reference；单文件最多 64 KiB，总计最多 256 KiB。截断时在输入包写入 `truncated: true` 和原路径。

- [ ] **Step 6: Finalizer 写用量和对话反馈**

先检查预算，再运行；完成后写 `usage_record`。根据用户消息中的 scope 信息写 assistant 消息，并发布 `conversation.message` 实时事件。

- [ ] **Step 7: 运行测试**

Run: `npx vitest run tests/integration/executor.spec.ts tests/integration/conversation.spec.ts tests/integration/context-references.spec.ts`

Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add src/server/task-engine src/server/executors src/server/domain tests/integration
git commit -m "feat: connect context usage budgets and conversation replies"
```

### Task 5: 新增 Project Runtime Coordinator

**Files:**
- Create: `src/server/runtime/coordinator.ts`
- Create: `src/server/runtime/completion-effects.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/domain/report.ts`
- Modify: `src/server/domain/brainstorm.ts`
- Modify: `src/server/domain/task.ts`
- Test: `tests/integration/runtime-lifecycle.spec.ts`
- Create: `tests/integration/runtime-coordinator.spec.ts`

**Interfaces:**
- Produces: `ProjectRuntimeCoordinator.tick(): Promise<RuntimeTickResult>`
- Produces: `ProjectRuntimeCoordinator.pumpProject(projectId): Promise<RuntimeTickResult>`

- [ ] **Step 1: 写协调器红灯测试**

覆盖：恢复租约、补线程、正式 Task 打断讨论、无 Task 自动规划、达到阈值自动复盘、draining 自动 off。

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/integration/runtime-coordinator.spec.ts`

Expected: coordinator 模块不存在而失败。

- [ ] **Step 3: 实现协调器固定顺序**

每次 tick：

1. `recoverExpiredLeases`
2. `ensureProjectThreads`
3. `interruptQueuedBrainstormsWhenFormalWorkExists`
4. `openReportCycle`（达到阈值且无运行 Task）
5. `ensurePlanningTask`
6. `engine.pumpAll`
7. `settleDrainingCompanies`

- [ ] **Step 4: 替换后台与手动 pump**

服务启动只启动 coordinator；`POST /api/projects/:id/pump` 调用 `pumpProject()`。移除直接轮询 TaskEngine 的双入口。

- [ ] **Step 5: 防止自动规划风暴**

已存在 queued/running/waiting/blocked 规划 Task 或项目处于复盘、排空、暂停状态时不得重复生成。

- [ ] **Step 6: 运行协调器与重启测试**

Run: `npx vitest run tests/integration/runtime-coordinator.spec.ts tests/integration/restart-recovery.spec.ts`

Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/server/runtime src/server/server.ts src/server/domain tests/integration
git commit -m "feat: coordinate continuous project runtime"
```

### Task 6: 接通小说事件、成果与派生视图

**Files:**
- Modify: `src/server/domain/novel-template.ts`
- Modify: `src/server/domain/triggers.ts`
- Modify: `src/server/task-engine/finalizer.ts`
- Modify: `src/server/api/projects.ts`
- Modify: `src/client/pages/ArtifactsPage.tsx`
- Test: `tests/integration/novel.spec.ts`
- Test: `tests/integration/mvp-acceptance.spec.ts`

**Interfaces:**
- Produces: `initializeNovelProject(db, projectId): Artifact[]`
- Produces: `emitChapterCompletedOnce(db, taskId, artifacts): string[]`

- [ ] **Step 1: 重写小说 MVP 验收测试**

FakeExecutor 必须在 worktree 实际写 `chapters/001.md`，返回 chapter Artifact；测试验证正文发布、Artifact 登记、人物与情节维护 Task 被派发，不能只验证数组长度。

- [ ] **Step 2: 运行验收红灯**

Run: `npx vitest run tests/integration/novel.spec.ts tests/integration/mvp-acceptance.spec.ts`

Expected: 章节完成事件未自动触发、基础成果未初始化而失败。

- [ ] **Step 3: 初始化小说基础成果**

创建项目时注册并创建 project brief、synopsis、style profile、outline、character sheet、worldbuilding、timeline、foreshadowing 和三种只读视图的初始 Markdown/JSON 文件。

- [ ] **Step 4: 完成章节后幂等触发维护**

Finalizer 检测 `kind=chapter`，以 `taskId + chapter_completed` 唯一事件派发维护 Task。工作包必须包含章节路径、摘要和 Artifact 引用。

- [ ] **Step 5: 让只读视图有可预览内容**

维护 Task 发布只读视图文件后自动登记；UI 按 Markdown/JSON 渲染，不提供编辑按钮。

- [ ] **Step 6: 运行验收**

Run: `npx vitest run tests/integration/novel.spec.ts tests/integration/mvp-acceptance.spec.ts tests/integration/artifacts.spec.ts`

Expected: 无 source missing 警告，章节到资料维护闭环通过。

- [ ] **Step 7: 提交**

```bash
git add src/server/domain src/server/task-engine src/server/api src/client/pages/ArtifactsPage.tsx tests/integration
git commit -m "feat: complete novel artifact and maintenance loop"
```

### Task 7: 让组织、通信和工作流成为有效配置

**Files:**
- Create: `src/server/domain/department.ts`
- Create: `src/server/api/departments.ts`
- Modify: `src/server/domain/graph.ts`
- Modify: `src/server/domain/workflow.ts`
- Modify: `src/server/domain/agent.ts`
- Modify: `src/server/api/graphs.ts`
- Modify: `src/server/server.ts`
- Modify: `src/client/pages/CompanyPage.tsx`
- Modify: `src/client/pages/GraphPage.tsx`
- Modify: `src/client/pages/WorkflowGraphPage.tsx`
- Test: `tests/integration/company.spec.ts`
- Test: `tests/integration/project.spec.ts`
- Test: `tests/integration/workflow.spec.ts`

**Interfaces:**
- Produces: department CRUD。
- Produces: `setCommunicationEdge()` 与 `removeCommunicationEdge()` 原子同步联系权限。
- Produces: `materializeWorkflowTask()` 只执行结构化节点配置。

- [ ] **Step 1: 写部门、通信同步、监察保护测试**

断言部门可在下班时管理、上班时锁定；通信连线后立即允许派发，删除后立即拒绝；监察员工删除被拒绝。

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/integration/company.spec.ts tests/integration/project.spec.ts`

Expected: 部门 API 不存在、通信不同步、监察可删除。

- [ ] **Step 3: 实现部门与监察保护**

department CRUD 校验同公司和组织锁。`deleteAgent()` 对 `isInspector` 抛 `CONFLICT`。

- [ ] **Step 4: 合并通信图与 contactAllow 写入**

新增/删除 communication edge 与 contactAllow 在一个 SQLite 事务完成；组织边不改变通信权限。

- [ ] **Step 5: 定义可执行工作流节点**

节点 `props` 使用：

```ts
interface WorkflowStepProps {
  assigneeAgentId?: string;
  assigneeRole?: string;
  title: string;
  inputProtocol: Record<string, unknown>;
  priority: number;
}
```

保存时验证员工归属、角色存在和边可达。完成一个带 `workflowNodeId` 的 Task 后，按明确边条件创建后继 Task。

- [ ] **Step 6: 更新三个配置页面**

公司页提供部门列表和员工部门选择；通信图直接表示可联系关系；工作流属性面板使用表单编辑责任人、标题、优先级和工作包，不要求用户手写 JSON。

- [ ] **Step 7: 运行测试与构建**

Run: `npx vitest run tests/integration/company.spec.ts tests/integration/project.spec.ts tests/integration/workflow.spec.ts && npm run build`

Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add src/server/domain src/server/api src/server/server.ts src/client tests/integration
git commit -m "feat: make company graphs and workflows operational"
```

### Task 8: 替换伪 AI 向导并完善设置

**Files:**
- Create: `src/server/domain/setup-assistant.ts`
- Create: `src/server/api/setup-assistant.ts`
- Modify: `src/server/server.ts`
- Modify: `src/client/pages/CompanyWizardPage.tsx`
- Modify: `src/client/pages/CompanyPage.tsx`
- Modify: `src/client/pages/ProjectPage.tsx`
- Modify: `src/client/hooks/queries.ts`
- Test: `tests/integration/setup-assistant.spec.ts`
- Test: `tests/e2e/regression.spec.ts`

**Interfaces:**
- Produces: `generateCompanyProposal()`、`generateAgentProposal()`、`generateProjectProposal()`
- Produces: `{ source: 'claude' | 'offline_template', proposal, warning? }`

- [ ] **Step 1: 写向导 API 红灯测试**

使用假生成器验证结构化 proposal；执行器不可用时返回明确 `offline_template` 和 warning，不能返回伪造 AI 成功。

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/integration/setup-assistant.spec.ts`

Expected: API 不存在而失败。

- [ ] **Step 3: 实现结构化生成服务**

服务调用配置的 Claude CLI，限制为无工具、短超时、JSON schema 输出。失败时使用确定性离线模板并标注来源。

- [ ] **Step 4: 替换前端 setTimeout 与关键词模拟**

三个向导通过 React Query mutation 调用服务端；预览始终可修改；离线模板显示说明，不使用“AI 生成成功”文案。

- [ ] **Step 5: 运行测试和 E2E**

Run: `npx vitest run tests/integration/setup-assistant.spec.ts && npm run test:e2e`

Expected: API 与浏览器流程通过。

- [ ] **Step 6: 提交**

```bash
git add src/server/domain/setup-assistant.ts src/server/api/setup-assistant.ts src/server/server.ts src/client tests
git commit -m "feat: replace simulated setup wizards with real proposals"
```

### Task 9: 全链路验收、文档校正与交付

**Files:**
- Modify: `tests/e2e/regression.spec.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `docs/agent-company-implementation-checklist.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Produces: 可重复的最终验收证据。

- [ ] **Step 1: 扩展浏览器验收**

完整场景必须验证：

1. 创建小说公司与项目。
2. 上班后线程自动出现。
3. 初始 Task 被正确员工领取。
4. 第一负责人回复出现在对话窗口。
5. Fake/测试执行器写出的章节可预览。
6. 章节维护 Task 自动产生。
7. 强制复盘停止领取。
8. 用户点击继续后恢复。

- [ ] **Step 2: 运行全量验证**

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
```

Expected: 命令全部退出 0；测试日志没有静默成果缺失、未处理 Promise 或浏览器 page error。

- [ ] **Step 3: 手动 Claude Code 冒烟**

在临时小说项目创建只写一个 Markdown 文件的 Task，验证首次 `--session-id`、后续 `--resume`、Artifact 登记、用量记录和对话反馈。测试失败时不得用假执行器替代结论。

- [ ] **Step 4: 更新文档**

只勾选有自动化或手动证据的 checklist 项。`CLAUDE.md` 删除不实的“全部完成”声明，记录最终命令、已知范围和真实限制。

- [ ] **Step 5: 最终提交**

```bash
git add tests docs CLAUDE.md README.md
git commit -m "docs: record verified agent company completion"
```
