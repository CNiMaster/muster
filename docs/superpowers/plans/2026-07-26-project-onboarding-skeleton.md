# 项目准备流程骨架（B2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Project 加一个可回流、可追溯的准备阶段状态机（drafting→researching→equipping→staffing→ready→active），配 HARD-GATE 闸门和空内容六阶段 stepper，让新建项目默认进入准备流程而非直接开工。

**Architecture:** Project 状态机扩展 5 个准备态值，新建 project-readiness domain 模块实现 `assertCanTransition` HARD-GATE，lifecycle events 加 phase-entered/rollback 事件，前端在 ProjectPage 加状态分支渲染 ProjectOnboardingWizard（复刻 CompanySetupWizard 的 stepper 模式但允许回流）。B2 只做骨架，各阶段内容为空占位（B4 批次填充）；现有任务级 launch gate 保留不动，两层正交。

**Tech Stack:** TypeScript + better-sqlite3 + zod（后端）；React + React Query + CSS（前端）；vitest（测试）

**Spec:** `docs/superpowers/specs/2026-07-26-capability-platform-design.md` 子系统 C.1/C.3 + D.1/D.2

---

## File Structure

**Create:**
- `src/server/db/migrations/20260726140000_project_state_machine.sql` — project 表 state CHECK 约束迁移 + 默认值改 drafting
- `src/shared/project-readiness.ts` — ProjectReadiness schema + 阶段产物 schema（仿 project-launch.ts 模式）
- `src/server/domain/project-readiness.ts` — `assertCanTransition` / `assertProjectActive` HARD-GATE + `transitionProjectPhase` 跃迁函数
- `src/client/components/project/ProjectOnboardingWizard.tsx` — 六阶段 stepper（复刻 CompanySetupWizard 模式，允许回流）
- `tests/integration/project-state-machine.spec.ts` — 状态机 + 闸门集成测试
- `tests/unit/project-onboarding-wizard.spec.tsx` — wizard 渲染 + 回流单元测试

**Modify:**
- `src/server/domain/project.ts:32,100,116-136` — ProjectState 加 5 值；createProject 默认 drafting；updateProject 加 transition 校验
- `src/server/domain/task.ts:225` — 派工闸门旁加 assertProjectActive
- `src/server/api/projects.ts:99-114` — PATCH 路由加 zod state 校验；新增 phase-transition/rollback 路由
- `src/shared/lifecycle-events.ts:4-60` — PayloadMap 加 4 个 project.phase-* 事件
- `src/shared/types.ts` — 同步 ProjectState 类型（若与服务端 project.ts 不一致）
- `src/client/api/types.ts:166` — 客户端 ProjectState 字面量扩展
- `src/client/components/Badge.tsx:67` — stateTone 加准备阶段色调
- `src/client/hooks/queries.ts:615` — useUpdateProject 签名加 state
- `src/client/pages/ProjectPage.tsx:282-422` — ProjectDetail 加 state 分支渲染

---

## Task 1: project 表 state CHECK 约束迁移

**Files:**
- Create: `src/server/db/migrations/20260726140000_project_state_machine.sql`

- [ ] **Step 1: 写 migration SQL**

创建 `src/server/db/migrations/20260726140000_project_state_machine.sql`：

```sql
-- B2 项目准备流程：扩展 project.state 状态机。
-- 新增 drafting/researching/equipping/staffing/ready 五个准备阶段，
-- 废弃 idle（保留为合法值以兼容历史数据，不再用于新项目）。
-- 设计见 docs/superpowers/specs/2026-07-26-capability-platform-design.md C.1。
-- SQLite 不支持 ALTER CHECK，需重建约束：DROP 旧 CHECK 不可直接，
-- 采用「建新表 + 拷贝 + DROP 旧 + RENAME」模式（SQLite 官方推荐）。
CREATE TABLE project_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  root_dir TEXT NOT NULL,
  first_agent_id TEXT,
  state TEXT NOT NULL DEFAULT 'drafting'
    CHECK (state IN ('idle','drafting','researching','equipping','staffing','ready','active','paused','completed','archived')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO project_new (id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at)
SELECT id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at FROM project;

DROP TABLE project;
ALTER TABLE project_new RENAME TO project;
CREATE INDEX IF NOT EXISTS idx_project_company ON project (company_id);
```

- [ ] **Step 2: 验证 migration 在内存库执行成功**

