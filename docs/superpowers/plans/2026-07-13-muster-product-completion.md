# Muster Product Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前“基础能力可用但入口复杂、状态不真实、闭环不完整”的 Muster 收敛为可创建公司、组建团队、绑定执行器、创建项目任务并持续运行的本地多 Agent 公司工作台成品。

**Architecture:** 先建立公司驾驶舱、员工运行状态和执行器健康三个后端事实源，再重构公司与员工页面；公司创建通过可预览的 Setup Draft 和单事务提交完成。运行层以统一 Watchdog、SessionManager 和强类型生命周期事件连接审批、会话恢复与前端实时刷新，禁止前端用硬编码或推测状态冒充后端事实。

**Tech Stack:** TypeScript 5.7, React 19, TanStack Query 5, Express 5, SQLite/better-sqlite3, WebSocket, Vitest, Playwright

## Global Constraints

- 保留现有 SQLite 数据、项目目录、Agent Home、项目任务和 vendor session；新迁移只能向前追加。
- `.zcode/` 属于用户本地内容，不跟踪、不读取、不修改。
- CLI 使用用户登录 Shell、官方配置和默认模型；Muster 不安装、不登录、不修改 CLI 全局配置。
- 员工任职固定绑定执行器和权限策略；公司在线期间不能静默改变正式组织配置。
- 一个用户项目任务是上下文边界；员工工作单不是新的 vendor session 边界。
- 页面不得根据“存在 Profile”推断“联通成功”；运行准备状态必须来自最近 connection probe、权限策略和公司/项目状态。
- 新行为必须执行 RED → GREEN → REFACTOR；没有观察到预期失败的测试不得算回归覆盖。
- 所有完成声明必须基于新鲜的 `npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e` 和 `git diff --check`。

---

## Current-State Audit

### 已经可复用

- 公司、部门、员工、项目、项目任务、员工工作单、项目任务线程和 vendor session 已持久化。
- Agent Profile 与 Company Employee 已分离；Agent Home、分层记忆、能力复制和记忆重置已存在。
- Codex、Claude、Antigravity、OpenAI-compatible API 和 Gemini API 已有 Manifest/Profile 与探测基础。
- Codex RPC、Claude Hook、Antigravity 临时插件、Permission Policy、ApprovalBroker 和有限会话恢复已有基础实现。
- Task worktree、串行发布、冲突阻塞、用量记录、触发器、复盘和 WebSocket 总线可复用。

### 不能作为成品验收的现状

- `CompanyPage.tsx` 仍为 703 行长页面，没有“概览 / 团队 / 项目 / 活动 / 设置”信息架构。
- 公司驾驶舱把 `waitingApprovals` 写死为 `0`，执行器问题来自旧 `agent.executor.provider` 推测，不是最新探测结果。
- 非小说模板只创建空公司；没有组织建议、执行器检查、员工绑定、首项目和首项目任务。
- 员工页只有档案和任职，没有项目任务线程、上下文健康、最近成果与运行失败。
- 任职卡把“Profile 存在”视为“connected”，未展示探测时间、诊断、权限范围和修复链接。
- 招募入口只是三种表单切换，不是统一的岗位模板和预览确认流程。
- Watchdog 的连续网络错误入口未接执行器，缺少无结果退出和审批等待统一分类。
- 实时事件只覆盖项目任务创建/完成/归档与审批决定；审批创建、等待、超时、压缩、换代和恢复没有完整事件。
- `CLAUDE.md` 已局部更新，但历史清单仍有相互矛盾的“后续范围”和旧测试数量。

---

## Target File Structure

```text
src/shared/lifecycle-events.ts                    # 强类型运行/审批/会话事件契约
src/server/domain/company-cockpit.ts             # 公司驾驶舱唯一聚合事实源
src/server/domain/company-setup.ts               # 模板预览与单事务创建
src/server/domain/employee-runtime.ts            # 员工跨项目运行状态聚合
src/server/domain/executor-health.ts             # Profile + Probe + Policy 健康判定
src/server/task-engine/run-watchdog.ts            # 进程生命期限制与错误分类
src/server/api/company-setup.ts                  # Setup preview/commit API
src/client/components/company/CompanyOverview.tsx
src/client/components/company/CompanyTeam.tsx
src/client/components/company/CompanyProjects.tsx
src/client/components/company/CompanyActivity.tsx
src/client/components/company/CompanySettings.tsx
src/client/components/company/CompanySetupWizard.tsx
src/client/components/agents/RecruitmentWizard.tsx
src/client/components/agents/EmployeeRuntimePanel.tsx
src/client/components/agents/EmploymentCard.tsx
src/client/pages/CompanyPage.tsx                  # 只保留路由、Tab 和查询编排
src/client/pages/CompanyWizardPage.tsx            # 只保留 Setup Wizard 容器
src/client/pages/AgentProfilePage.tsx             # 档案 / 任职 / 项目活动三层
```

---

### Task 1: 建立强类型生命周期事件契约

**Files:**
- Create: `src/shared/lifecycle-events.ts`
- Modify: `src/shared/types.ts`
- Create: `tests/unit/lifecycle-events.spec.ts`

**Interfaces:**
- Produces: `LifecycleEventType`, `LifecycleEventPayloadMap`, `makeLifecycleEvent()`。
- Consumers: Tasks 2、8、9、10 的领域服务与 `src/client/realtime.ts`。

- [x] **Step 1: 写失败测试，固定所有必须事件名称和 payload**

