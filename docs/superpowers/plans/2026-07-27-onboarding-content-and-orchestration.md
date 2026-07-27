# 项目准备内容 + 编排（B4+B5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B4 把 B2 的空 wizard 五阶段填上真实表单（drafting/researching/equipping/staffing/ready）+ 后端 readiness 校验；B5 加 PlanVersion 追溯、任务 3 次失败熔断回流、lifecycle 驱动前端 stepper 刷新。

**Architecture:** readiness 存 `project.settings.onboarding`（命名空间隔离）；新增 `validatePhaseExit` 在 transitionProjectPhase 内做阶段产物校验；equipping 阶段消费 B3 的 plugin 启用（新建前端 hooks + 后端补 company.state 校验）；staffing 用 `ensurePrimaryThread` 精确分配员工；B5 新增 `project_plan` + `project_phase_history` 表 + task.failure_count 列，failTask 自增计数，≥3 触发 transitionProjectPhase 回流。

**Tech Stack:** TypeScript + better-sqlite3 + zod；React + React Query

**Spec:** `docs/superpowers/specs/2026-07-26-capability-platform-design.md` C.2/C.3 + D.2/D.3

**前置完成：** B1（Plugin 模型）、B2（状态机+wizard 骨架）、B3（MCP+CRUD+marketplace）

---

## File Structure

**Create:**
- `src/server/domain/project-onboarding.ts` — readiness 读写 + validatePhaseExit
- `src/server/domain/project-plan.ts` — PlanVersion + phase history CRUD（B5）
- `src/server/db/migrations/20260727100000_task_failure_count.sql` — task 加 failure_count（B5）
- `src/server/db/migrations/20260727110000_project_plan_and_phase_history.sql` — B5 两表
- `src/client/components/project/phases/DraftingPhase.tsx` — drafting 表单
- `src/client/components/project/phases/ResearchingPhase.tsx` — researching 表单
- `src/client/components/project/phases/EquippingPhase.tsx` — plugin 启用列表
- `src/client/components/project/phases/StaffingPhase.tsx` — 员工分配
- `src/client/components/project/phases/ReadyPhase.tsx` — 就绪检查 + 确认开工
- `tests/integration/project-onboarding.spec.ts` — readiness 校验
- `tests/integration/project-plan.spec.ts` — PlanVersion + 熔断（B5）

**Modify:**
- `src/server/domain/project-readiness.ts` — transitionProjectPhase 加 validatePhaseExit 调用
- `src/server/domain/task.ts` — failTask 自增 failure_count
- `src/server/domain/plugin-install.ts` — （无改，company.state 校验在 API）
- `src/server/api/plugins.ts` — enable/disable 加 company.state === 'off' 校验
- `src/server/api/projects.ts` — 加 staff 路由 + PATCH 发布 phase-exited/readiness-passed
- `src/server/task-engine/engine.ts` — failTask 后检查熔断，tripped 则回流
- `src/client/hooks/queries.ts` — usePlugins/useEnabledCompanyPlugins/useToggleCompanyPlugin/useStaffProject
- `src/client/components/project/ProjectOnboardingWizard.tsx` — 替换空占位为五阶段分发
- `src/client/realtime.ts` — project.* 事件 invalidate project query
- `src/shared/constants.ts` — TASK_CIRCUIT_BREAKER_THRESHOLD = 3

---

## Task 1: readiness 后端读写 + validatePhaseExit

**Files:**
- Create: `src/server/domain/project-onboarding.ts`
- Modify: `src/server/domain/project-readiness.ts`

- [ ] **Step 1: 写 project-onboarding.ts（readiness 读写 + validatePhaseExit）**

创建 `src/server/domain/project-onboarding.ts`：

