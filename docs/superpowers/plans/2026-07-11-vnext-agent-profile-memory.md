# Muster vNext Agent Profile and Memory Implementation Plan

> ⚠️ 历史注记（2026-08-16）：Agent Profile/分层记忆/Agent Home 仍为现行服务端设计；文中 CompanyPage 引用已随公司退场失效。

**Status:** Completed and verified on 2026-07-11.

**Acceptance:** `npm test` 40 files / 270 tests, `npm run typecheck`, `npm run build`, `npm run test:e2e` 10/10, and `git diff --check` all passed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and red-green-refactor for every runtime task.

**Goal:** Give every Muster employee a stable global identity, an isolated Agent Home, reusable capabilities, reviewable layered memory, and session reconstruction that survives executor-session loss.

**Architecture:** Preserve the existing `agent` row and ID as the compatibility-facing company employment identity so current Task/thread/graph foreign keys remain valid. Add authoritative `agent_profile` and `company_employee` records, backfill them for every existing agent, and dual-write through the agent domain. Store indexed metadata and provenance in SQLite; materialize human-readable identity and approved memory snapshots beneath `.muster/agents/{profileId}`. Session compaction flushes memory candidates before rotating but never destroys the previous session on failure.

**Tech Stack:** TypeScript, better-sqlite3, Express, React, TanStack Query, Vitest, Playwright, local Markdown/YAML files.

## Global constraints

- Historical company, agent, project, Task, thread, graph, usage, session, and artifact IDs remain valid.
- `agent_profile` is global/user-local; `company_employee` is company-scoped; project memory is project-scoped.
- Existing `agent.id` remains the runtime employee ID during compatibility migration.
- Agent Home never lives inside a project repository and is never published by a Task.
- Identity/capability files contain no credentials, session IDs, project paths, or private memory exports.
- Personal long-term memory and Skill promotion require approval by default; project facts may auto-approve.
- Every memory has scope, provenance, confidence, approval state, version, and optional expiry.
- Context retrieval is bounded and deterministic; full histories are searched on demand rather than injected wholesale.
- `.zcode/` remains local and untracked.

---

## Task 1: Add compatible Agent Profile and Company Employee persistence

**Files:**
- Create `src/server/db/migrations/0016_agent_profile.sql`
- Create `src/server/domain/agent-profile.ts`
- Modify `src/server/domain/agent.ts`
- Modify `src/client/api/types.ts`
- Test `tests/integration/agent-profile.spec.ts`

**Schema:**

- `agent_profile`: stable identity, display name, soul, principles JSON, capabilities JSON, recommended executor/permission JSON, base version, timestamps.
- `company_employee`: ID, profile ID, company ID, legacy agent ID, role/department/responsibility snapshot, executor/permission binding, timestamps.
- Add nullable `profile_id` to `agent`, then backfill one profile and one employment record per existing agent in the migration.
- Unique employment compatibility constraint on `legacy_agent_id`; company/profile may repeat only when explicitly referencing the same profile in another company.

**TDD acceptance:**

- Existing agents receive profiles after migration.
- New `createAgent` creates profile + employment + legacy agent atomically when no profile is supplied.
- Recruiting an existing profile creates an isolated employment with the same profile ID and a distinct employee/agent ID.
- Updating company role does not mutate the global profile soul/capabilities.
- Deleting or archiving an employment does not delete its profile.

**Commit:** `feat: separate agent profiles from company employment`

---

## Task 2: Add Agent Profile REST APIs and employee library UI

**Files:**
- Create `src/server/api/agent-profiles.ts`
- Modify `src/server/server.ts`
- Modify `src/client/hooks/queries.ts`
- Create `src/client/pages/AgentLibraryPage.tsx`
- Create `src/client/pages/AgentProfilePage.tsx`
- Modify `src/client/routes.tsx`
- Modify `src/client/App.tsx`
- Modify `src/client/pages/CompanyPage.tsx`
- Test `tests/integration/agent-profile-api.spec.ts`
- Modify `tests/e2e/smoke.spec.ts`

**HTTP:**

- `GET/POST /api/agent-profiles`
- `GET/PATCH /api/agent-profiles/:id`
- `GET /api/agent-profiles/:id/employments`
- `POST /api/companies/:companyId/employees` with `{ profileId, role, ... }`

**UX acceptance:**

- Global “员工库” lists stable profiles independently of companies.
- Profile page separates identity/capabilities from company employments.
- Company page can recruit an existing profile or create a new profile.
- Existing company employee editing continues to work.

**Commit:** `feat: add reusable employee library`

---

## Task 3: Materialize isolated Agent Home identity and capability files

**Files:**
- Create `src/server/domain/agent-home.ts`
- Modify `src/server/domain/agent-profile.ts`
- Modify `src/server/env.ts` only if a derived agents directory helper is needed
- Test `tests/integration/agent-home.spec.ts`

**Layout:**