```ts
import { describe, expect, it } from 'vitest';
import { makeLifecycleEvent } from '../../src/shared/lifecycle-events';

describe('lifecycle events', () => {
  it('requires scoped payloads for approval and session lifecycle', () => {
    expect(makeLifecycleEvent('approval.requested', {
      approvalId: 'approval_1', taskId: 'task_1', projectTaskId: 'pt_1', threadId: 'pth_1',
    }, { companyId: 'co_1', projectId: 'pr_1', taskId: 'task_1' })).toMatchObject({
      type: 'approval.requested', projectId: 'pr_1', payload: { approvalId: 'approval_1' },
    });
    expect(makeLifecycleEvent('session.rotated', {
      projectTaskId: 'pt_1', threadId: 'pth_1', previousSessionId: 'old', reason: 'hard-limit',
    }, { companyId: 'co_1', projectId: 'pr_1' })).toMatchObject({ type: 'session.rotated' });
  });
});
```

- [x] **Step 2: 运行测试并确认模块缺失**

Run: `npx vitest run tests/unit/lifecycle-events.spec.ts`

Expected: FAIL，提示 `src/shared/lifecycle-events.ts` 不存在。

- [x] **Step 3: 实现精确事件联合类型**

```ts
export interface LifecycleEventPayloadMap {
  'project-task.created': { projectTaskId: string };
  'project-task.completed': { projectTaskId: string };
  'project-task.archived': { projectTaskId: string };
  'approval.requested': { approvalId: string; taskId: string; projectTaskId: string; threadId: string };
  'approval.decided': { approvalId: string; decision: string; taskId: string };
  'approval.timed-out': { approvalId: string; taskId: string };
  'session.compacted': { projectTaskId: string; threadId: string; sessionId: string };
  'session.rotated': { projectTaskId: string; threadId: string; previousSessionId: string | null; reason: string };
  'session.recovered': { projectTaskId: string; threadId: string; taskId: string; recovery: 'retry' | 'compact' | 'rotate' };
  'run.watchdog-stopped': { runId: string | null; taskId: string; classification: string };
}

export function makeLifecycleEvent<K extends keyof LifecycleEventPayloadMap>(
  type: K,
  payload: LifecycleEventPayloadMap[K],
  scope: { companyId?: string; projectId?: string; taskId?: string },
): RealtimeEvent<LifecycleEventPayloadMap[K]> {
  return { id: shortId('ev_'), type, ...scope, occurredAt: new Date().toISOString(), payload };
}
```

- [x] **Step 4: 运行测试和类型检查**

Run: `npx vitest run tests/unit/lifecycle-events.spec.ts && npm run typecheck`

Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/shared/lifecycle-events.ts src/shared/types.ts tests/unit/lifecycle-events.spec.ts
git commit -m "feat: type runtime lifecycle events"
```

### Task 2: 公司驾驶舱真实聚合接口

**Files:**
- Create: `src/server/domain/company-cockpit.ts`
- Modify: `src/server/api/companies.ts`
- Modify: `src/client/hooks/queries.ts`
- Replace: `src/client/domain/company-dashboard.ts`
- Create: `tests/integration/company-cockpit.spec.ts`

**Interfaces:**
- Produces: `GET /api/companies/:id/cockpit`。
- Produces DTO:

```ts
export interface CompanyCockpitDTO {
  companyId: string;
  companyState: CompanyState;
  employees: { total: number; online: number; blocked: number };
  projects: { total: number; active: number; attention: number };
  approvals: { pending: number };
  roleGaps: Array<{ role: string; reason: string }>;
  risks: Array<{ kind: string; label: string; href: string }>;
  nextAction: { kind: string; label: string; description: string; href: string };
}
```

- [x] **Step 1: 写失败集成测试，证明审批、执行器和岗位缺口来自数据库**

```ts
it('aggregates real approvals, executor health and role gaps', () => {
  const fixture = createCockpitFixture(db, {
    roles: ['lead', 'engineer'], connectedEmployees: ['lead'], pendingApprovals: 1,
  });
  const cockpit = getCompanyCockpit(db, fixture.company.id);
  expect(cockpit.approvals.pending).toBe(1);
  expect(cockpit.employees.blocked).toBe(1);
  expect(cockpit.roleGaps).toEqual([]);
  expect(cockpit.nextAction.kind).toBe('handle-approval');
});
```

- [x] **Step 2: 运行测试并确认 `getCompanyCockpit` 缺失**

Run: `npx vitest run tests/integration/company-cockpit.spec.ts`

Expected: FAIL。

- [x] **Step 3: 实现聚合查询，禁止前端再传 `waitingApprovals: 0`**

```ts
export function getCompanyCockpit(db: DB, companyId: string): CompanyCockpitDTO {
  const company = getCompany(db, companyId);
  const pending = scalar(db, `SELECT COUNT(*) n FROM permission_approval pa
    JOIN company_employee ce ON ce.id=pa.employee_id
    WHERE ce.company_id=? AND pa.status='pending'`, companyId);
  const blocked = scalar(db, `SELECT COUNT(*) n FROM company_employee ce
    LEFT JOIN executor_profile ep ON ep.id=ce.executor_profile_id
    WHERE ce.company_id=? AND (ep.id IS NULL OR ce.permission_policy_id IS NULL)`, companyId);
  return buildCompanyCockpitView({ company, pending, blocked, projects: listProjects(db, companyId), agents: listAgents(db, companyId) });
}
```

- [x] **Step 4: 增加路由和 React Query hook**

```ts
companiesRouter.get('/:id/cockpit', asyncHandler(async (req, res) => {
  res.json(getCompanyCockpit(getDb(), param(req, 'id')));
}));