```typescript
/**
 * 项目准备流程内容（B4）。
 *
 * readiness 存 project.settings.onboarding（命名空间隔离，避免与
 * milestoneReviewAt/dailyDiscussionBudgetUSD 等现有 key 碰撞）。
 *
 * validatePhaseExit 在 transitionProjectPhase 内调用，校验向前跃迁的阶段产物。
 * 回流（toIdx < fromIdx）不校验，全允许（spec C.3 回流机制）。
 */
import type { DB } from '../db/client';
import { getProject, updateProject, type ProjectState } from './project';
import { projectReadinessSchema, emptyProjectReadiness, type ProjectReadiness } from '../../shared/project-readiness';
import { AppError, ErrorCode } from '../../shared/errors';

const ONBOARDING_KEY = 'onboarding';

/** 读取 project.settings.onboarding，容错解析为 ProjectReadiness。 */
export function getProjectReadiness(db: DB, projectId: string): ProjectReadiness {
  const project = getProject(db, projectId);
  const raw = (project.settings as Record<string, unknown>)?.[ONBOARDING_KEY];
  const parsed = projectReadinessSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyProjectReadiness();
}

/**
 * 写 readiness（合并到 settings.onboarding，保留其他 settings key）。
 * 注意：updateProject 的 settings 是整体覆盖，所以要先 {...cur, onboarding: next}。
 */
export function setProjectReadiness(db: DB, projectId: string, readiness: ProjectReadiness): ProjectReadiness {
  const project = getProject(db, projectId);
  const validated = projectReadinessSchema.parse(readiness);
  const nextSettings = { ...(project.settings as Record<string, unknown>), [ONBOARDING_KEY]: validated };
  updateProject(db, projectId, { settings: nextSettings });
  return validated;
}

/**
 * 校验向前阶段跃迁的产物完整性（回流不校验）。
 * 在 transitionProjectPhase 内、assertCanTransition 之后调用。
 */
export function validatePhaseExit(db: DB, projectId: string, from: ProjectState, to: ProjectState): void {
  // 回流不校验
  const order = ['drafting', 'researching', 'equipping', 'staffing', 'ready', 'active'];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) return; // 回流或非准备阶段，全允许

  const r = getProjectReadiness(db, projectId);
  const gap = (label: string, detail: string): never => {
    throw new AppError(ErrorCode.VALIDATION, `阶段校验未通过（${label}）：${detail}`);
  };

  switch (`${from}->${to}`) {
    case 'drafting->researching':
      if (!r.draft.goal.trim()) gap('构思', '请先填写项目目标');
      return;
    case 'researching->equipping':
      if (!r.research.summary.trim()) gap('调研', '请先填写调研摘要');
      if (r.research.candidateSkills.length === 0 && r.research.candidateTools.length === 0) {
        gap('调研', '请至少选定一个候选能力（skill 或 tool）');
      }
      return;
    case 'equipping->staffing':
      if (r.equipment.enabledPlugins.length === 0) {
        gap('装备', '请至少启用一个能力（plugin）');
      }
      return;
    case 'staffing->ready':
      if (r.staffing.employeeIds.length === 0) gap('员工', '请至少分配一名员工到项目');
      return;
    case 'ready->active':
      // 全量复检
      if (!r.draft.goal.trim()) gap('就绪', '构思阶段缺少目标');
      if (!r.research.summary.trim()) gap('就绪', '调研阶段缺少摘要');
      if (r.equipment.enabledPlugins.length === 0) gap('就绪', '装备阶段未启用能力');
      if (r.staffing.employeeIds.length === 0) gap('就绪', '员工阶段未分配员工');
      return;
    default:
      return;
  }
}
```

- [ ] **Step 2: transitionProjectPhase 调 validatePhaseExit**

Modify `src/server/domain/project-readiness.ts` 的 `transitionProjectPhase`：

在 `assertCanTransition(previousState, target)` 之后加 `validatePhaseExit(db, projectId, previousState, target)`。顶部 import 加 `import { validatePhaseExit } from './project-onboarding';`。