Run:
```bash
cd /Users/master/Project/muster && npx tsx -e "
import Database from 'better-sqlite3';
import { runMigrations } from './src/server/db/client.ts';
const db = new Database(':memory:');
runMigrations(db);
const cols = db.prepare(\"PRAGMA table_info(project)\").all();
const stateCol = cols.find(c => c.name === 'state');
console.log('state default:', stateCol.default_value);
const states = db.prepare(\"SELECT sql FROM sqlite_master WHERE name='project'\").get();
console.log('CHECK present:', states.sql.includes('drafting'));
db.close();
" 2>&1 | grep -E "state default|CHECK present"
```
Expected: `state default: 'drafting'` 和 `CHECK present: true`

- [ ] **Step 3: Commit**

```bash
git add src/server/db/migrations/20260726140000_project_state_machine.sql
git commit -m "feat(project): B2 migration — extend state machine with onboarding phases"
```

---

## Task 2: ProjectState 类型扩展 + createProject 默认值

**Files:**
- Modify: `src/server/domain/project.ts:32,100`
- Modify: `src/client/api/types.ts` (ProjectState 客户端类型)

- [ ] **Step 1: 扩展服务端 ProjectState**

Modify `src/server/domain/project.ts:32`：

```typescript
// 旧
export type ProjectState = 'idle' | 'active' | 'paused' | 'completed' | 'archived';
// 新
export type ProjectState =
  | 'idle' // 兼容历史数据；新项目不再使用
  | 'drafting' // 准备阶段：需求构思
  | 'researching' // 准备阶段：调研
  | 'equipping' // 准备阶段：能力装备
  | 'staffing' // 准备阶段：员工就位
  | 'ready' // 准备就绪：待用户确认开工
  | 'active' // 开工
  | 'paused'
  | 'completed'
  | 'archived';

/** 准备阶段集合（state ∈ 这些值时渲染 ProjectOnboardingWizard）。 */
export const ONBOARDING_PHASES: ReadonlySet<ProjectState> = new Set([
  'drafting',
  'researching',
  'equipping',
  'staffing',
  'ready',
]);

/** 六阶段顺序（用于 stepper 和回流判断）。 */
export const PHASE_ORDER: ProjectState[] = [
  'drafting',
  'researching',
  'equipping',
  'staffing',
  'ready',
  'active',
];
```

- [ ] **Step 2: 修改 createProject 默认 state**

Modify `src/server/domain/project.ts:100`（SQL 字面量）：

```typescript
// 旧：'idle'
// 新：'drafting'
// 找到 INSERT INTO project 语句中的 'idle' 字面量，改为 'drafting'
```

具体定位：搜索 `VALUES (?, ?, ?, ?, ?, ?, 'idle'` 改为 `VALUES (?, ?, ?, ?, ?, ?, 'drafting'`。

- [ ] **Step 3: 扩展客户端 ProjectState 类型**

Modify `src/client/api/types.ts` 找到 `ProjectState` 类型定义（约 L166），同步扩展为与服务端一致的 10 个值。

- [ ] **Step 4: typecheck 验证**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: 无错误（Badge.stateTone 等消费方可能需要补充，但类型本身兼容）

- [ ] **Step 5: 跑现有 project 测试确认无回归**

Run: `npm test -- tests/integration/worktree.spec.ts 2>&1 | tail -5`
Expected: PASS（createProject 默认值变化不影响已有测试，因为它们通常显式传 state 或用 active 项目）

如果有测试因默认值变化失败，检查是否显式依赖了 'idle' 默认值，按需调整为显式传 state。

- [ ] **Step 6: Commit**

```bash
git add src/server/domain/project.ts src/client/api/types.ts
git commit -m "feat(project): B2 — extend ProjectState with 5 onboarding phases, default to drafting"
```

---

## Task 3: ProjectReadiness schema（shared）

**Files:**
- Create: `src/shared/project-readiness.ts`

- [ ] **Step 1: 写 ProjectReadiness schema**

创建 `src/shared/project-readiness.ts`（仿 `src/shared/project-launch.ts` 模式）：