export function useCompanyCockpit(companyId: string) {
  return useQuery({ queryKey: ['company-cockpit', companyId], queryFn: () => api.get<CompanyCockpitDTO>(`/api/companies/${companyId}/cockpit`) });
}
```

- [x] **Step 5: 运行集成测试、API 测试和类型检查**

Run: `npx vitest run tests/integration/company-cockpit.spec.ts tests/integration/company.spec.ts && npm run typecheck`

Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/server/domain/company-cockpit.ts src/server/api/companies.ts src/client/hooks/queries.ts src/client/domain/company-dashboard.ts tests/integration/company-cockpit.spec.ts
git commit -m "feat: expose truthful company cockpit status"
```

### Task 3: 将公司页真正拆成五个标签

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Create: `tests/unit/setup-dom.ts`
- Create: `src/client/components/company/CompanyTeam.tsx`
- Create: `src/client/components/company/CompanyProjects.tsx`
- Create: `src/client/components/company/CompanyActivity.tsx`
- Create: `src/client/components/company/CompanySettings.tsx`
- Modify: `src/client/components/company/CompanyOverview.tsx`
- Rewrite: `src/client/pages/CompanyPage.tsx`
- Create: `tests/unit/company-page-layout.spec.tsx`

**Interfaces:**
- Consumes: `CompanyCockpitDTO`、现有 agents/departments/projects/events hooks。
- Produces: URL 状态 `?tab=overview|team|projects|activity|settings`。

- [x] **Step 1: 安装组件测试依赖并配置独立 DOM setup**

Run: `npm install -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom`

将 `vitest.config.ts` 的 include 扩展为 `tests/unit/**/*.{test,spec}.{ts,tsx}`，并只对 `tests/unit/**/*.spec.tsx` 使用 `jsdom` 与 `tests/unit/setup-dom.ts`；现有服务端单测继续使用 `node` 环境。

```ts
// tests/unit/setup-dom.ts
import '@testing-library/jest-dom/vitest';
```

- [x] **Step 2: 写失败组件测试，要求默认只渲染概览**

```tsx
it('renders overview only until another tab is selected', () => {
  renderCompanyPage('/companies/co_1?tab=overview');
  expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('推荐下一步')).toBeVisible();
  expect(screen.queryByText('新部门名称')).toBeNull();
  expect(screen.queryByText('公司对话')).toBeNull();
});
```

- [x] **Step 3: 运行测试并确认当前长页面导致失败**

Run: `npx vitest run tests/unit/company-page-layout.spec.tsx`

Expected: FAIL，团队、活动和设置内容同时存在。

- [x] **Step 4: 抽取五个职责单一组件**

```tsx
const items: TabItem[] = [
  { key: 'overview', label: '概览', content: <CompanyOverview company={company} cockpit={cockpit} /> },
  { key: 'team', label: '团队', content: <CompanyTeam company={company} agents={agents} departments={departments} /> },
  { key: 'projects', label: '项目', content: <CompanyProjects company={company} projects={projects} /> },
  { key: 'activity', label: '活动', content: <CompanyActivity company={company} events={events} agents={agents} /> },
  { key: 'settings', label: '设置', content: <CompanySettings company={company} /> },
];
return <Tabs items={items} activeKey={tab} onChange={setTabInSearchParams} />;
```

- [x] **Step 5: 限制 `CompanyPage.tsx` 只做查询和 mutation 编排**

Acceptance: `wc -l src/client/pages/CompanyPage.tsx` 小于 220；任何单个新组件小于 300 行。

- [x] **Step 6: 运行组件测试、类型检查和构建**