- [ ] **Step 3: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/domain/project-onboarding.ts src/server/domain/project-readiness.ts
git commit -m "feat(project): B4 — readiness read/write + validatePhaseExit for forward transitions"
```

---

## Task 2: plugin enable/disable 补 company.state 校验

**Files:**
- Modify: `src/server/api/plugins.ts`

- [ ] **Step 1: enable/disable 路由加 company.state 校验**

Modify `src/server/api/plugins.ts` 的 enable/disable 路由，在 setCompanyPluginEnabled 前加：

```typescript
import { getCompany } from '../domain/company';
// ...
// 在 enable/disable 两个路由的 asyncHandler 内，setCompanyPluginEnabled 调用前加：
const company = getCompany(getDb(), param(req, 'companyId'));
if (company.state !== 'off') {
  throw new AppError(ErrorCode.COMPANY_LOCKED, '公司上班期间不能修改能力配置，请先让公司下班');
}
```

- [ ] **Step 2: typecheck + Commit**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

```bash
git add src/server/api/plugins.ts
git commit -m "feat(api): B4 — plugin enable/disable respects company off state"
```

---

## Task 3: staffing 精确分配路由

**Files:**
- Modify: `src/server/api/projects.ts`

- [ ] **Step 1: 加 POST /api/projects/:id/staff 路由**

在 projects.ts 的 projectById 路由区加：

```typescript
import { ensurePrimaryThread } from '../domain/thread';
// ...
projectById.post(
  '/staff',
  asyncHandler(async (req, res) => {
    const input = z.object({ agentIds: z.array(z.string()).min(1) }).parse(req.body);
    const projectId = param(req, 'id');
    const project = getProject(getDb(), projectId);
    const threads = input.agentIds.map((agentId) => ensurePrimaryThread(getDb(), projectId, agentId));
    realtime.publish(
      makeLifecycleEvent('project.phase-entered', { projectId, phase: project.state, previousPhase: project.state }, { companyId: project.companyId, projectId }),
    );
    res.status(201).json({ ok: true, threadIds: threads.map((t) => t.id) });
  }),
);
```

- [ ] **Step 2: typecheck + Commit**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

```bash
git add src/server/api/projects.ts
git commit -m "feat(api): B4 — POST /projects/:id/staff for precise employee assignment"
```

---

## Task 4: 前端 hooks（plugins + staff）

**Files:**
- Modify: `src/client/hooks/queries.ts`

- [ ] **Step 1: 加 4 个 hooks**

在 queries.ts 加：

```typescript
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.get<Plugin[]>('/api/plugins'),
  });
}

export function useEnabledCompanyPlugins(companyId: string | undefined) {
  return useQuery({
    queryKey: ['enabled-plugins', companyId],
    queryFn: () => api.get<string[]>(`/api/companies/${companyId}/plugins/enabled`),
    enabled: !!companyId,
  });
}

export function useToggleCompanyPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, pluginId, enabled }: { companyId: string; pluginId: string; enabled: boolean }) =>
      api.post(`/api/plugins/companies/${companyId}/plugins/${pluginId}/${enabled ? 'enable' : 'disable'}`, {}),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['enabled-plugins', vars.companyId] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

export function useStaffProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, agentIds }: { projectId: string; agentIds: string[] }) =>
      api.post<{ ok: boolean; threadIds: string[] }>(`/api/projects/${projectId}/staff`, { agentIds }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['project', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['threads', vars.projectId] });
    },
  });
}
```

import 区加 `import type { Plugin } from '../api/types';`（Plugin 类型需从 shared 或 client 定义）。

- [ ] **Step 2: typecheck**

Plugin 类型可能需在 client/api/types.ts 补一个简化版（从 shared/plugin 复用或重新声明）。

- [ ] **Step 3: Commit**

```bash
git add src/client/hooks/queries.ts src/client/api/types.ts
git commit -m "feat(client): B4 — usePlugins/useToggleCompanyPlugin/useStaffProject hooks"
```

---

## Task 5: 五阶段表单组件 + wizard 分发

**Files:**
- Create: 5 个 phase 组件
- Modify: `src/client/components/project/ProjectOnboardingWizard.tsx`

- [ ] **Step 1: 写 5 个 phase 组件**

每个组件接收 `{ project, readiness, onUpdate }` props。示例 DraftingPhase：

```tsx
import { Card } from '../../Card';
import { Field, Input, Textarea } from '../../Form';
import type { ProjectDraft } from '../../../../shared/project-readiness';

