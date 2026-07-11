# Muster vNext Guided Workspace Foundation Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first working vNext vertical: a safe company-to-project onboarding flow, a persistent total workspace, an action-first home/project experience, last-project resume, readable fallback errors, and progressive settings.

**Architecture:** Add a persistent Workspace domain without replacing the current Project table, then route project default directories through the active workspace. Keep existing company, novel template, Task engine, worktree, and publish queue behavior intact. Build the new user journey by composing existing APIs and adding small focused UI components rather than rewriting the application shell.

**Tech Stack:** TypeScript 5.7, React 19, React Router 7, TanStack Query 5, Express 5, better-sqlite3, Vitest, Playwright, Git worktrees.

## Global Constraints

- Preserve all existing company, project, Task, worktree, publish, trigger, conversation, artifact, report, and usage data.
- Add migrations only; do not rename historical migrations.
- Every Task continues to write through an isolated worktree and the existing publish queue.
- Company creation does not strand the user before project creation.
- Raw CLI commands, JSON schemas, stack traces, API bodies, and local secrets never appear in beginner-facing copy.
- Existing novel company creation remains supported while the UI becomes template-neutral at the shell level.
- `.zcode/` remains local and is never staged.
- Each implementation task follows red-green-refactor and ends in a focused commit.

## Plan Decomposition

The approved vNext spec spans independent subsystems. This plan implements the foundation and guided workbench only. Later plans, executed after this one is green, are:

1. `vnext-agent-profile-and-memory` — AgentProfile, CompanyEmployee, Agent Home, memory candidates, flush, search, and compaction.
2. `vnext-executor-and-permission-platform` — ExecutorProfile/Manifest, Codex CLI, approval rules, and Turbo scope.
3. `vnext-capability-and-template-platform` — persona governance, capability packages, novel template v1, and software company v1.
4. `vnext-sharing-ecosystem` — signed memory-free employee and company packages.

---

### Task 1: Sanitize Setup Assistant Fallback Messages

**Files:**
- Modify: `src/server/domain/setup-assistant.ts`
- Test: `tests/integration/setup-assistant.spec.ts`

**Interfaces:**
- Produces: `formatProposalFallbackWarning(kind: 'company' | 'agent' | 'project'): string`
- Preserves: `ProposalResult<T> = { source, proposal, warning? }`

- [ ] **Step 1: Write the failing fallback-copy test**

Add assertions that a failed company proposal returns a short user-facing warning and does not contain the failed executable path, command flags, schema, stderr, or the injected sentinel `SECRET_DIAGNOSTIC`.

```ts
expect(company.warning).toBe('智能方案暂时不可用，已为你载入可编辑的默认团队配置。');
expect(company.warning).not.toContain('SECRET_DIAGNOSTIC');
expect(company.warning).not.toContain('--json-schema');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/integration/setup-assistant.spec.ts`

Expected: FAIL because the current warning appends the underlying process error.

- [ ] **Step 3: Implement stable fallback copy**

Add a pure formatter and use it in each fallback path:

```ts
export function formatProposalFallbackWarning(kind: 'company' | 'agent' | 'project'): string {
  const labels = {
    company: '默认团队配置',
    agent: '默认员工配置',
    project: '默认项目蓝图',
  } as const;
  return `智能方案暂时不可用，已为你载入可编辑的${labels[kind]}。`;
}
```

Keep the original exception in server logs only.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/integration/setup-assistant.spec.ts`

Expected: all setup-assistant tests pass with no raw diagnostic in response payloads.

- [ ] **Step 5: Commit**

```bash
git add src/server/domain/setup-assistant.ts tests/integration/setup-assistant.spec.ts
git commit -m "fix: hide setup assistant diagnostics from users"
```

### Task 2: Add the Persistent Total Workspace Domain

**Files:**
- Create: `src/server/db/migrations/0015_workspace.sql`
- Create: `src/server/domain/workspace.ts`
- Create: `src/server/api/workspaces.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/domain/project.ts`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/hooks/queries.ts`
- Test: `tests/integration/workspace.spec.ts`
- Test: `tests/integration/project.spec.ts`