Run: `npx vitest run tests/unit/company-page-layout.spec.tsx && npm run typecheck && npm run build`

Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add package.json package-lock.json vitest.config.ts tests/unit/setup-dom.ts src/client/components/company src/client/pages/CompanyPage.tsx tests/unit/company-page-layout.spec.tsx
git commit -m "refactor: split company cockpit into focused tabs"
```

### Task 4: 建立可预览、可一次提交的公司模板平台

**Files:**
- Create: `src/server/domain/company-templates.ts`
- Create: `src/server/domain/company-setup.ts`
- Create: `src/server/api/company-setup.ts`
- Modify: `src/server/server.ts`
- Replace: `src/client/domain/company-templates.ts`
- Create: `tests/integration/company-setup.spec.ts`

**Interfaces:**
- Produces: `POST /api/company-setup/preview`。
- Produces: `POST /api/company-setup/commit`。
- Built-ins: `general`, `software`, `content`, `novel`。

```ts
export interface CompanySetupDraft {
  templateId: CompanyTemplateId;
  name: string;
  goal: string;
  departments: Array<{ key: string; name: string }>;
  employees: Array<{ key: string; name: string; role: string; responsibilities: string; departmentKey: string; isLead: boolean }>;
  project: { name: string; description: string };
  firstProjectTask: { title: string; brief: string };
}
```

- [x] **Step 1: 写失败测试，四个模板都必须产生完整 Draft**

```ts
for (const templateId of ['general', 'software', 'content', 'novel'] as const) {
  it(`${templateId} produces a company, team, project and first project task`, () => {
    const draft = previewCompanySetup({ templateId, name: 'Acme', goal: 'ship useful work' });
    expect(draft.departments.length).toBeGreaterThan(0);
    expect(draft.employees.some((employee) => employee.isLead)).toBe(true);
    expect(draft.project.name).toBeTruthy();
    expect(draft.firstProjectTask.title).toBeTruthy();
  });
}
```

- [x] **Step 2: 运行测试并确认 server 模板模块缺失**

Run: `npx vitest run tests/integration/company-setup.spec.ts`

Expected: FAIL。

- [x] **Step 3: 实现四个内置模板，写作只是一种模板**

```ts
export const BUILTIN_COMPANY_TEMPLATES: Record<CompanyTemplateId, CompanyTemplate> = {
  general: { roles: ['lead', 'specialist', 'reviewer'], departments: ['执行部', '质量部'] },
  software: { roles: ['lead', 'product', 'engineer', 'reviewer'], departments: ['产品部', '工程部', '质量部'] },
  content: { roles: ['lead', 'planner', 'creator', 'editor'], departments: ['策划部', '创作部', '编辑部'] },
  novel: { roles: ['lead', 'writer', 'character', 'plot', 'inspector'], departments: ['创作部', '设定部', '监察部'] },
};
```

- [x] **Step 4: 用 SQLite 单事务提交整套设置**

```ts
export function commitCompanySetup(db: DB, draft: CompanySetupDraft, bindings: SetupBindings): CompanySetupResult {
  return db.transaction(() => {
    const company = createCompany(db, { name: draft.name, kind: draft.templateId, charter: draft.goal });
    const departments = createDraftDepartments(db, company.id, draft.departments);
    const employees = createDraftEmployees(db, company.id, draft.employees, departments, bindings);
    updateCompany(db, company.id, { firstAgentId: employees.find((item) => item.isLead)!.legacyAgentId });
    const project = createProject(db, { companyId: company.id, name: draft.project.name, description: draft.project.description });
    const projectTask = createProjectTask(db, { projectId: project.id, ...draft.firstProjectTask });
    return { company: getCompany(db, company.id), employees, project, projectTask };
  })();
}
```

- [x] **Step 5: 验证任一步失败会完整回滚**

Run: `npx vitest run tests/integration/company-setup.spec.ts -t "rolls back"`

Expected: PASS，company/department/employee/project/project_task 均无残留。

- [x] **Step 6: 提交**

```bash
git add src/server/domain/company-templates.ts src/server/domain/company-setup.ts src/server/api/company-setup.ts src/server/server.ts src/client/domain/company-templates.ts tests/integration/company-setup.spec.ts
git commit -m "feat: create companies from complete setup drafts"
```

### Task 5: 将公司创建向导完成为五步成品流程

**Files:**
- Create: `src/client/components/company/CompanySetupWizard.tsx`
- Create: `src/client/components/company/ExecutorReadinessStep.tsx`
- Rewrite: `src/client/pages/CompanyWizardPage.tsx`
- Modify: `src/client/hooks/queries.ts`
- Create: `tests/unit/company-setup-wizard.spec.tsx`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Task 4 preview/commit API、executor profiles/probes、permission policies。
- Steps: `template → team → executors → project → confirm`。

- [x] **Step 1: 写失败测试，要求五步和阻塞条件完整**

```tsx
it('does not commit until every employee has an executor and permission policy', async () => {
  renderSetupWizard();
  await chooseTemplate('software');
  await expectStep('团队预览');
  await next();
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  await bindEmployee('engineer', 'ep_codex', 'pp_project');
  await bindRemainingEmployees();
  expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
});
```

- [x] **Step 2: 运行测试并确认当前两步小说流程失败**

Run: `npx vitest run tests/unit/company-setup-wizard.spec.tsx`

Expected: FAIL。

- [x] **Step 3: 实现五步状态机和可回退编辑 Draft**

```ts
type SetupStep = 'template' | 'team' | 'executors' | 'project' | 'confirm';
const STEP_ORDER: SetupStep[] = ['template', 'team', 'executors', 'project', 'confirm'];
const canContinue = step !== 'executors' || draft.employees.every((employee) => bindings[employee.key]?.executorProfileId && bindings[employee.key]?.permissionPolicyId);
```

- [x] **Step 4: 执行器步骤展示真实探测状态和修复入口**

Acceptance:
- connected：显示最后成功时间和版本。
- testing：轮询 probe，不阻塞页面其他操作。
- failed：显示脱敏分类与“重新测试”。
- missing：链接到执行器中心官方安装说明。
- 不自动安装、不自动登录、不自动升级。

- [x] **Step 5: 提交成功后直接进入首项目任务**

```ts
const result = await commitSetup.mutateAsync({ draft, bindings });
navigate(`/projects/${result.project.id}?projectTask=${result.projectTask.id}&onboarding=done`);
```

- [x] **Step 6: 运行组件测试、类型检查和 E2E**

Run: `npx vitest run tests/unit/company-setup-wizard.spec.tsx && npm run typecheck && npx playwright test tests/e2e/smoke.spec.ts -g "向导"`

Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add src/client/components/company/CompanySetupWizard.tsx src/client/components/company/ExecutorReadinessStep.tsx src/client/pages/CompanyWizardPage.tsx src/client/hooks/queries.ts tests/unit/company-setup-wizard.spec.tsx tests/e2e/smoke.spec.ts
git commit -m "feat: finish guided company setup flow"
```

### Task 6: 统一员工招募为岗位模板向导

**Files:**
- Create: `src/shared/role-templates.ts`
- Create: `src/client/components/agents/RecruitmentWizard.tsx`
- Modify: `src/client/components/company/CompanyTeam.tsx`
- Modify: `src/server/api/agent-profiles.ts`
- Create: `tests/unit/recruitment-wizard.spec.tsx`
- Create: `tests/integration/recruitment.spec.ts`