export function DraftingPhase({ value, onUpdate }: { value: ProjectDraft; onUpdate: (next: ProjectDraft) => void }) {
  return (
    <Card className="phase-content">
      <h3>构思阶段</h3>
      <Field label="项目目标">
        <Textarea value={value.goal} onChange={(e) => onUpdate({ ...value, goal: e.target.value })} placeholder="这个项目要达成什么效果？" />
      </Field>
      <Field label="目标受众">
        <Input value={value.audience} onChange={(e) => onUpdate({ ...value, audience: e.target.value })} placeholder="为谁做？" />
      </Field>
      <Field label="约束与边界">
        <Textarea value={value.constraints} onChange={(e) => onUpdate({ ...value, constraints: e.target.value })} placeholder="预算/时间/技术/合规约束" />
      </Field>
    </Card>
  );
}
```

其他 4 个组件类似（ResearchingPhase 摘要+候选；EquippingPhase plugin 列表+toggle；StaffingPhase 员工复选；ReadyPhase 就绪清单+确认按钮）。

- [ ] **Step 2: wizard 分发**

Modify ProjectOnboardingWizard.tsx 的 phase-placeholder 区，按 `project.state` 分发：

```tsx
{project.state === 'drafting' && <DraftingPhase value={readiness.draft} onUpdate={(next) => updateReadiness({ ...readiness, draft: next })} />}
{project.state === 'researching' && <ResearchingPhase ... />}
// ...
```

`updateReadiness` 调 `useUpdateProject().mutate({ id, settings: { ...project.settings, onboarding: next } })`。

- [ ] **Step 3: typecheck + Commit**

```bash
git add src/client/components/project/
git commit -m "feat(client): B4 — five phase form components + wizard dispatch"
```

---

## Task 6: readiness 后端集成测试

**Files:**
- Create: `tests/integration/project-onboarding.spec.ts`

- [ ] **Step 1: 写测试**

覆盖：
- getProjectReadiness/setProjectReadiness 读写
- validatePhaseExit 各阶段校验规则（drafting→researching 缺 goal 抛错、researching→equipping 缺候选抛错、equipping→staffing 缺 plugin 抛错、staffing→ready 缺员工抛错、ready→active 全量复检）
- 回流不校验（staffing→drafting 即使全空也通过）
- transitionProjectPhase 集成 validatePhaseExit（非法跃迁因产物不足被拦）

- [ ] **Step 2: 跑测试 + Commit**

```bash
git add tests/integration/project-onboarding.spec.ts
git commit -m "test(project): B4 — readiness read/write + validatePhaseExit coverage"
```

---

## Task 7 (B5): task failure_count migration + failTask 自增

**Files:**
- Create: `src/server/db/migrations/20260727100000_task_failure_count.sql`
- Modify: `src/server/domain/task.ts`

- [ ] **Step 1: 写 migration**

```sql
-- B5 任务失败计数：支撑 3 次失败熔断回流（spec C.3/D.3）。
-- failTask 自增 failure_count；engine 在 failTask 后检查阈值。
ALTER TABLE task ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN last_failed_at TEXT;
```

- [ ] **Step 2: failTask 自增 failure_count**

Modify task.ts 的 failTask（约 L532）：UPDATE 语句加 `failure_count = failure_count + 1, last_failed_at = ?`。Task interface 加 `failureCount: number; lastFailedAt: string | null;`。

- [ ] **Step 3: typecheck + Commit**

```bash
git add src/server/db/migrations/20260727100000_task_failure_count.sql src/server/domain/task.ts
git commit -m "feat(task): B5 — failure_count tracking for circuit breaker"
```

---

## Task 8 (B5): project_plan + project_phase_history 表 + PlanVersion CRUD

**Files:**
- Create: `src/server/db/migrations/20260727110000_project_plan_and_phase_history.sql`
- Create: `src/server/domain/project-plan.ts`

- [ ] **Step 1: 写 migration（两表）**

如调研报告 6 节的 schema。

- [ ] **Step 2: 写 project-plan.ts**

导出 `createPlanVersion / getActivePlanVersion / listPlanVersions / supersedePlanVersion / recordPhaseEnter / recordPhaseExit`。

- [ ] **Step 3: transitionProjectPhase 内记录 phase history**

Modify project-readiness.ts 的 transitionProjectPhase：调 `recordPhaseExit(db, projectId, previousState)` + `recordPhaseEnter(db, projectId, target)`。

- [ ] **Step 4: typecheck + Commit**

```bash
git add src/server/db/migrations/20260727110000_* src/server/domain/project-plan.ts src/server/domain/project-readiness.ts
git commit -m "feat(project): B5 — project_plan + phase_history tables + PlanVersion CRUD"
```

---

## Task 9 (B5): 熔断回流（engine.ts）

**Files:**
- Modify: `src/server/task-engine/engine.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: constants 加阈值**