```typescript
/**
 * 项目准备就绪契约（B2 骨架）。
 * 每个准备阶段的产物 schema 定义在此，供 domain 层校验和前端 wizard 渲染。
 * B2 阶段字段为空占位（null/empty），B4 批次填充真实结构。
 */
import { z } from 'zod';

/** 阶段产物：drafting 阶段（spec.md）。 */
export const projectDraftSchema = z
  .object({
    goal: z.string().default(''),
    audience: z.string().default(''),
    constraints: z.string().default(''),
  })
  .strict();

/** 阶段产物：researching 阶段（research.md）。 */
export const projectResearchSchema = z
  .object({
    summary: z.string().default(''),
    candidateSkills: z.array(z.string()).default([]),
    candidateTools: z.array(z.string()).default([]),
  })
  .strict();

/** 阶段产物：equipping 阶段（equipment.md）。 */
export const projectEquipmentSchema = z
  .object({
    enabledPlugins: z.array(z.string()).default([]),
    missingCapabilities: z.array(z.string()).default([]),
  })
  .strict();

/** 阶段产物：staffing 阶段（staffing.md）。 */
export const projectStaffingSchema = z
  .object({
    employeeIds: z.array(z.string()).default([]),
  })
  .strict();

/** 项目准备就绪检查清单（ready 阶段产出）。 */
export const projectReadinessSchema = z
  .object({
    draft: projectDraftSchema,
    research: projectResearchSchema,
    equipment: projectEquipmentSchema,
    staffing: projectStaffingSchema,
    notes: z.string().default(''),
  })
  .strict();

export type ProjectDraft = z.infer<typeof projectDraftSchema>;
export type ProjectResearch = z.infer<typeof projectResearchSchema>;
export type ProjectEquipment = z.infer<typeof projectEquipmentSchema>;
export type ProjectStaffing = z.infer<typeof projectStaffingSchema>;
export type ProjectReadiness = z.infer<typeof projectReadinessSchema>;

export function emptyProjectReadiness(): ProjectReadiness {
  return projectReadinessSchema.parse({});
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/project-readiness.ts
git commit -m "feat(project): B2 — ProjectReadiness schema with phase artifact placeholders"
```

---

## Task 4: project-readiness domain（HARD-GATE + 跃迁）

**Files:**
- Create: `src/server/domain/project-readiness.ts`

- [ ] **Step 1: 写 domain 层闸门与跃迁函数**

创建 `src/server/domain/project-readiness.ts`：

```typescript
/**
 * 项目准备流程状态机（B2 骨干）。
 *
 * HARD-GATE 设计（借鉴 superpowers brainstorming:12-14 的 HARD-GATE 模式，
 * 异步化改造为服务端校验）：每个状态跃迁有进入条件，违反则抛 AppError。
 * 闸门校验只做「状态转换是否合法」，阶段产物内容校验留给 B4（当前骨架阶段全允许）。
 *
 * 详见 docs/superpowers/specs/2026-07-26-capability-platform-design.md D.1。
 */
import { PHASE_ORDER, type ProjectState } from './project';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getProject, updateProject } from './project';

/** 合法的向前跃迁（前一阶段 → 后一阶段）。 */
const FORWARD_TRANSITIONS: Record<ProjectState, ProjectState | null> = {
  idle: null,
  drafting: 'researching',
  researching: 'equipping',
  equipping: 'staffing',
  staffing: 'ready',
  ready: 'active',
  active: null,
  paused: null,
  completed: null,
  archived: null,
};

/**
 * 断言 state 转换合法。
 * 规则：
 * - 向前：必须按 PHASE_ORDER 顺序推进（drafting→researching→...→active）
 * - 向后：允许任意回流（researching→drafting 等，对应 spec C.3 回流机制）
 * - active↔paused：允许（现有暂停/恢复）
 * - 任意 → archived/completed：允许
 * - idle：作为遗留值，允许转 drafting（兼容历史项目），不允许向前到 active
 */
export function assertCanTransition(from: ProjectState, to: ProjectState): void {
  if (from === to) return; // 同态无操作

  // 回流：to 在 PHASE_ORDER 中且 index 小于 from
  const fromIdx = PHASE_ORDER.indexOf(from);
  const toIdx = PHASE_ORDER.indexOf(to);
  if (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) return; // 合法回流

  // 向前：必须是 FORWARD_TRANSITIONS 定义的直接后继
  if (FORWARD_TRANSITIONS[from] === to) return;

  // active ↔ paused
  if ((from === 'active' && to === 'paused') || (from === 'paused' && to === 'active')) return;

  // 终态：任意 → completed / archived（仅 active/paused 可完成）
  if (to === 'completed' && (from === 'active' || from === 'paused')) return;
  if (to === 'archived') return;

  // idle 兼容：idle → drafting（历史项目进准备流程）
  if (from === 'idle' && to === 'drafting') return;

  throw new AppError(
    ErrorCode.TASK_INVALID_TRANSITION,
    `非法项目状态转换：${from} → ${to}。准备阶段必须按 drafting→researching→equipping→staffing→ready→active 顺序推进，或向前序阶段回流。`,
  );
}

/**
 * 执行阶段跃迁：校验合法性后更新 project.state。
 * 返回更新后的 project。发布 lifecycle event 由调用方（API 路由）负责。
 */
export function transitionProjectPhase(
  db: DB,
  projectId: string,
  target: ProjectState,
  options: { rollbackReason?: string } = {},
): { project: ReturnType<typeof getProject>; previousState: ProjectState } {
  const project = getProject(db, projectId);
  const previousState = project.state;
  assertCanTransition(previousState, target);
  const updated = updateProject(db, projectId, { state: target });
  return { project: updated, previousState };
}

/**
 * 派工闸门：项目必须处于 active 才能派工。
 * 旁路现有 task.ts:225 的 assertProjectLaunchConfirmed（任务级闸门），两层正交。
 */
export function assertProjectActive(db: DB, projectId: string): void {
  const project = getProject(db, projectId);
  if (project.state !== 'active') {
    throw new AppError(
      ErrorCode.PROJECT_INACTIVE,
      `项目尚未开工（当前状态：${project.state}）。请先完成准备流程并确认开工。`,
      { details: { state: project.state } },
    );
  }
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/domain/project-readiness.ts
git commit -m "feat(project): B2 — project-readiness domain with HARD-GATE transition rules"
```