**Interfaces:**
- Produces: `Workspace`, `listWorkspaces(db)`, `getActiveWorkspace(db)`, `createWorkspace(db, input)`, `setActiveWorkspace(db, id)`
- Produces HTTP: `GET /api/workspaces`, `POST /api/workspaces`, `POST /api/workspaces/:id/activate`
- Project default directory consumes `getActiveWorkspace(db)?.rootDir`

- [ ] **Step 1: Write failing workspace-domain tests**

Cover creation, one active workspace, activation switching, duplicate canonical root rejection, and project default paths beneath the active workspace.

```ts
const workspace = createWorkspace(db, { name: '主工作区', rootDir: '/tmp/muster-main' });
expect(getActiveWorkspace(db)?.id).toBe(workspace.id);

const project = createProject(db, { companyId: company.id, name: '商城' });
expect(project.rootDir).toContain('/tmp/muster-main/companies/公司/projects/商城-');
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/integration/workspace.spec.ts tests/integration/project.spec.ts`

Expected: FAIL because workspace migration/domain do not exist and project defaults still use `~/muster-projects`.

- [ ] **Step 3: Add migration and focused domain implementation**

Use this schema:

```sql
CREATE TABLE workspace (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_dir   TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX workspace_single_active ON workspace(is_active) WHERE is_active = 1;
```

Canonicalize roots with `resolve(input.rootDir.trim())`. `createWorkspace` activates the first workspace automatically; `setActiveWorkspace` changes active state in one transaction.

- [ ] **Step 4: Route default project paths through Workspace**

Change `defaultRootDir` to accept the DB-derived workspace root:

```ts
function defaultRootDir(workspaceRoot: string, companyName: string, projectName: string, projectId: string): string {
  return join(
    workspaceRoot,
    'companies',
    sanitizePathSegment(companyName),
    'projects',
    `${sanitizePathSegment(projectName)}-${sanitizePathSegment(projectId)}`,
  );
}
```

When no active workspace exists, preserve compatibility with `join(homedir(), 'MusterWorkspace')` and lazily create the default workspace row before deriving the project path.

- [ ] **Step 5: Add REST routes and client hooks**

Expose typed workspace queries and mutations. Successful create/activate mutations invalidate `['workspaces']`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npx vitest run tests/integration/workspace.spec.ts tests/integration/project.spec.ts`

Expected: workspace and project tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0015_workspace.sql src/server/domain/workspace.ts src/server/api/workspaces.ts src/server/server.ts src/server/domain/project.ts src/client/api/types.ts src/client/hooks/queries.ts tests/integration/workspace.spec.ts tests/integration/project.spec.ts
git commit -m "feat: add persistent Muster workspaces"
```

### Task 3: Build a Dynamic Next-Action Model

**Files:**
- Create: `src/client/domain/next-action.ts`
- Create: `src/client/components/NextActionCard.tsx`
- Modify: `src/client/pages/HomePage.tsx`
- Modify: `src/client/pages/CompanyPage.tsx`
- Modify: `src/client/pages/ProjectPage.tsx`
- Modify: `src/client/styles/global.css`
- Test: `tests/unit/next-action.spec.ts`

**Interfaces:**
- Produces: `deriveNextAction(input: NextActionInput): NextAction`
- Produces UI: `<NextActionCard action={action} />`

- [ ] **Step 1: Write failing state-table tests**

Cover these exact states:

```ts
expect(deriveNextAction({ companies: [], projects: [], attentionCount: 0 })).toMatchObject({ kind: 'create-company' });
expect(deriveNextAction({ companies: [company], projects: [], attentionCount: 0 })).toMatchObject({ kind: 'create-project' });
expect(deriveNextAction({ companies: [company], projects: [project], attentionCount: 2 })).toMatchObject({ kind: 'handle-attention' });
expect(deriveNextAction({ companies: [company], projects: [project], attentionCount: 0 })).toMatchObject({ kind: 'publish-task' });
```

- [ ] **Step 2: Run unit test and verify RED**

Run: `npx vitest run tests/unit/next-action.spec.ts`

Expected: FAIL because the derivation module does not exist.

- [ ] **Step 3: Implement pure next-action derivation**

Define a discriminated union containing `kind`, `title`, `description`, `label`, and `href`. Do not put React or query logic in the domain module.

- [ ] **Step 4: Implement one reusable action card**