**Interfaces:**
- Modes: `reuse-profile`, `new-profile`, `role-template`。
- Produces: 一个 `RecruitmentDraft`，确认后创建或复用 Profile，并创建 Company Employee 任职。

```ts
export interface RecruitmentDraft {
  source: 'reuse-profile' | 'new-profile' | 'role-template';
  profileId?: string;
  displayName: string;
  role: string;
  responsibilities: string;
  capabilities: { skills: string[]; tools: string[] };
  departmentId: string | null;
  executorProfileId: string | null;
  permissionPolicyId: string | null;
}
```

- [x] **Step 1: 写失败测试，三种来源最终都生成同一 Draft**

```tsx
it.each(['reuse-profile', 'new-profile', 'role-template'] as const)('%s produces a reviewable draft', async (source) => {
  renderRecruitmentWizard({ source });
  await completeRecruitmentSource(source);
  expect(screen.getByText('确认任职')).toBeVisible();
  expect(screen.getByLabelText('固定执行器')).toBeVisible();
  expect(screen.getByLabelText('权限范围')).toBeVisible();
});
```

- [x] **Step 2: 运行测试并确认当前分散表单失败**

Run: `npx vitest run tests/unit/recruitment-wizard.spec.tsx`

Expected: FAIL。

- [x] **Step 3: 实现内置岗位模板和统一确认页**

Role templates 至少包含：负责人、产品、工程、研究、内容策划、创作者、编辑、质量审查、运营监察。

- [x] **Step 4: 实现单事务招募 API**

```ts
companyEmployeesRouter.post('/recruit', asyncHandler(async (req, res) => {
  const draft = recruitmentDraftSchema.parse(req.body);
  res.status(201).json(recruitFromDraft(getDb(), param(req, 'companyId'), draft));
}));
```

- [x] **Step 5: 运行组件、集成和现有通信边界测试**

Run: `npx vitest run tests/unit/recruitment-wizard.spec.tsx tests/integration/recruitment.spec.ts tests/integration/trigger-communication.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/shared/role-templates.ts src/client/components/agents/RecruitmentWizard.tsx src/client/components/company/CompanyTeam.tsx src/server/api/agent-profiles.ts tests/unit/recruitment-wizard.spec.tsx tests/integration/recruitment.spec.ts
git commit -m "feat: unify employee recruitment around role drafts"
```

### Task 7: 员工档案、公司任职、项目活动三层闭环

**Files:**
- Create: `src/server/domain/employee-runtime.ts`
- Modify: `src/server/api/agent-profiles.ts`
- Modify: `src/client/hooks/queries.ts`
- Create: `src/client/components/agents/EmployeeRuntimePanel.tsx`
- Modify: `src/client/pages/AgentProfilePage.tsx`
- Create: `tests/integration/employee-runtime.spec.ts`
- Create: `tests/unit/employee-runtime-panel.spec.tsx`

**Interfaces:**
- Produces: `GET /api/agent-profiles/:id/runtime`。

```ts
export interface EmployeeRuntimeDTO {
  profileId: string;
  employments: Array<{
    employmentId: string;
    companyId: string;
    companyName: string;
    projects: Array<{
      projectId: string;
      projectName: string;
      activeProjectTasks: number;
      waitingApprovals: number;
      thread: null | {
        id: string; state: string; runCount: number; transcriptBytes: number;
        compactionCount: number; lastCompactionAt: string | null; lastActivityAt: string;
      };
      recentArtifacts: Array<{ taskId: string; path: string; updatedAt: string }>;
      latestFailure: null | { taskId: string; summary: string; updatedAt: string };
    }>;
  }>;
}
```

- [x] **Step 1: 写失败集成测试，跨公司数据必须隔离**

```ts
it('returns project task threads and artifacts grouped by employment without leaking another profile', () => {
  const runtime = getEmployeeRuntime(db, profileA.id);
  expect(runtime.employments[0].projects[0].thread?.runCount).toBe(3);
  expect(JSON.stringify(runtime)).not.toContain(profileB.id);
});
```

- [x] **Step 2: 运行测试并确认聚合不存在**

Run: `npx vitest run tests/integration/employee-runtime.spec.ts`

Expected: FAIL。

- [x] **Step 3: 实现聚合 endpoint 和 hook**

查询必须通过 `company_employee.profile_id → legacy_agent_id → project_task_thread.employee_id` 关联，并按 company/project 分组。

- [x] **Step 4: 将档案页拆成三个标签**

```tsx
<Tabs items={[
  { key: 'identity', label: '身份与能力', content: <AgentIdentityPanel profile={profile} /> },
  { key: 'employments', label: '公司任职', content: <EmploymentList employments={employments} /> },
  { key: 'runtime', label: '项目工作状态', content: <EmployeeRuntimePanel runtime={runtime} /> },
]} />
```

- [x] **Step 5: 运行集成、组件、类型和构建测试**