---

## Task 5: 派工闸门接入 createTask

**Files:**
- Modify: `src/server/domain/task.ts:225`

- [ ] **Step 1: 在 createTask 加 assertProjectActive**

Modify `src/server/domain/task.ts`，在 L225 附近（`assertProjectLaunchConfirmed` 旁）加项目级闸门。

定位 import 区，确认是否已 import `assertProjectLaunchConfirmed`，在其下方加：

```typescript
// 文件顶部 import 区，找到 project-launch 的 import，旁边加：
import { assertProjectActive } from './project-readiness';
```

然后在 L225 附近：

```typescript
// 旧（L225）
if(projectTaskId){assertProjectTaskActive(db,projectTaskId,input.projectId);assertProjectLaunchConfirmed(db,projectTaskId);}
// 新
if(projectTaskId){assertProjectTaskActive(db,projectTaskId,input.projectId);assertProjectLaunchConfirmed(db,projectTaskId);assertProjectActive(db,input.projectId);}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: 跑 task 相关测试确认无回归**

Run: `npm test -- tests/integration/engine-wiring.spec.ts 2>&1 | tail -5`

**注意**：如果现有测试用 non-active 项目创建 task，会因新闸门失败。需要检查测试 setup——大多数集成测试用 helper 建 active 项目。若有失败，在测试 helper 里显式把项目置为 active（`updateProject(db, projectId, { state: 'active' })`）。

- [ ] **Step 4: Commit**

```bash
git add src/server/domain/task.ts
git commit -m "feat(project): B2 — gate task creation on project being active"
```

---

## Task 6: lifecycle 事件扩展

**Files:**
- Modify: `src/shared/lifecycle-events.ts:4-60`

- [ ] **Step 1: 加 4 个 project.phase-* 事件**

Modify `src/shared/lifecycle-events.ts` 的 `LifecycleEventPayloadMap`，在 `project-task.*` 事件组后加：

```typescript
  // 项目准备流程（B2）
  'project.phase-entered': { projectId: string; phase: ProjectState; previousPhase: ProjectState | null; rollbackFrom?: ProjectState };
  'project.phase-exited': { projectId: string; phase: ProjectState; outcome: 'forward' | 'rollback' | 'completed' };
  'project.readiness-passed': { projectId: string };
  'project.rollback': { projectId: string; from: ProjectState; to: ProjectState; reason: string };
