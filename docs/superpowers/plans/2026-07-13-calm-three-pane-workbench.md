# Calm Three-Pane Workbench Implementation Plan

> ⚠️ 历史注记（2026-08-16）：公司/项目双页适配已被项目页单壳取代（公司适配器随公司页删除）；三栏骨架由 WorkbenchShell 继承。本计划为历史执行记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the company and project pages with the approved C3 workbench: left selects work, center performs work, right follows context, while management pages remain single-column.

**Architecture:** Introduce a business-data-free `WorkbenchShell` for layout and persisted pane preferences, then provide small company and project adapters that build navigation and context content from existing queries. Preserve existing server APIs, project-task/session boundaries, and compatible query-string routes while removing nested company tabs and project action clutter from the primary flow.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, TypeScript 5.7, CSS, Vitest/Testing Library, Playwright.

## Global Constraints

- Only company and project pages use the workbench; home, setup, agents, executors, permissions, and settings stay single-column.
- There is one horizontal toolbar, one vertical work list, one primary center surface, and one automatically derived context inspector.
- Do not add per-pane tabs, drag/drop docking, cross-pane moves, or customizable layouts.
- Persist only pane visibility and width in `localStorage`; current work remains URL/server state.
- Desktop shows three panes, tablet overlays the right pane, and mobile uses drawers without horizontal overflow.
- Respect `prefers-reduced-motion`, keyboard access, `aria-expanded`, Escape close, and focus return.
- Preserve all existing company, project-task, employee-work-order, approval, and CLI-session data models.

---

### Task 1: Workbench preferences and responsive state

**Files:**
- Create: `src/client/components/workbench/useWorkbenchPreferences.ts`
- Test: `tests/unit/workbench-preferences.spec.ts`

**Interfaces:**
- Produces: `useWorkbenchPreferences(scopeKey: string): { leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number; toggleLeft(): void; toggleRight(): void; closeDrawers(): void }`
- Produces: `readWorkbenchPreferences(storage: Pick<Storage, 'getItem'>, scopeKey: string): WorkbenchPreferences`

- [x] **Step 1: Write the failing preference tests**

```ts
expect(readWorkbenchPreferences(storage, 'company:1')).toEqual({ leftOpen: true, rightOpen: true, leftWidth: 248, rightWidth: 304 });
expect(readWorkbenchPreferences(invalidStorage, 'project:1')).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
```

- [x] **Step 2: Run the test and verify the missing module failure**

Run: `npx vitest run tests/unit/workbench-preferences.spec.ts`
Expected: FAIL because `useWorkbenchPreferences` does not exist.

- [x] **Step 3: Implement validated local preferences**

```ts
export const DEFAULT_WORKBENCH_PREFERENCES = { leftOpen: true, rightOpen: true, leftWidth: 248, rightWidth: 304 };
export function readWorkbenchPreferences(storage: Pick<Storage,'getItem'>, scopeKey: string): WorkbenchPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(`muster:workbench:${scopeKey}`) ?? '{}');
    return {
      leftOpen: typeof parsed.leftOpen === 'boolean' ? parsed.leftOpen : true,
      rightOpen: typeof parsed.rightOpen === 'boolean' ? parsed.rightOpen : true,
      leftWidth: validWidth(parsed.leftWidth, 200, 360) ? parsed.leftWidth : 248,
      rightWidth: validWidth(parsed.rightWidth, 240, 420) ? parsed.rightWidth : 304,
    };
  } catch { return DEFAULT_WORKBENCH_PREFERENCES; }
}
```

- [x] **Step 4: Run the focused tests**

Run: `npx vitest run tests/unit/workbench-preferences.spec.ts`
Expected: PASS.

### Task 2: Reusable calm workbench shell

**Files:**
- Create: `src/client/components/workbench/WorkbenchShell.tsx`
- Create: `src/client/components/workbench/WorkbenchGuide.tsx`
- Modify: `src/client/styles/global.css`
- Test: `tests/unit/workbench-shell.spec.tsx`

**Interfaces:**
- Consumes: `useWorkbenchPreferences(scopeKey)` from Task 1.
- Produces: `WorkbenchShell({ scopeKey, breadcrumb, navigation, children, inspector, primaryAction, attentionCount })`.

- [x] **Step 1: Write failing interaction tests**