Run: `npx vitest run tests/integration/employee-runtime.spec.ts tests/unit/employee-runtime-panel.spec.tsx && npm run typecheck && npm run build`

Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/server/domain/employee-runtime.ts src/server/api/agent-profiles.ts src/client/hooks/queries.ts src/client/components/agents/EmployeeRuntimePanel.tsx src/client/pages/AgentProfilePage.tsx tests/integration/employee-runtime.spec.ts tests/unit/employee-runtime-panel.spec.tsx
git commit -m "feat: show employee work across projects and sessions"
```

### Task 8: 执行器与权限健康使用真实 Probe

**Files:**
- Create: `src/server/domain/executor-health.ts`
- Modify: `src/server/domain/executor-profile.ts`
- Modify: `src/server/api/executors.ts`
- Modify: `src/server/api/agent-profiles.ts`
- Replace: `src/client/domain/employee-health.ts`
- Modify: `src/client/components/agents/EmploymentCard.tsx`
- Create: `tests/integration/executor-health.spec.ts`
- Modify: `tests/unit/employee-health.spec.ts`

**Interfaces:**
- Produces: `ExecutorHealthDTO` attached to every employment。

```ts
export interface ExecutorHealthDTO {
  state: 'ready' | 'testing' | 'blocked' | 'warning';
  executorProfileId: string | null;
  manifestId: string | null;
  probe: null | { status: string; classification: string | null; completedAt: string | null; version: string | null };
  permission: null | { policyId: string; name: string; strategy: string; scope: string };
  reasons: string[];
  remediation: { label: string; href: string } | null;
}
```

- [x] **Step 1: 写失败测试，Profile 存在但 probe 失败不能显示 ready**

```ts
it('does not infer readiness from an executor profile alone', () => {
  const health = getEmploymentHealth(db, employment.id);
  expect(health.executorProfileId).toBe(profile.id);
  expect(health.probe?.status).toBe('failed');
  expect(health.state).toBe('warning');
  expect(health.remediation?.href).toBe(`/executors?profile=${profile.id}`);
});
```

- [x] **Step 2: 运行测试并确认当前错误推断失败**

Run: `npx vitest run tests/integration/executor-health.spec.ts tests/unit/employee-health.spec.ts`

Expected: FAIL。

- [x] **Step 3: 查询最近基础 Probe，并独立呈现指定模型 Probe**

SQL 必须按 `executor_profile_id + kind` 取最新记录；模型 Probe 失败不能把基础联通改成未连接。

- [x] **Step 4: 任职卡展示版本、测试时间、诊断、权限策略和范围**

Acceptance: 用户能在卡片内回答“用哪个执行器、是否联通、最后何时检查、权限多大、为什么不能运行、去哪里修复”。

- [x] **Step 5: 运行专项和探测回归**

Run: `npx vitest run tests/integration/executor-health.spec.ts tests/integration/certified-cli-probe.spec.ts tests/unit/employee-health.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/server/domain/executor-health.ts src/server/domain/executor-profile.ts src/server/api/executors.ts src/server/api/agent-profiles.ts src/client/domain/employee-health.ts src/client/components/agents/EmploymentCard.tsx tests/integration/executor-health.spec.ts tests/unit/employee-health.spec.ts
git commit -m "feat: report real executor and permission health"
```

### Task 9: 完成统一 Watchdog 和错误分类

**Files:**
- Modify: `src/server/task-engine/run-watchdog.ts`
- Modify: `src/server/task-engine/executor.ts`
- Modify: `src/server/task-engine/engine.ts`
- Modify: `src/server/executors/claude-code-adapter.ts`
- Modify: `src/server/executors/codex-cli-adapter.ts`
- Modify: `src/server/executors/antigravity-cli-adapter.ts`
- Modify: API adapters through shared tool-loop callbacks.
- Modify: `tests/unit/run-watchdog.spec.ts`
- Create: `tests/integration/run-watchdog-lifecycle.spec.ts`

**Interfaces:**
- Produces classifications: `startup_timeout`, `idle_timeout`, `max_runtime`, `network_errors`, `empty_result`, `approval_timeout`, `process_exit`。
- `ExecutionContext.reportActivity(kind)` accepts `output | tool | network-success | approval-wait`。

- [x] **Step 1: 写失败测试，覆盖尚未接入的网络、空结果和审批超时**

```ts
it('stops after three consecutive network errors and resets after output', async () => {
  watchdog.networkError();
  watchdog.networkError();
  watchdog.activity('output');
  watchdog.networkError();
  watchdog.networkError();
  watchdog.networkError();
  await expect(watchdog.failure).rejects.toMatchObject({ classification: 'network_errors' });
});

it('classifies a zero-exit process without a result as empty_result', async () => {
  await expect(runAdapterReturningNoResult()).rejects.toMatchObject({ classification: 'empty_result' });
});
```

- [x] **Step 2: 运行 Watchdog 测试并确认缺失分类失败**

Run: `npx vitest run tests/unit/run-watchdog.spec.ts tests/integration/run-watchdog-lifecycle.spec.ts`

Expected: FAIL。

- [x] **Step 3: 让所有 Adapter 上报活动和网络结果**

```ts
events?.onOutput?.(chunk);
ctx.reportActivity?.('output');
// catch network-like error
ctx.reportNetworkError?.(classifyNetworkError(error));
```

- [x] **Step 4: TaskEngine 只建立一个 RunWatchdog，并在所有退出路径 complete**

Acceptance: completed/failed/cancelled/waiting approval/异常抛出均清理计时器；超时调用 AbortController；迟到结果不得回写 Task。

- [x] **Step 5: 发布 `run.watchdog-stopped` 事件并保存 execution_run 失败分类**

若现有 `execution_run` 无诊断列，新增迁移：

`src/server/db/migrations/0026_execution_run_diagnostics.sql`

```sql
ALTER TABLE execution_run ADD COLUMN failure_classification TEXT;
ALTER TABLE execution_run ADD COLUMN failure_message TEXT;
```

- [x] **Step 6: 运行引擎、工具循环和适配器回归**

Run: `npx vitest run tests/unit/run-watchdog.spec.ts tests/integration/run-watchdog-lifecycle.spec.ts tests/integration/engine-wiring.spec.ts tests/integration/batch11-tool-loop.spec.ts`

Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add src/server/task-engine src/server/executors src/server/db/migrations/0026_execution_run_diagnostics.sql tests/unit/run-watchdog.spec.ts tests/integration/run-watchdog-lifecycle.spec.ts
git commit -m "feat: close executor watchdog failure modes"
```

