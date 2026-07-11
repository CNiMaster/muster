# Muster vNext Unified Executor and Permission Platform Implementation Plan

**Goal:** Replace provider-specific settings and the `skipPermissions` shortcut with reusable executor profiles, versioned adapter manifests, isolated execution runs, and an auditable `approval policy × allowed scope` permission system.

**Architecture:** Keep the existing `ExecutionAdapter` runtime boundary, but resolve every employee run through an immutable executor profile snapshot. A built-in manifest registry describes CLI/API capabilities and detection. Permission evaluation belongs to Muster and produces allow, deny, or approval-required decisions before adapters receive tools/paths. Existing settings and `executor_json` remain compatible through backfill and translation.

**Out of scope:** Template marketplace/sharing, remote SaaS, silent installation, and automatic high-risk approval.

---

## Task 1: Persist adapter manifests, executor profiles, and execution runs

**Files:**
- Add `src/server/db/migrations/0020_executor_platform.sql`
- Add `src/server/executors/manifests.ts`
- Add `src/server/domain/executor-profile.ts`
- Test `tests/integration/executor-profile.spec.ts`

**Requirements:**
- Built-ins: Codex CLI, Claude Code CLI, Gemini CLI, OpenAI-compatible API, Gemini API, custom CLI.
- Profiles store manifest ID/version, fixed configuration, credential reference, install origin/path, and concurrency mode.
- Execution runs snapshot profile/manifest/config so later edits cannot change an active Task.
- Backfill one compatible Claude/API profile and translate legacy employee executor settings without changing employee IDs.
- Never persist secret values; only environment/keychain/login references.

## Task 2: Bind employees to fixed executor profiles and isolate shared executors

**Files:**
- Modify `src/server/domain/agent.ts`
- Modify `src/server/domain/agent-profile.ts`
- Modify `src/server/task-engine/engine.ts`
- Add `src/server/executors/run-isolation.ts`
- Test `tests/integration/executor-isolation.spec.ts`

**Requirements:**
- Employee binding points to one executor profile; company default may seed it but no mid-Task fallback or silent switching.
- Two employees sharing a profile receive distinct run IDs, Agent Homes, sessions, worktrees, logs, temp/config directories, abort controllers, and Task state.
- Manifests declare `parallel`, `profile-serial`, or `global-serial`; locks are scoped accordingly and visible through API.
- Existing provider adapters continue working through the resolved snapshot.

## Task 3: Implement permission policy, scope, rules, and approval lifecycle

**Files:**
- Add `src/server/db/migrations/0021_permission_policy.sql`
- Add `src/server/domain/permission.ts`
- Add `src/server/api/permissions.ts`
- Modify `src/server/sandbox.ts`
- Modify `src/server/executors/tools/file-tools.ts`
- Test `tests/integration/permission-policy.spec.ts`

**Policy:** `ask-always | ask-by-rule | no-approval | deny`.

**Scope:** `task | project | workspace | selected-directories | device`.

**Approval actions:** deny, allow once, always allow command, always allow directory, or save a custom rule. Rules can constrain command/arguments/path/file type/employee/company/project/network/subprocess/expiry.

**Safety:** deleting outside a project, system install, credential access, push/deploy, external messages, account actions, and paid actions stay separately high risk. Ordinary Turbo does not grant them.

## Task 4: Map CLI/API capabilities through one permission gateway

**Files:**
- Modify `src/server/executors/claude-code-adapter.ts`
- Add `src/server/executors/codex-cli-adapter.ts`
- Add `src/server/executors/gemini-cli-adapter.ts`
- Add `src/server/executors/custom-cli-adapter.ts`
- Modify `src/server/executors/openai-adapter.ts`
- Modify `src/server/executors/gemini-adapter.ts`
- Test `tests/integration/permission-adapter-mapping.spec.ts`

**Requirements:**
- CLI flags are derived from manifest + evaluated policy, not directly from `skipPermissions`.
- API tools use the same run worktree, path rules, approvals, artifacts, and publish queue as CLI.
- Unsupported manifest capabilities fail visibly; they never silently become unrestricted.
- Custom CLI command templates use argument arrays and explicit placeholders; no shell interpolation.

## Task 5: Add system detection, official-install guidance, and connection diagnostics

**Files:**
- Add `src/server/domain/executor-discovery.ts`
- Add `src/server/api/executors.ts`
- Modify `src/server/api/settings.ts`
- Test `tests/integration/executor-discovery.spec.ts`

**Workflow:** detect system install → show official source and supported commands → open official guide → user installs through the official mechanism → re-detect → bind exact system path/version → official login → connection and sandbox test.

**Requirements:**
- Muster does not bundle or privately copy Codex, Claude Code, or Gemini CLI.
- System installations are detected and recorded but never silently installed or upgraded.
- Official commands are copyable and the authoritative installation guide opens from the app.
- Re-detection creates a fixed Executor Profile for the exact executable path; official login and updates remain owned by the vendor CLI.

## Task 6: Replace settings UI with executor and permission center

**Files:**
- Add `src/client/pages/ExecutorCenterPage.tsx`
- Add `src/client/components/PermissionPolicyEditor.tsx`
- Add `src/client/components/ApprovalInbox.tsx`
- Modify `src/client/pages/AgentProfilePage.tsx`
- Modify `src/client/pages/SettingsPage.tsx`
- Modify `src/client/App.tsx`
- Modify client hooks/types
- Add/modify Playwright coverage

**UX:**
- Simple mode shows executor, connection state, model, permission preset, and a single test button.
- Advanced mode exposes manifest version, install source, concurrency limitation, credential reference, policy/scope, and custom rules.
- Turbo is a preset switch with an always-visible scope selector and high-risk exclusions summary.
- Approval inbox explains employee, Task, exact command/action, path, risk, requested scope, and all five decisions.

## Task 7: Compatibility cleanup, acceptance, and documentation

**Files:**
- Modify `CLAUDE.md`
- Modify `docs/agent-company-implementation-checklist.md`
- Modify this plan

**Acceptance:**
```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
git diff --check
```

**Runtime audit:**
- legacy settings migrate without losing working Claude/OpenAI/Gemini setups
- two employees on one executor cannot share session, files, logs, abort state, or memory
- task/project/workspace scopes allow only their declared roots
- Turbo remains bounded by scope and does not bypass high-risk categories
- approval decisions and reusable rules are durable and auditable
- API and CLI actions reach the same permission decision for equivalent file operations
- install workflow cannot execute without explicit confirmation

**Commit:** `docs: record executor and permission platform acceptance`