```

需要 import `ProjectState`：在文件顶部加 `import type { ProjectState } from './types';`（如果 types.ts 已导出 ProjectState，否则从 domain 间接导入——优先在 shared/types.ts 导出）。

**检查**：确认 `src/shared/types.ts` 是否有 `ProjectState` 导出。若无，在 types.ts 加 `export type { ProjectState } from '../server/domain/project';` 或在 lifecycle-events.ts 直接定义字面量联合（避免 shared 依赖 server）。

**推荐做法**（避免 shared→server 依赖）：在 `src/shared/types.ts` 导出独立的 `ProjectState` 字面量联合，domain/project.ts 改为从 shared 导入。但这改动较大，B2 阶段可先在 lifecycle-events.ts 内联字面量：

```typescript
// lifecycle-events.ts 顶部
type ProjectPhase = 'idle' | 'drafting' | 'researching' | 'equipping' | 'staffing' | 'ready' | 'active' | 'paused' | 'completed' | 'archived';
```

然后 PayloadMap 用 `ProjectPhase`。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: 跑 lifecycle 测试**

Run: `npm test -- tests/unit/lifecycle-events.spec.ts 2>&1 | tail -5`
Expected: PASS（新增事件类型不影响现有测试）

- [ ] **Step 4: Commit**

```bash
git add src/shared/lifecycle-events.ts
git commit -m "feat(lifecycle): B2 — add project phase-entered/exited/rollback events"
```

---

## Task 7: API 路由 — phase-transition + rollback

**Files:**
- Modify: `src/server/api/projects.ts:99-114`

- [ ] **Step 1: 改造 PATCH 路由加 state 校验**

Modify `src/server/api/projects.ts` 的 PATCH `/` 路由（L99-114）：

```typescript
projectById.patch(
  '/',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    // state 转换需走专用路由（phase-transition），PATCH 只允许非 state 字段
    // 若直接传 state，走 transitionProjectPhase 校验
    if (patch.state !== undefined) {
      const target = patch.state;
      const { project, previousState } = transitionProjectPhase(getDb(), param(req, 'id'), target);
      const isRollback = PHASE_ORDER.indexOf(target) < PHASE_ORDER.indexOf(previousState);
      realtime.publish(
        makeLifecycleEvent(
          'project.phase-entered',
          { projectId: project.id, phase: project.state, previousPhase: previousState, rollbackFrom: isRollback ? previousState : undefined },
          { companyId: project.companyId, projectId: project.id },
        ),
      );
      res.json(project);
      return;
    }
    res.json(
      updateProject(getDb(), param(req, 'id'), {
        name: patch.name,
        description: patch.description,
        firstAgentId: patch.firstAgentId,
        settings: patch.settings,
        rootDir: patch.rootDir,
      }),
    );
  }),
);
```

顶部 import 区加：
```typescript
import { transitionProjectPhase } from '../domain/project-readiness';
import { PHASE_ORDER } from '../domain/project';
```

- [ ] **Step 2: 加 rollback 专用路由**

在 PATCH 路由后加：

```typescript
projectById.post(
  '/rollback',
  asyncHandler(async (req, res) => {
    const input = z.object({ to: z.string().min(1), reason: z.string().default('') }).parse(req.body);
    const target = input.to as ProjectState;
    const { project, previousState } = transitionProjectPhase(getDb(), param(req, 'id'), target, { rollbackReason: input.reason });
    realtime.publish(
      makeLifecycleEvent(
        'project.rollback',
        { projectId: project.id, from: previousState, to: project.state, reason: input.reason },
        { companyId: project.companyId, projectId: project.id },
      ),
    );
    realtime.publish(
      makeLifecycleEvent(
        'project.phase-entered',
        { projectId: project.id, phase: project.state, previousPhase: previousState, rollbackFrom: previousState },
        { companyId: project.companyId, projectId: project.id },
      ),
    );
    res.json(project);
  }),
);
```

import 区加 `import type { ProjectState } from '../domain/project';`（若未引入）。

- [ ] **Step 3: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/api/projects.ts
git commit -m "feat(api): B2 — project phase-transition via PATCH state + rollback route"
```

---

## Task 8: Badge stateTone + useUpdateProject 扩展

**Files:**
- Modify: `src/client/components/Badge.tsx:67`
- Modify: `src/client/hooks/queries.ts:615`

- [ ] **Step 1: Badge.stateTone 加准备阶段色调**

Modify `src/client/components/Badge.tsx` 的 `stateTone` 函数（约 L67），为准备阶段加中性/进行中色调：

```typescript
// 在现有 project 分支里补充：
// drafting/researching/equipping/staffing → 'info'（蓝色，进行中）
// ready → 'warning'（黄色，待确认）
// active → 'success'（绿色，现有）
// paused → 'neutral'（灰色，现有）
```

具体：找到 `domain === 'project'` 的 switch/if 分支，扩展 case。

- [ ] **Step 2: useUpdateProject 签名加 state**

