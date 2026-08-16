# Company Collaboration Workflow Repair Implementation Plan

> ⚠️ 历史注记（2026-08-16）：公司模板/建司路径已删（固定员工 ensureWorkspaceStaff 取代）；workflow_node/edge 可执行协作序列仍现行。本计划为历史执行记录。

> **For agentic workers:** Execute this plan task-by-task with test-first changes and fresh verification before marking any item complete.

**Goal:** Make the first-use path produce a usable AI company: a template creates employees, reporting/contact relationships, a collaboration workflow and task handoff contract; users can publish complete work orders to a task pool; the first responsible employee can claim and redistribute them; the workbench remains usable on narrow screens.

**Architecture:** Keep `relationship` as the source of truth for employee reporting/contact permissions and keep `workflow_node`/`workflow_edge` as the executable collaboration sequence. Built-in company templates define both structures by stable employee keys; setup resolves keys to created agent IDs inside its existing transaction. Store the company-wide handoff standard in `company.contract_json.taskProtocol`, and copy its required-field metadata into each runtime task while allowing each work order to supply concrete values.

**Tech Stack:** TypeScript, React, Express, SQLite/better-sqlite3, Vitest, React Testing Library.

---

## Task 1: Seed a complete collaboration model from every company template

- [x] Extend `src/server/domain/company-templates.ts` with versioned task protocol, reporting edges, contact edges and a default employee collaboration workflow.
- [x] Extend `src/server/domain/company-setup.ts` draft preview and commit so all template structures are copied into the draft and persisted atomically.
- [x] Add failing-then-passing coverage in `tests/integration/company-setup.spec.ts` for non-empty organization/contact graphs, contact permissions, workflow nodes/edges, and persisted protocol defaults.
- [x] Keep the first project and project-task creation, executor/policy bindings and novel initialization inside the same rollback boundary.

## Task 2: Make task-pool claiming preserve ownership and provenance

- [x] Add a regression test to `tests/integration/task-engine.spec.ts`: an unassigned task claimed by the project's first employee must persist that employee as `assignee_agent_id`.
- [x] Update `src/server/domain/task.ts` atomic claim statement to bind the claiming thread's agent only when the work order was previously unassigned.
- [x] Verify tasks already assigned to another employee remain unclaimable and are never rewritten.

## Task 3: Publish structured work orders with a visible handoff contract

- [x] Add a small shared client domain helper for normalized `goal`, `background`, `references`, `acceptance` and `deliverables` protocol values.
- [x] Expand `src/client/pages/TasksPage.tsx` from a title-only row into a clear structured form and send the values in `inputProtocol`.
- [x] Show the input requirements and expected delivery fields as labeled content in `src/client/pages/TaskDetailPage.tsx` instead of relying only on raw JSON.
- [x] Cover protocol normalization and task form submission with focused unit tests.

## Task 4: Align setup/runtime feedback and collaboration-workflow language

- [x] Extract one preferred-executor selector and use it in the setup banner, automatic bindings, quick creation and readiness step.
- [x] Rename workflow-facing copy to “协作流程/员工交接” and explain the relationship between reporting/contact graphs and executable handoffs.
- [x] Replace ambiguous setup navigation labels with destination-aware copy where practical.
- [x] Update existing company wizard tests for the connected-executor display and draft-preservation behavior.

## Task 5: Make the three-pane workbench responsive after saved desktop state

- [x] Add pure preference normalization for desktop/tablet/mobile widths with unit tests in `tests/unit/workbench-preferences.spec.ts`.
- [x] Listen for breakpoint changes in `src/client/components/workbench/useWorkbenchPreferences.ts`; close both panes on mobile and prevent both drawers from opening simultaneously on tablet/mobile.
- [x] Verify resize behavior and existing persisted-width restoration remain stable.

## Task 6: Verify the full user path

- [x] Run focused red/green tests during every task with an isolated writable `MUSTER_HOME`.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run test:product-acceptance`.
- [x] Run `npm run build`.
- [x] Run `npm run test:e2e` (14/14, including the 390px viewport path).
- [x] Run `git diff --check` and inspect the final diff without touching unrelated `.zcode/` artifacts.