```text
{MUSTER_HOME}/agents/{profileId}/
  profile/SOUL.md
  profile/principles.md
  profile/capabilities.json
  profile/skills/
  memory/CORE.md
  memory/USER.md
  memory/daily/
  memory/lessons/
  companies/{companyId}/
  projects/{projectId}/
  sessions/{threadId}/
  scratch/
```

**TDD acceptance:**

- Creating/backfilling a profile idempotently materializes the layout.
- File paths are derived from validated opaque IDs and cannot escape the agents root.
- Identity updates use temp-file + rename and keep database/file views consistent.
- Capability export excludes memory, company/project/session/scratch, credentials, and paths.

**Commit:** `feat: create isolated agent homes`

---

## Task 4: Add layered memory entries, candidates, versions, and search

**Files:**
- Create `src/server/db/migrations/0017_agent_memory.sql`
- Create `src/server/domain/memory.ts`
- Create `src/server/api/memory.ts`
- Modify `src/server/server.ts`
- Modify `src/client/api/types.ts`
- Modify `src/client/hooks/queries.ts`
- Test `tests/integration/memory.spec.ts`

**Scopes:** `personal | company | project | skill`

**States:** candidate `pending | approved | rejected`; entry `active | locked | superseded | deleted`.

**TDD acceptance:**

- Candidate creation records source Task/message, author, confidence, expiry, and influence permission.
- Personal and skill candidates default pending; project facts can be auto-approved.
- Approval creates a versioned entry; correction supersedes rather than silently overwrites.
- Deletion is auditable; locked memory cannot be changed without explicit unlock.
- FTS search always filters by profile and allowed current company/project scope.
- Basic prompt-injection/credential-exfiltration patterns quarantine candidates for review.

**Commit:** `feat: add reviewable layered agent memory`

---

## Task 5: Build memory review and profile controls

**Files:**
- Create `src/client/components/MemoryReviewPanel.tsx`
- Modify `src/client/pages/AgentProfilePage.tsx`
- Modify `src/client/styles/global.css`
- Modify `tests/e2e/smoke.spec.ts`

**UX acceptance:**

- User can filter personal/company/project candidates.
- Diff/provenance is visible before approve/reject.
- Approved memory can be corrected, locked, unlocked, or deleted.
- “清除项目记忆” never clears personal memory.
- Beginner page shows counts and plain-language effects; provenance/version details are advanced.

**Commit:** `feat: add employee memory review center`

---

## Task 6: Flush memory before compaction and rebuild execution context

**Files:**
- Modify `src/server/domain/thread.ts`
- Modify `src/server/executors/context.ts`
- Modify `src/server/task-engine/engine.ts`
- Modify `src/server/domain/memory.ts`
- Test `tests/integration/session-compaction.spec.ts`
- Test `tests/integration/context-memory.spec.ts`

**Execution context order:**

1. profile soul and principles
2. company employment role and charter
3. project goal and approved decisions
4. thread compaction summary
5. bounded relevant memory search and recent Tasks
6. current Task package
7. contacts, workflow, permissions, tools

**TDD acceptance:**

- Compaction first extracts/persists decision, commitment, dependency, and blocker candidates.
- Flush failure leaves the old executor session and compaction summary untouched.
- Successful compaction preserves the old session reference, rotates to a new session, and injects reconstructable context.
- Missing executor session still produces identity/company/project/memory context sufficient for a response.
- Two profiles sharing one executor never retrieve each other's personal memory.

**Commit:** `feat: rebuild employee context from layered memory`

---

## Task 7: Implement local reuse, snapshot, and reset semantics

**Files:**
- Modify `src/server/domain/agent-profile.ts`
- Modify `src/server/domain/agent-home.ts`
- Modify `src/server/domain/memory.ts`
- Modify `src/server/api/agent-profiles.ts`
- Modify `src/client/pages/AgentProfilePage.tsx`
- Test `tests/integration/agent-profile-reuse.spec.ts`

**Modes:**

- `capability-copy`: new profile, identity/capabilities only, no memory.
- `snapshot-copy`: new profile, selected personal memory copied with provenance, then independent growth.
- `reference`: no new profile; create another company employment pointing to the same profile.

**Reset:**

- “恢复基础能力” restores the versioned base identity/capabilities while preserving memory unless separately selected.
- “清空个人记忆” requires explicit confirmation and does not remove abilities/employments.
- Capability export is memory-free and passes a forbidden-field/path scan.

**Commit:** `feat: support safe employee reuse and reset`

---

## Task 8: Acceptance and documentation

**Files:**
- Modify `CLAUDE.md`
- Modify `docs/agent-company-implementation-checklist.md`
- Modify this plan

**Verification:**

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
git diff --check
```

**Runtime audit:**

- existing employee data backfills without ID changes
- employee library survives restart
- same profile can work in two companies with isolated role/project context
- two profiles on one executor do not share memory/session/worktree
- memory approval, correction, lock, delete, scope filters, and provenance work
- compaction failure is non-destructive; session loss can reconstruct context
- capability-only export contains no memory, credential, session, path, company, project, or Task data

Keep executor/permission platform, template platform, and sharing ecosystem explicitly pending.

**Commit:** `docs: record Agent Profile and memory acceptance`