Modify `src/client/hooks/queries.ts` 的 `useUpdateProject`（约 L615），在 mutation 变量类型加 `state?: ProjectState`：

```typescript
// 找到 useUpdateProject 的 mutationFn，其参数类型加 state
// 确保导入 ProjectState 类型（从 src/client/api/types 或重新导出）
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/client/components/Badge.tsx src/client/hooks/queries.ts
git commit -m "feat(client): B2 — Badge tones for onboarding phases + useUpdateProject state field"
```

---

## Task 9: ProjectOnboardingWizard 组件

**Files:**
- Create: `src/client/components/project/ProjectOnboardingWizard.tsx`

- [ ] **Step 1: 写 wizard 组件（复刻 CompanySetupWizard stepper 模式，允许回流）**

创建 `src/client/components/project/ProjectOnboardingWizard.tsx`：

```tsx
/**
 * 项目准备流程 Wizard（B2 骨架）。
 * 六阶段 stepper：drafting→researching→equipping→staffing→ready→active。
 * 借鉴 CompanySetupWizard 的 stepper 模式，但允许任意回流（点回前序阶段）。
 * B2 阶段每阶段内容为空占位，B4 批次填充真实表单。
 */
import { useState } from 'react';
import type { Project, ProjectState } from '../../api/types';
import { useUpdateProject } from '../../hooks/queries';

const PHASES: { state: ProjectState; label: string; hint: string }[] = [
  { state: 'drafting', label: '构思', hint: '明确目标、受众与约束' },
  { state: 'researching', label: '调研', hint: '收集资料、选定能力' },
  { state: 'equipping', label: '装备', hint: '启用所需能力' },
  { state: 'staffing', label: '员工', hint: '分配工位' },
  { state: 'ready', label: '就绪', hint: '确认后开工' },
];

export function ProjectOnboardingWizard({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const currentIndex = PHASES.findIndex((p) => p.state === project.state);
  // currentIndex 为 -1（如 state=ready 之外的终态）时不渲染 wizard，由父组件处理

  const goTo = (target: ProjectState) => {
    updateProject.mutate({ id: project.id, state: target });
  };

  return (
    <div className="project-onboarding-wizard">
      <header className="onboarding-header">
        <h2>项目准备流程</h2>
        <p>按阶段推进，可随时回到前序阶段补充。完成后即可开工。</p>
      </header>

      <nav className="setup-steps">
        {PHASES.map((phase, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <button
              key={phase.state}
              className={`setup-step ${active ? 'is-active' : ''} ${done ? 'is-done' : ''}`}
              // 允许回流：任意已完成或当前阶段可点；未来阶段不可点
              disabled={i > currentIndex}
              onClick={() => goTo(phase.state)}
            >
              <span className="setup-step-dot">{done ? '✓' : i + 1}</span>
              <span className="setup-step-label">{phase.label}</span>
            </button>
          );
        })}
      </nav>

      <section className="onboarding-phase-content">
        {/* B2 占位：每阶段显示 hint，B4 填充真实表单 */}
        {currentIndex >= 0 && currentIndex < PHASES.length && (
          <div className="phase-placeholder">
            <h3>{PHASES[currentIndex]!.label}阶段</h3>
            <p className="phase-hint">{PHASES[currentIndex]!.hint}</p>
            <p className="phase-todo">（此阶段内容将在后续版本完善）</p>
          </div>
        )}
      </section>

      <footer className="setup-footer">
        <button
          className="btn-ghost"
          disabled={currentIndex <= 0 || updateProject.isPending}
          onClick={() => currentIndex > 0 && goTo(PHASES[currentIndex - 1]!.state)}
        >
          ← 返回{currentIndex > 0 ? PHASES[currentIndex - 1]!.label : ''}
        </button>
        <span className="setup-progress">
          {Math.max(0, currentIndex) + 1} / {PHASES.length}
        </span>
        {currentIndex === PHASES.length - 1 ? (
          <button
            className="btn-primary"
            disabled={updateProject.isPending}
            onClick={() => goTo('active')}
          >
            确认开工 →
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={currentIndex < 0 || updateProject.isPending}
            onClick={() => currentIndex >= 0 && goTo(PHASES[currentIndex + 1]!.state)}
          >
            继续到{currentIndex >= 0 && currentIndex < PHASES.length - 1 ? PHASES[currentIndex + 1]!.label : '下一阶段'} →
          </button>
        )}
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS（若 Project/ProjectState 类型路径不对，按 client/api/types.ts 实际导出调整）

- [ ] **Step 3: Commit**

```bash
git add src/client/components/project/ProjectOnboardingWizard.tsx
git commit -m "feat(client): B2 — ProjectOnboardingWizard stepper with rollback support"
```

---

## Task 10: ProjectPage 状态分支

**Files:**
- Modify: `src/client/pages/ProjectPage.tsx:282-422`

- [ ] **Step 1: 在 ProjectDetail 加状态分支**

Modify `src/client/pages/ProjectPage.tsx` 的 `ProjectDetail` 组件。在 L422（`<WorkbenchShell>` 渲染处）之前加条件分支：

```tsx
import { ProjectOnboardingWizard } from '../components/project/ProjectOnboardingWizard';