```tsx
render(<WorkbenchShell scopeKey="project:1" breadcrumb="公司 / 项目" navigation={<p>任务列表</p>} inspector={<p>当前现场</p>}><p>当前工作</p></WorkbenchShell>);
await user.click(screen.getByRole('button', { name: '收起工作列表' }));
expect(screen.queryByText('任务列表')).not.toBeVisible();
await user.keyboard('{Meta>}k{/Meta}');
expect(screen.getByRole('dialog', { name: '搜索或跳转' })).toBeVisible();
```

- [x] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/workbench-shell.spec.tsx`
Expected: FAIL because the shell is missing.

- [x] **Step 3: Implement the semantic shell**

```tsx
<section className="workbench" style={{ '--work-left': `${leftWidth}px`, '--work-right': `${rightWidth}px` } as React.CSSProperties}>
  <WorkbenchHeader leftOpen={leftOpen} rightOpen={rightOpen} breadcrumb={breadcrumb} onToggleLeft={toggleLeft} onToggleRight={toggleRight} primaryAction={primaryAction}/>
  <div className="workbench-grid">
    <aside id="work-navigation" hidden={!leftOpen}>{navigation}</aside>
    <main className="workbench-surface">{children}</main>
    <aside id="work-inspector" hidden={!rightOpen}>{inspector}</aside>
  </div>
</section>
```

- [x] **Step 4: Add the one-time three-step guide and reduced-motion behavior**

```tsx
const steps = [{ target: 'navigation', label: '1 选择工作' }, { target: 'surface', label: '2 完成工作' }, { target: 'inspector', label: '3 查看现场' }];
```

- [x] **Step 5: Add desktop/tablet/mobile CSS**

```css
.workbench-grid{display:grid;grid-template-columns:var(--work-left) minmax(0,1fr) var(--work-right)}
@media(max-width:1179px){.workbench-inspector{position:fixed;inset:var(--topbar-height) 0 0 auto;width:min(380px,92vw)}}
@media(max-width:819px){.workbench-navigation{position:fixed;inset:var(--topbar-height) auto 0 0;width:min(320px,88vw)}.workbench-grid{display:block}}
```

- [x] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run tests/unit/workbench-shell.spec.tsx && npm run typecheck`
Expected: PASS.

### Task 3: Company workbench adapter

**Files:**
- Create: `src/client/components/workbench/CompanyWorkNavigation.tsx`
- Create: `src/client/components/workbench/CompanyContextInspector.tsx`
- Modify: `src/client/pages/CompanyPage.tsx`
- Modify: `tests/unit/company-page-layout.spec.tsx`
- Modify: `tests/e2e/product-completion.spec.ts`

**Interfaces:**
- Consumes: existing company, cockpit, projects, agents, departments, events, and status-board queries.
- Produces: `CompanyPage` using `?view=overview|team|projects|activity|settings`, while accepting legacy `?tab=` and replacing it with the compatible view.

- [x] **Step 1: Replace the old five-tab test with workbench expectations**

```tsx
expect(screen.getByRole('navigation', { name: '公司工作列表' })).toBeVisible();
expect(screen.getByRole('main', { name: '公司工作区' })).toBeVisible();
expect(screen.getByRole('complementary', { name: '公司现场' })).toBeVisible();
expect(screen.queryByRole('tab', { name: '团队' })).not.toBeInTheDocument();
```

- [x] **Step 2: Run the tests and observe the old-tab failure**

Run: `npx vitest run tests/unit/company-page-layout.spec.tsx`
Expected: FAIL because `CompanySections` still renders tabs.

- [x] **Step 3: Build the vertical company work list**

```tsx
const items = [
  { key: 'overview', label: '公司概览', icon: '◎' },
  { key: 'projects', label: '项目', count: projects.length, icon: '▣' },
  { key: 'team', label: '员工看板', count: agents.length, icon: '人' },
  { key: 'activity', label: '沟通与活动', icon: '◌' },
  { key: 'settings', label: '更多设置', icon: '…' },
];
```

- [x] **Step 4: Derive the automatic company inspector**

Show company state, blocked employees, pending approvals, active projects, and the relevant recovery link. Do not duplicate detailed team or project forms in the inspector.

- [x] **Step 5: Render the selected existing company component in the center surface**