### Task 10: 审批、压缩、换代和恢复实时闭环

**Files:**
- Modify: `src/server/domain/permission.ts`
- Modify: `src/server/domain/approval-broker.ts`
- Modify: `src/server/domain/session-manager.ts`
- Modify: `src/server/task-engine/engine.ts`
- Modify: `src/server/api/permissions.ts`
- Modify: `src/client/realtime.ts`
- Modify: `src/client/pages/PermissionCenterPage.tsx`
- Create: `tests/integration/lifecycle-realtime.spec.ts`
- Modify: `tests/unit/realtime.spec.ts`

**Interfaces:**
- Consumes: Task 1 生命周期事件契约。
- Produces: 审批请求、决定、超时；会话压缩、换代、恢复事件及精确缓存失效。

- [x] **Step 1: 写失败测试，订阅总线并验证完整事件序列**

```ts
it('publishes approval wait, decision, resume and session rotation in order', async () => {
  const events = collectLifecycleEvents(realtime);
  await runTaskRequiringApproval();
  expect(events.map((event) => event.type)).toEqual([
    'approval.requested', 'approval.decided', 'session.recovered', 'session.rotated',
  ]);
});
```

- [x] **Step 2: 运行测试并确认当前只发布审批决定**

Run: `npx vitest run tests/integration/lifecycle-realtime.spec.ts tests/unit/realtime.spec.ts`

Expected: FAIL。

- [x] **Step 3: 在领域动作发生处发布事件，不在 UI 猜测**

```ts
const approval = ensureApprovalRequest(...);
realtime.publish(makeLifecycleEvent('approval.requested', { approvalId: approval.id, taskId: task.id, projectTaskId: task.projectTaskId, threadId }, scope));
```

- [x] **Step 4: 前端精确失效 cockpit、approvals、project tasks、thread detail 和 employee runtime**

```ts
if (event.type.startsWith('approval.')) keys.push(['permission-approvals'], ['company-cockpit', event.companyId]);
if (event.type.startsWith('session.')) keys.push(['project-task', event.projectId, payload.projectTaskId], ['agent-runtime']);
```

- [x] **Step 5: 权限中心显示等待剩余时间、CLI 是否在线和“批准后重新入队”状态**

超时审批必须显示安全拒绝；用户稍后允许时显示工作单已重新排队，而不是假装原进程仍在线。

- [x] **Step 6: 运行审批、SessionManager、CLI Bridge 和实时测试**

