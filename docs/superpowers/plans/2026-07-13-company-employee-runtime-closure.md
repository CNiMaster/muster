# Company Employee Runtime Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将公司与员工模块重构为低门槛驾驶舱和三层员工模型，并补齐代码级运行闭环。

**Architecture:** 保留现有数据库与 API，通过新的聚合 DTO、专用 UI 分区组件、统一招募向导、RunWatchdog 和实时事件契约渐进增强。SessionManager 继续负责上下文健康，RunWatchdog 单独负责进程生命期。

**Tech Stack:** TypeScript, React 19, TanStack Query, Express, SQLite, Vitest, Playwright

## Global Constraints

- 不做真实浏览器或真实 CLI 测试，只进行代码级检查和现有自动化验证。
- 不安装、不登录、不修改用户 CLI 全局配置。
- `.zcode/` 保持未跟踪。
- 新增行为必须先有失败测试。

---

### Task 1: 公司驾驶舱聚合与页面拆分

**Files:**
- Create: `src/client/components/company/CompanyOverview.tsx`
- Create: `src/client/components/company/CompanyTeam.tsx`
- Create: `src/client/components/company/CompanyProjects.tsx`
- Create: `src/client/components/company/CompanyActivity.tsx`
- Create: `src/client/components/company/CompanySettings.tsx`
- Create: `src/client/domain/company-dashboard.ts`
- Modify: `src/client/pages/CompanyPage.tsx`
- Test: `tests/unit/company-dashboard.spec.ts`

**Interfaces:**
- Produces: `deriveCompanyDashboard(input): CompanyDashboardViewModel`

- [ ] 写 `deriveCompanyDashboard` 的失败测试，覆盖待审批、运行项目、岗位缺口与唯一推荐行动。
- [ ] 运行 `npx vitest run tests/unit/company-dashboard.spec.ts` 并确认因模块缺失失败。
- [ ] 实现聚合函数和五个分区组件，把 CompanyPage 降为查询、标签状态和 mutation 编排容器。
- [ ] 重跑单测与 `npm run typecheck`。
- [ ] 提交 `feat: reshape company page as an operating cockpit`。

### Task 2: 平台化公司向导与统一招募

**Files:**
- Create: `src/client/components/agents/RecruitmentWizard.tsx`
- Create: `src/client/domain/company-templates.ts`
- Modify: `src/client/pages/CompanyWizardPage.tsx`
- Modify: `src/client/pages/CompanyPage.tsx`
- Modify: `src/server/domain/setup-assistant.ts`
- Test: `tests/unit/company-templates.spec.ts`
- Test: `tests/integration/setup-assistant.spec.ts`

**Interfaces:**
- Produces: `COMPANY_TEMPLATE_OPTIONS`, `RecruitmentWizardProps`

- [ ] 写失败测试，要求通用、软件研发、内容创作和长篇小说模板都能生成明确岗位建议。
- [ ] 运行目标测试并确认通用模板缺失导致失败。
- [ ] 实现模板选择、四步向导和统一招募入口；保留小说模板但移除小说专属标题。
- [ ] 运行目标测试与类型检查。
- [ ] 提交 `feat: make company setup and recruitment platform-first`。

### Task 3: 员工三层视图与任职健康

**Files:**
- Create: `src/client/components/agents/EmploymentCard.tsx`
- Create: `src/client/domain/employee-health.ts`
- Modify: `src/client/pages/AgentLibraryPage.tsx`
- Modify: `src/client/pages/AgentProfilePage.tsx`
- Modify: `src/server/api/agent-profiles.ts`
- Modify: `src/client/hooks/queries.ts`
- Test: `tests/unit/employee-health.spec.ts`
- Test: `tests/integration/agent-profile.spec.ts`

**Interfaces:**
- Produces: `deriveEmploymentHealth(employment, executor, policy)` and employment health DTO fields.

- [ ] 写失败测试，覆盖未绑定执行器、未联通、未绑定权限和可运行四种状态。
- [ ] 运行目标测试并确认派生函数缺失。
- [ ] 实现档案、任职、项目活动三层展示和带修复入口的任职健康卡。
- [ ] 运行目标测试与类型检查。
- [ ] 提交 `feat: clarify employee identity employment and runtime health`。

### Task 4: 统一 RunWatchdog

**Files:**
- Create: `src/server/task-engine/run-watchdog.ts`
- Modify: `src/server/task-engine/executor.ts`
- Modify: `src/server/task-engine/engine.ts`
- Modify: CLI/API adapters only where activity callbacks are required.
- Test: `tests/unit/run-watchdog.spec.ts`
- Test: `tests/integration/task-engine-watchdog.spec.ts`

**Interfaces:**
- Produces: `RunWatchdog`, `RunWatchdogTimeout`, `ExecutionContext.reportActivity()`.

- [ ] 写失败测试，使用可控时钟验证启动超时、空闲超时、总时长、连续网络错误和正常结束清理。
- [ ] 运行目标测试并确认模块缺失。
- [ ] 实现 Watchdog 并接入 TaskEngine，超时后中止执行器并记录分类错误。
- [ ] 运行目标测试、引擎集成测试和类型检查。
- [ ] 提交 `feat: enforce bounded executor run lifecycle`。

### Task 5: 审批、会话与实时事件代码闭环

**Files:**
- Modify: `src/server/domain/approval-broker.ts`
- Modify: `src/server/executors/codex-cli-adapter.ts`
- Modify: `src/server/executors/claude-permission-bridge.ts`
- Modify: `src/server/executors/antigravity-permission-bridge.ts`
- Modify: `src/server/realtime.ts`
- Modify: `src/client/realtime.ts`
- Test: `tests/integration/cli-permission-bridge.spec.ts`
- Test: `tests/integration/codex-app-server.spec.ts`
- Test: `tests/unit/realtime.spec.ts`

**Interfaces:**
- Produces: approval/session lifecycle realtime event types and exact query invalidation mapping.

- [ ] 写失败测试，覆盖桥断开安全拒绝、审批后唤醒、Codex resume/compact、临时 Hook 清理和线程换代事件。
- [ ] 运行目标测试并确认缺少事件或清理行为导致失败。
- [ ] 实现持久化恢复、事件发布和前端精确失效。
- [ ] 运行目标测试与类型检查。
- [ ] 提交 `feat: close approval session and realtime lifecycle`。

### Task 6: 文档同步与完整验收

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/agent-company-implementation-checklist.md`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-5 的最终 UI 文案与运行能力。

- [ ] 更新过期的执行器、审批、项目任务、公司与员工架构说明及真实测试数量。
- [ ] 添加公司驾驶舱、平台向导、员工任职健康的静态 E2E/组件选择器覆盖，不触发真实 CLI。
- [ ] 依次运行 `npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e`、`git diff --check`。
- [ ] 检查 `git status --short`，确认仅预期文件和未跟踪 `.zcode/`。
- [ ] 提交 `docs: align company employee and runtime closure`。