The component renders one primary link/button and optional secondary text. It must not nest a `<button>` inside a `<Link>`; style the link directly as a button.

- [ ] **Step 5: Replace competing first-screen calls to action**

- Home with no company: one primary `开始创建公司` action.
- Company with no project: always show `创建第一个项目`, even when the company is online.
- Project: place `发布新任务` or `处理待确认` before dashboard/navigation links.

- [ ] **Step 6: Run unit and focused frontend tests**

Run: `npx vitest run tests/unit/next-action.spec.ts tests/unit/realtime.spec.ts`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/client/domain/next-action.ts src/client/components/NextActionCard.tsx src/client/pages/HomePage.tsx src/client/pages/CompanyPage.tsx src/client/pages/ProjectPage.tsx src/client/styles/global.css tests/unit/next-action.spec.ts
git commit -m "feat: guide users with contextual next actions"
```

### Task 4: Complete the Company-to-Project Onboarding Flow

**Files:**
- Modify: `src/client/pages/CompanyWizardPage.tsx`
- Modify: `src/client/pages/ProjectPage.tsx`
- Modify: `src/client/components/OnboardingGuide.tsx`
- Modify: `tests/e2e/regression.spec.ts`
- Modify: `tests/e2e/novel.spec.ts`

**Interfaces:**
- Consumes: existing `useCreateNovelCompany`, `useCompanyAction`, `useCreateProject`, `useCreateTask`
- Produces journey: company confirmation → `/companies/:id/projects/new?onboarding=1` → project/task creation → project detail

- [ ] **Step 1: Update E2E to describe the desired journey and verify RED**

The E2E must assert:

1. Confirming a company navigates directly to project creation.
2. The user creates a project without clocking the company out.
3. The company is online after the first Task is created.
4. Project detail contains the initial Task and a visible `发布新任务` action.

Run: `npx playwright test tests/e2e/regression.spec.ts --project=chromium`

Expected: FAIL at the navigation assertion because the current wizard lands on CompanyPage.

- [ ] **Step 2: Change company confirmation behavior**

Keep creating and clocking in the company, but navigate to:

```ts
navigate(`/companies/${data.company.id}/projects/new?onboarding=1`);
```

Use copy `团队已准备好，接下来创建第一个项目` instead of declaring onboarding complete.

- [ ] **Step 3: Keep project creation available while online**

Remove the `isOff` condition around the CompanyPage new-project action. Organization edits remain locked while online; project creation is not an organization mutation.

- [ ] **Step 4: Update onboarding copy**

Use the fixed order `创建公司 → 组建团队 → 创建项目 → 发布 Task`. Remove stale copy about selecting a single company type control that no longer exists.

- [ ] **Step 5: Run E2E and verify GREEN**

Run: `npx playwright test tests/e2e/regression.spec.ts tests/e2e/novel.spec.ts --project=chromium`

Expected: both flows pass.

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/CompanyWizardPage.tsx src/client/pages/CompanyPage.tsx src/client/pages/ProjectPage.tsx src/client/components/OnboardingGuide.tsx tests/e2e/regression.spec.ts tests/e2e/novel.spec.ts
git commit -m "fix: complete guided company onboarding"
```

### Task 5: Restore the Last Project and Preserve Navigation Context

**Files:**
- Create: `src/client/hooks/useRecentProject.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/pages/ProjectPage.tsx`
- Modify: `src/client/pages/HomePage.tsx`
- Test: `tests/unit/recent-project.spec.ts`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: `readRecentProjectId(storage)`, `writeRecentProjectId(storage, id)`, `useRecentProject(projectId?)`
- App navigation derives company context from `useProject(projectId)` when URL has no `companyId`

- [ ] **Step 1: Write failing storage-helper tests**

Test valid IDs, missing storage, malformed values, and clearing a deleted project ID. Use an injected `StorageLike` interface so unit tests do not require a browser.

- [ ] **Step 2: Run unit tests and verify RED**