// 在 ProjectDetail 组件内，获取 project 后、渲染 WorkbenchShell 前加：
const ONBOARDING_STATES = new Set(['drafting', 'researching', 'equipping', 'staffing', 'ready']);
if (ONBOARDING_STATES.has(project.state)) {
  return (
    <div className="project-onboarding-container">
      <ProjectOnboardingWizard project={project} />
    </div>
  );
}

// 现有 WorkbenchShell 渲染保留给 active/paused/completed/archived/idle
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/client/pages/ProjectPage.tsx
git commit -m "feat(client): B2 — render onboarding wizard when project in preparation phases"
```

---

## Task 11: 集成测试 — 状态机 + 闸门

**Files:**
- Create: `tests/integration/project-state-machine.spec.ts`

- [ ] **Step 1: 写状态机测试**

创建 `tests/integration/project-state-machine.spec.ts`：

```typescript
/**
 * B2 状态机集成测试：
 * - createProject 默认 drafting
 * - assertCanTransition 合法/非法转换
 * - transitionProjectPhase 跃迁 + 回流
 * - assertProjectActive 派工闸门
 * - 现有 active 项目不受影响（回归）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createProject, updateProject, getProject, type ProjectState } from '../../src/server/domain/project';
import { assertCanTransition, transitionProjectPhase, assertProjectActive } from '../../src/server/domain/project-readiness';
import { AppError, ErrorCode } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let companyId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const company = createCompany(db, { name: '测试公司', kind: 'general' });
  companyId = company.id;
});

afterEach(() => tdb.close());

function makeProject(): string {
  const project = createProject(db, {
    companyId,
    name: '测试项目',
    rootDir: '/tmp/test-project',
  });
  return project.id;
}

describe('createProject 默认 drafting', () => {
  it('新建项目 state 为 drafting', () => {
    const id = makeProject();
    expect(getProject(db, id).state).toBe('drafting');
  });
});

describe('assertCanTransition 合法转换', () => {
  it('准备阶段顺序推进', () => {
    expect(() => assertCanTransition('drafting', 'researching')).not.toThrow();
    expect(() => assertCanTransition('researching', 'equipping')).not.toThrow();
    expect(() => assertCanTransition('equipping', 'staffing')).not.toThrow();
    expect(() => assertCanTransition('staffing', 'ready')).not.toThrow();
    expect(() => assertCanTransition('ready', 'active')).not.toThrow();
  });

  it('允许回流（任意前序阶段）', () => {
    expect(() => assertCanTransition('staffing', 'drafting')).not.toThrow();
    expect(() => assertCanTransition('ready', 'researching')).not.toThrow();
    expect(() => assertCanTransition('active', 'equipping')).not.toThrow();
  });

  it('active ↔ paused 双向', () => {
    expect(() => assertCanTransition('active', 'paused')).not.toThrow();
    expect(() => assertCanTransition('paused', 'active')).not.toThrow();
  });

  it('idle → drafting 兼容历史', () => {
    expect(() => assertCanTransition('idle', 'drafting')).not.toThrow();
  });
});

describe('assertCanTransition 非法转换', () => {
  it('跳过阶段被拒绝', () => {
    expect(() => assertCanTransition('drafting', 'active')).toThrow(AppError);
    expect(() => assertCanTransition('drafting', 'equipping')).toThrow(AppError);
    expect(() => assertCanTransition('drafting', 'staffing')).toThrow(AppError);
  });

  it('准备阶段直接跳 active 被拒绝', () => {
    expect(() => assertCanTransition('researching', 'active')).toThrow(AppError);
  });

  it('idle 直接跳 active 被拒绝', () => {
    expect(() => assertCanTransition('idle', 'active')).toThrow(AppError);
  });

  it('错误码为 TASK_INVALID_TRANSITION', () => {
    try {
      assertCanTransition('drafting', 'active');
      expect.fail('应抛错');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.TASK_INVALID_TRANSITION);
    }
  });
});

describe('transitionProjectPhase', () => {
  it('向前跃迁成功并返回 previousState', () => {
    const id = makeProject();
    const { project, previousState } = transitionProjectPhase(db, id, 'researching');
    expect(project.state).toBe('researching');
    expect(previousState).toBe('drafting');
  });

  it('回流跃迁成功', () => {
    const id = makeProject();
    transitionProjectPhase(db, id, 'researching');
    const { project, previousState } = transitionProjectPhase(db, id, 'drafting');
    expect(project.state).toBe('drafting');
    expect(previousState).toBe('researching');
  });

  it('非法跃迁抛错', () => {
    const id = makeProject();
    expect(() => transitionProjectPhase(db, id, 'active')).toThrow(AppError);
  });
});

describe('assertProjectActive 派工闸门', () => {
  it('drafting 项目派工被拒', () => {
    const id = makeProject();
    expect(() => assertProjectActive(db, id)).toThrow(AppError);
    try {
      assertProjectActive(db, id);
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.PROJECT_INACTIVE);
    }
  });

  it('active 项目派工放行', () => {
    const id = makeProject();
    // 走完整准备流程到 active
    for (const target of ['researching', 'equipping', 'staffing', 'ready', 'active'] as ProjectState[]) {
      transitionProjectPhase(db, id, target);
    }
    expect(() => assertProjectActive(db, id)).not.toThrow();
  });
});

describe('现有 active 项目回归', () => {
  it('显式建 active 项目不受准备流程影响', () => {
    const project = createProject(db, { companyId, name: '直接开工', rootDir: '/tmp/p2' });
    updateProject(db, project.id, { state: 'active' }); // 显式置 active（需先过完整流程或直接 UPDATE）
    // 注意：updateProject 本身不做 transition 校验（只有 PATCH 路由走 transitionProjectPhase）
    // 所以测试里直接 UPDATE 数据库置 active，绕过闸门，模拟历史 active 项目
    expect(() => assertProjectActive(db, project.id)).not.toThrow();
  });
});
```

**注意 Task 11 最后一个测试**：`updateProject` 不做 transition 校验（只有 API 层 PATCH 走 transitionProjectPhase），所以可以直接把任意项目置为 active 用于回归测试。这符合设计：domain 层 updateProject 是低级 CRUD，闸门校验在 readiness 模块。

- [ ] **Step 2: 跑测试**

Run: `npm test -- tests/integration/project-state-machine.spec.ts 2>&1 | tail -8`
Expected: 全部 PASS

如果 `createProject` 默认 rootDir 必须是 git 仓库（某些测试 helper 要求），改用 `makeTempGitRepo()` from setup。

- [ ] **Step 3: Commit**

```bash
git add tests/integration/project-state-machine.spec.ts
git commit -m "test(project): B2 — state machine transition rules + dispatch gate"
```

---

## Task 12: 全量回归 + 最终验证

- [ ] **Step 1: typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 2: 全量测试**

Run: `npm test 2>&1 | tail -8`
Expected: 所有测试 PASS（含 B1 的 494 + B2 新增）。若有失败，按错误信息修复——常见是现有测试依赖 createProject 默认 idle，需显式置 active。

- [ ] **Step 3: 最终 commit（如有修复）**

```bash
git add -A
git commit -m "fix(project): B2 — resolve regressions from default drafting state"
```

---

## Self-Review Notes

**Spec coverage:**
- C.1 状态机扩展 → Task 1, 2 ✅
- D.1 HARD-GATE → Task 4, 5 ✅
- D.2 lifecycle 事件 → Task 6 ✅
- C.3 回流机制 → Task 4 (assertCanTransition 回流规则), Task 7 (rollback 路由), Task 9 (wizard 回流) ✅
- 前端 wizard → Task 9, 10 ✅
- 派工闸门 → Task 5 ✅

**Placeholder scan:** Task 9 wizard 内容是 B2 骨架占位（明确标注 B4 填充），符合 spec「B2 只做骨架」要求；非计划缺陷。

**Type consistency:** ProjectState 在 domain/shared/client 三处定义需保持一致（Task 2, 6, 8 跨文件），plan 已说明 lifecycle-events.ts 用内联字面量 ProjectPhase 避免 shared→server 依赖。