Run: `npx vitest run tests/integration/lifecycle-realtime.spec.ts tests/integration/session-manager.spec.ts tests/integration/cli-permission-bridge.spec.ts tests/unit/realtime.spec.ts`

Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add src/server/domain/permission.ts src/server/domain/approval-broker.ts src/server/domain/session-manager.ts src/server/task-engine/engine.ts src/server/api/permissions.ts src/client/realtime.ts src/client/pages/PermissionCenterPage.tsx tests/integration/lifecycle-realtime.spec.ts tests/unit/realtime.spec.ts
git commit -m "feat: stream approval and session lifecycle"
```

### Task 11: 成品级状态说明、错误恢复和无障碍细节

**Files:**
- Create: `src/client/components/StateExplanation.tsx`
- Create: `src/client/components/BlockingIssues.tsx`
- Modify: `src/client/components/Badge.tsx`
- Modify: `src/client/components/company/*.tsx`
- Modify: `src/client/components/agents/*.tsx`
- Modify: `src/client/pages/ProjectPage.tsx`
- Modify: `src/client/pages/ExecutorCenterPage.tsx`
- Create: `tests/unit/state-explanation.spec.tsx`

**Interfaces:**
- Produces: `getStateExplanation(domain, state)`，覆盖 company/employee/project/project-task/thread/probe/approval。

- [x] **Step 1: 写失败测试，所有用户可见状态必须有中文解释和行动**

```ts
it.each([
  ['company', 'draining'], ['employee', 'off'], ['project-task', 'archived'],
  ['thread', 'rotating'], ['probe', 'failed'], ['approval', 'timed-out'],
])('%s.%s has a plain-language explanation', (domain, state) => {
  expect(getStateExplanation(domain, state)).toMatchObject({ title: expect.any(String), description: expect.any(String) });
});
```

- [x] **Step 2: 运行测试并确认集中解释模块缺失**

Run: `npx vitest run tests/unit/state-explanation.spec.tsx`

Expected: FAIL。

- [x] **Step 3: 实现统一说明和 BlockingIssues**

每个阻塞项必须包含：发生了什么、为什么、影响什么、下一步按钮；禁止只显示原始枚举或“操作失败”。

- [x] **Step 4: 修复键盘、焦点和响应式行为**

Acceptance:
- Tabs 支持方向键/Home/End，切换后焦点合理。
- 表单错误通过 `aria-describedby` 关联字段。
- 异步状态使用 `aria-live="polite"`。
- 危险操作确认说明影响范围。
- 390px 宽度无横向溢出。

- [x] **Step 5: 运行组件、类型与构建测试**

Run: `npx vitest run tests/unit/state-explanation.spec.tsx tests/unit/company-page-layout.spec.tsx tests/unit/employee-runtime-panel.spec.tsx && npm run typecheck && npm run build`

Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/client/components/StateExplanation.tsx src/client/components/BlockingIssues.tsx src/client/components/Badge.tsx src/client/components/company src/client/components/agents src/client/pages/ProjectPage.tsx src/client/pages/ExecutorCenterPage.tsx tests/unit/state-explanation.spec.tsx
git commit -m "feat: explain product states and recovery actions"
```

### Task 12: 清理文档矛盾并建立成品验收门禁

**Files:**
- Modify: `CLAUDE.md`
- Rewrite top status sections: `docs/agent-company-implementation-checklist.md`
- Modify: `tests/e2e/smoke.spec.ts`
- Create: `tests/e2e/product-completion.spec.ts`
- Create: `scripts/product-acceptance.ts`

**Interfaces:**
- Produces: `npm run test:product-acceptance`。

- [x] **Step 1: 添加成品验收脚本**

```json
{
  "scripts": {
    "test:product-acceptance": "tsx scripts/product-acceptance.ts"
  }
}
```

脚本必须验证：至少一个内置模板可完整 preview/commit；员工均有执行器和权限；首项目任务可创建工作单；归档后只读；所有健康 DTO 不含凭据值。

- [x] **Step 2: 添加产品全流程 E2E**

```ts
test('通用公司从模板到首项目任务', async ({ page }) => {
  await page.goto('/companies/wizard');
  await completeCompanySetup(page, { template: 'software' });
  await expect(page.getByText('项目任务工作区')).toBeVisible();
  await expect(page.getByText('运行准备正常')).toBeVisible();
});

test('员工档案可查看任职和项目工作状态', async ({ page }) => {
  await page.goto(`/agents/${fixture.profileId}?tab=runtime`);
  await expect(page.getByText(fixture.projectName)).toBeVisible();
  await expect(page.getByText(/Run \d+/)).toBeVisible();
});
```

- [x] **Step 3: 清理文档中所有与当前实现矛盾的后续范围和旧数字**

Run: `rg -n "Codex.*后续|统一审批.*后续|Playwright 10|270 项|190 项|小说.*唯一" CLAUDE.md docs/agent-company-implementation-checklist.md`

Expected: 无过期命中。

- [x] **Step 4: 执行完整门禁**

```bash
npm test
npm run typecheck
npm run build
npm run test:product-acceptance
npm run test:e2e
git diff --check
```

Expected:
- Vitest 0 failed。
- TypeScript 0 errors。
- server/client build exit 0。
- 产品验收脚本 exit 0。
- Playwright 0 failed。
- diff check 无空白错误。

- [x] **Step 5: 按用户要求从本轮验收排除真实 CLI 冒烟**

用户已明确要求仅做代码层面检查。本轮不发起 Codex、Claude 或 Antigravity 的真实模型请求；自动门禁仍完整验证适配器契约、会话恢复、审批桥和失败关闭。

- [x] **Step 6: 检查 Git 范围并提交**

```bash
git status --short
git diff --stat main...HEAD
git add CLAUDE.md docs/agent-company-implementation-checklist.md tests/e2e scripts/product-acceptance.ts package.json
git commit -m "test: gate the complete agent company product flow"
```

Acceptance: `.zcode/` 仍是唯一允许的无关未跟踪目录；没有 `test-results/`、凭据、运行数据库或生成构建产物进入提交。

---

## Delivery Order and Stop Conditions

1. Tasks 1-2 建立真实状态契约；在此之前不继续增加驾驶舱 UI。
2. Tasks 3-5 完成公司入口与完整向导，形成第一个可独立验收纵向闭环。
3. Tasks 6-8 完成员工招募、三层视图和真实健康，形成第二个纵向闭环。
4. Tasks 9-10 完成后台执行、审批和会话事件，形成第三个纵向闭环。
5. Tasks 11-12 做可用性收口和最终门禁。

出现以下任一情况必须停止当前 Task，先修复再继续：

- 前端需要硬编码数量或推测后端状态。
- 新 endpoint 无集成测试或跨公司隔离测试。
- 公司 Setup 不能事务回滚。
- Watchdog 超时后执行器迟到结果仍能写库。
- 审批超时后仍有隐藏 CLI 进程等待。
- 新项目任务复用了归档项目任务的 vendor session。
- 任职健康 DTO 暴露凭据值或原始授权头。

## Definition of Done

只有同时满足以下条件才可以称为“成品闭环完成”：

- 新用户能从四种模板之一完成公司、团队、执行器/权限、项目和首项目任务创建。
- 第二次打开能进入最近项目，不重新触发公司创建向导。
- 公司页默认只显示驾驶舱概览，四类复杂内容通过标签进入。
- 员工页清楚区分稳定档案、公司任职和项目工作状态。
- 所有“不能运行”状态都有真实数据、原因、影响和修复入口。
- CLI 运行受统一 Watchdog、审批失败关闭和有限会话恢复保护。
- 审批与会话生命周期在 UI 中实时可见，刷新后仍能从持久化状态恢复。
- 完整自动化门禁全部通过；如环境缺少 Playwright 浏览器，不得声称 E2E 通过。
- 文档、测试数量、架构描述和代码现状一致。