Run: `npx vitest run tests/unit/recent-project.spec.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement recent-project persistence**

Store only the opaque project ID under `muster:last-project:v1`. Do not store paths, prompts, or project data in localStorage.

- [ ] **Step 4: Record visits and show resume action**

ProjectDetail calls `useRecentProject(projectId)`. HomePage shows `继续上次项目` when the ID still resolves; failed lookup clears the stale ID.

- [ ] **Step 5: Replace CompanyIndicator with ContextNavigation**

When the route has `projectId`, load the project, then its company. Render breadcrumbs/links:

```text
工作台 / 公司名 / 项目名 / 设置
```

Do not expose the project root path in the header. Put it in the advanced project details section with `overflow-wrap:anywhere`.

- [ ] **Step 6: Run tests and smoke E2E**

Run: `npx vitest run tests/unit/recent-project.spec.ts && npx playwright test tests/e2e/smoke.spec.ts --project=chromium`

Expected: all pass and project routes preserve a route back to the company.

- [ ] **Step 7: Commit**

```bash
git add src/client/hooks/useRecentProject.ts src/client/App.tsx src/client/pages/ProjectPage.tsx src/client/pages/HomePage.tsx tests/unit/recent-project.spec.ts tests/e2e/smoke.spec.ts
git commit -m "feat: resume the most recent project"
```

### Task 6: Split Basic and Advanced Settings and Fix Reflow

**Files:**
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/styles/global.css`
- Modify: `src/client/styles/components.css`
- Test: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Preserves existing `SystemSettings` API
- Produces beginner-facing connection summary plus `<details>` advanced sections

- [ ] **Step 1: Add E2E assertions for basic settings**

Assert the first viewport contains connection status/test and save controls, while CLI path, timeout, max tool calls, provider base URL, and Turbo-style permission toggles are inside collapsed advanced sections.

- [ ] **Step 2: Run focused E2E and verify RED**

Run: `npx playwright test tests/e2e/smoke.spec.ts --project=chromium`

Expected: FAIL because advanced fields are currently expanded.

- [ ] **Step 3: Recompose SettingsPage without changing persistence**

Basic section:

- current default executor
- connection status
- `运行连接测试`
- `保存设置`

Advanced `<details>` sections:

- CLI runtime
- permission and timeout limits
- provider/API defaults

- [ ] **Step 4: Add global reflow protections**

Add:

```css
html, body, #root { max-width: 100%; overflow-x: hidden; }
pre, code, .path-value, .diagnostic-text { overflow-wrap: anywhere; word-break: break-word; }
.page-header { min-width: 0; }
.page-header > * { min-width: 0; }
```

Ensure grids collapse at 900px and long paths/errors cannot increase page width.

- [ ] **Step 5: Run E2E and production build**

Run: `npx playwright test tests/e2e/smoke.spec.ts --project=chromium && npm run build`

Expected: E2E and build pass without horizontal overflow.

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/SettingsPage.tsx src/client/styles/global.css src/client/styles/components.css tests/e2e/smoke.spec.ts
git commit -m "refactor: simplify settings and responsive reflow"
```

### Task 7: Foundation Acceptance and Documentation Sync

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/agent-company-implementation-checklist.md`
- Modify: `docs/superpowers/plans/2026-07-11-vnext-guided-workspace-foundation.md`

**Interfaces:**
- No runtime interfaces; records verified delivered behavior and remaining vNext plans.

- [ ] **Step 1: Run the complete verification bundle**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
git diff --check
```

Expected:

- all Vitest files pass
- TypeScript exits 0
- server/client production build exits 0
- all Playwright tests pass
- no whitespace errors

- [ ] **Step 2: Perform runtime flow audit**

Using a fresh `MUSTER_HOME`, verify:

1. first screen has one primary company action
2. fallback proposal contains no raw command
3. company confirmation continues to project creation
4. first project can be created while company is online
5. first Task appears and runs in an isolated worktree
6. reload/home provides a return to the recent project
7. project navigation includes its company
8. settings hide advanced fields by default
9. no reviewed page has horizontal overflow at desktop or 640px width

- [ ] **Step 3: Update documentation and plan checkboxes**

Record only behavior proven by the commands and runtime audit. Keep later Agent Profile, memory, executor/permission, template, and sharing phases explicitly pending.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/agent-company-implementation-checklist.md docs/superpowers/plans/2026-07-11-vnext-guided-workspace-foundation.md
git commit -m "docs: record vNext foundation acceptance"
```