`export const TASK_CIRCUIT_BREAKER_THRESHOLD = 3;`

- [ ] **Step 2: engine handleRunError 后检查熔断**

在 engine.ts 的 handleRunError（约 L896 failTask 调用后），加熔断检查：

```typescript
const updatedTask = getTask(this.db, taskId);
if (updatedTask.failureCount >= TASK_CIRCUIT_BREAKER_THRESHOLD) {
  try {
    const project = getProject(this.db, updatedTask.projectId);
    // 回流到 researching（重新调研/装备）
    if (project.state === 'active') {
      const { previousState } = transitionProjectPhase(this.db, project.id, 'researching');
      realtime.publish(makeLifecycleEvent('project.rollback', { projectId: project.id, from: previousState, to: 'researching', reason: 'rollback-3x' }, { companyId: project.companyId, projectId: project.id }));
      log.warn('circuit breaker tripped, rolled back project', { taskId, projectId: project.id, failureCount: updatedTask.failureCount });
    }
  } catch (e) {
    log.warn('circuit breaker rollback failed', { taskId, err: e instanceof Error ? e.message : String(e) });
  }
}
```

**注意**：回流到 researching 会过 validatePhaseExit，但回流方向（active→researching，toIdx < fromIdx）不校验产物，安全。

- [ ] **Step 3: typecheck + Commit**

```bash
git add src/shared/constants.ts src/server/task-engine/engine.ts
git commit -m "feat(engine): B5 — 3x failure circuit breaker rolls back to researching"
```

---

## Task 10 (B5): lifecycle 发布 phase-exited + readiness-passed

**Files:**
- Modify: `src/server/api/projects.ts`

- [ ] **Step 1: PATCH 路由补事件**

在 projects.ts 的 PATCH state 分支：
- phase-entered 之前发 phase-exited（前序 phase 退出，outcome: isRollback ? 'rollback' : 'forward'）
- ready→active 时额外发 readiness-passed

- [ ] **Step 2: realtime.ts 补 project.* invalidate**

Modify `src/client/realtime.ts` 的 queryKeysForRealtimeEvent：加 `if (event.type.startsWith('project.')) keys.push(['project', event.projectId]);`

- [ ] **Step 3: typecheck + Commit**

```bash
git add src/server/api/projects.ts src/client/realtime.ts
git commit -m "feat(lifecycle): B5 — emit phase-exited/readiness-passed + invalidate project query"
```

---

## Task 11: 全量回归 + 最终验证

- [ ] **Step 1: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 2: 全量测试**

Run: `npm test 2>&1 | tail -6`
Expected: 所有测试 PASS（B3 的 543 + B4+B5 新增）。现有测试若有因 readiness 校验失败的（如直接 PATCH state drafting→active 的），按需在测试里先写 readiness 或用 initialState 跳过。

- [ ] **Step 3: 最终 commit（如有修复）**

```bash
git add -A && git commit -m "fix(b4b5): resolve regressions"
```

---

## Self-Review Notes

**Spec coverage:**
- C.2 六阶段产物 → Task 1, 5 ✅
- C.3 回流（validatePhaseExit 回流不校验）→ Task 1 ✅
- D.2 lifecycle phase-exited/readiness-passed → Task 10 ✅
- D.3 PlanVersion + phase history → Task 8 ✅
- 3 次失败熔断 → Task 7, 9 ✅
- company.state 配置锁 → Task 2 ✅

**关键风险点：**
- Task 9 熔断回流到 researching 会过 transitionProjectPhase 的 validatePhaseExit，但 active→researching 是回流（toIdx < fromIdx），validatePhaseExit 直接 return，安全。
- 现有测试若依赖"项目直接 drafting→active"，会被 validatePhaseExit 拦。这些测试应已用 initialState:'active' 跳过（B2 已处理）。