Use `CompanyOverview`, `CompanyTeam`, `CompanyProjects`, `CompanyActivity`, and `CompanySettings` as center content so server behavior remains unchanged.

- [x] **Step 6: Run company unit and E2E tests**

Run: `npx vitest run tests/unit/company-page-layout.spec.tsx tests/unit/state-explanation.spec.tsx && PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test tests/e2e/product-completion.spec.ts`
Expected: PASS.

### Task 4: Project workbench adapter

**Files:**
- Create: `src/client/components/workbench/ProjectWorkNavigation.tsx`
- Create: `src/client/components/workbench/ProjectContextInspector.tsx`
- Create: `src/client/components/project/ProjectTaskWorkspace.tsx`
- Modify: `src/client/pages/ProjectPage.tsx`
- Modify: `tests/e2e/smoke.spec.ts`
- Test: `tests/unit/project-workbench.spec.tsx`

**Interfaces:**
- Consumes: project, company, project tasks, tasks, agents, cockpit, conversations, and current `projectTask` query parameter.
- Produces: the project task list and communication entries in the left pane, one selected work surface in the center, and current task/thread/approval health in the right pane.

- [x] **Step 1: Write failing project navigation and inspector tests**

```tsx
expect(screen.getByRole('link', { name: /审批闭环/ })).toHaveAttribute('href', '/projects/pr_1?projectTask=pt_1');
expect(screen.getByText('员工首次收到工作单后才创建会话。')).toBeVisible();
```

- [x] **Step 2: Extract project-task editing from the oversized project page**

Move task creation, completion, archive, selected-task details, work-order publication, and thread health into `ProjectTaskWorkspace` without changing mutation inputs or query invalidation.

- [x] **Step 3: Build the project work list**

List active project tasks first, then communication, attention items, employee board, files, and low-frequency tools. Existing dashboard, reports, artifacts, usage, tasks, and novel character graph remain reachable but no longer occupy a horizontal button row.

- [x] **Step 4: Build the automatic project inspector**

For a selected project task show participants, Run/compaction/session status, blocked employee count, pending approval summary, and the most relevant recovery action. When no task is selected show project state and next action.

- [x] **Step 5: Wrap the current project surface in `WorkbenchShell`**

Preserve `?projectTask=` URLs and `onboarding=done`; replace the previous page header action row and long mixed page with workbench navigation, the extracted task surface, and context inspector.

- [x] **Step 6: Run focused project tests**

Run: `npx vitest run tests/unit/project-workbench.spec.tsx tests/unit/next-action.spec.ts && npm run typecheck`
Expected: PASS.

### Task 5: Full UX closure and regression gates

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles/global.css`
- Modify: `tests/e2e/regression.spec.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/product-completion.spec.ts`

**Interfaces:**
- Consumes: company and project workbench pages from Tasks 3 and 4.
- Produces: final responsive, accessible product behavior and updated acceptance coverage.

- [x] **Step 1: Reduce the global top navigation while preserving single-column page access**

On workbench routes, show brand and workbench header only; expose global destinations through the brand menu and `⌘ K`. On single-column routes keep the existing simple top navigation.

- [x] **Step 2: Add E2E coverage for the approved behavior**

```ts
await expect(page.getByRole('navigation', { name: '项目工作列表' })).toBeVisible();
await page.getByRole('button', { name: '收起现场信息' }).click();
await expect(page.getByRole('complementary', { name: '项目现场' })).toBeHidden();
await page.reload();
await expect(page.getByRole('complementary', { name: '项目现场' })).toBeHidden();
```

- [x] **Step 3: Verify tablet and mobile drawers**

At 1024px the right inspector must overlay; at 390px only the center surface is initially visible, both pane buttons open accessible drawers, Escape closes them, and `document.documentElement.scrollWidth <= window.innerWidth`.

- [x] **Step 4: Run all code-level gates**

Run: `npm test && npm run typecheck && npm run build && npm run test:product-acceptance && PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e && git diff --check`
Expected: 0 exit status for every command. Real CLI connectivity tests remain excluded by user instruction.

- [x] **Step 5: Side-browser acceptance**

Open a company and a software project in the isolated fake-executor environment. Confirm the three-step guide, pane toggles, URL restoration, automatic inspector changes, software template isolation, no console errors, and no horizontal overflow.
