# Schema-Driven Company Blueprint Platform Implementation Plan

> ⚠️ 历史注记（2026-08-16）：模板架构师 Skill 与声明式蓝图平台已随公司退场删除，蓝图语义由任务级 blueprint.ts 自动进化取代。本计划为历史执行记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first complete schema-driven company-template vertical slice: a Template Architect Skill generates a validated company blueprint, Muster renders it as a clear modular HTML review, users can create and later adjust the company, and employee/field Skill usage plus health findings remain explicit and traceable.

**Architecture:** Introduce a shared declarative template contract consumed by server and client. Built-in company templates become registered packages; the setup assistant generates a draft conforming to that contract, the server validates and normalizes it, and React renders trusted components rather than model HTML. Template installation snapshots and capability bindings are persisted so later knowledge-center and template-upgrade phases can build on stable data.

**Tech Stack:** TypeScript 5.7, Zod 3, Express 5, React 19, TanStack Query 5, better-sqlite3, Vitest, Testing Library, Playwright.

## Global Constraints

- Muster remains a general multi-Agent company workbench; no generic API or page may require novel-only enums.
- The Template Architect Skill generates structured data only; it never generates or executes arbitrary HTML, JavaScript, shell commands, or new Skills.
- HTML review is rendered by trusted React components; do not use `dangerouslySetInnerHTML`.
- Existing `general`, `software`, `content`, and `novel` setup behavior and existing novel project initialization remain compatible.
- Generated drafts are editable and must be confirmed before company creation.
- Built-in trusted Skills may be recommended and bound to employees; missing Skills create an explanatory health finding and are never installed automatically.
- Template updates and regeneration never silently overwrite user edits.
- New migrations use the next local numeric migration because this repository's SQLite migration chain is numeric; the Supabase timestamp rule is unrelated to this database.

---

### Task 1: Shared Declarative Company Blueprint Contract

**Files:**
- Create: `src/shared/company-template.ts`
- Create: `tests/unit/company-template-schema.spec.ts`
- Modify: `src/client/domain/company-templates.ts`
- Modify: `src/server/domain/company-templates.ts`

**Interfaces:**
- Produces: `CompanyTemplateDraft`, `CompanyTemplatePackage`, `KnowledgeModelDefinition`, `FieldMaintenanceContract`, `CapabilityBindingDefinition`, `TemplateHealthFinding`, `companyTemplateDraftSchema`, `companyTemplatePackageSchema`.
- Consumes: existing setup fields and workflow node/edge semantics from `src/server/domain/company-templates.ts`.

- [ ] **Step 1: Write failing shared-schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { companyTemplateDraftSchema } from '../../src/shared/company-template';

it('accepts a generic company blueprint with field ownership and views', () => {
  const parsed = companyTemplateDraftSchema.parse(makeBlueprint());
  expect(parsed.knowledgeModel.recordTypes[0]!.fields[0]!.maintenance.ownerRoleKey).toBe('lead');
});

it('rejects arbitrary executable presentation payloads', () => {
  expect(() => companyTemplateDraftSchema.parse({ ...makeBlueprint(), presentation: { density: 'guided', html: '<script />' } })).toThrow();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/unit/company-template-schema.spec.ts`

Expected: FAIL because `src/shared/company-template.ts` does not exist.

- [ ] **Step 3: Add the shared schemas and inferred types**

Define strict Zod objects for:

```ts
const fieldMaintenanceContractSchema = z.object({
  ownerRoleKey: z.string().min(1),
  collaboratorRoleKeys: z.array(z.string().min(1)).default([]),
  requiredCapabilityIds: z.array(z.string().min(1)).default([]),
  recommendedSkillIds: z.array(z.string().min(1)).default([]),
  inputRequirements: z.array(z.string().min(1)).default([]),
  outputRequirements: z.array(z.string().min(1)).default([]),
  updatePolicy: z.enum(['manual', 'event', 'schedule', 'on_demand']),
  reviewPolicy: z.enum(['direct', 'owner_review', 'lead_review']),
  failureGuideId: z.string().min(1).optional(),
}).strict();
```

The top-level draft must include existing setup data plus `summary`, `knowledgeModel`, `capabilityBindings`, `automations`, `healthFindings`, `presentation`, and `generation`.

- [ ] **Step 4: Replace duplicated client/server setup types with shared imports**

Keep compatibility exports in `src/client/domain/company-templates.ts`, but make `CompanyTemplateId` a string rather than a closed four-value union. Preserve `getProjectCreationPreset()` fallback behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --run tests/unit/company-template-schema.spec.ts tests/unit/company-templates.spec.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS after all shared type consumers are updated.

- [ ] **Step 6: Commit**

```bash
git add src/shared/company-template.ts src/client/domain/company-templates.ts src/server/domain/company-templates.ts tests/unit/company-template-schema.spec.ts
git commit -m "feat: define declarative company blueprint contract"
```

### Task 2: Template Registry and Deterministic Health Validation

**Files:**
- Create: `src/server/domain/template-registry.ts`
- Create: `src/server/domain/template-health.ts`
- Create: `tests/unit/template-health.spec.ts`
- Modify: `src/server/domain/company-templates.ts`

**Interfaces:**
- Consumes: `CompanyTemplatePackage` and `CompanyTemplateDraft` from Task 1.
- Produces: `listBuiltinCompanyTemplates()`, `getCompanyTemplatePackage(id)`, `validateCompanyTemplateDraft(draft)`.

- [ ] **Step 1: Write failing registry and health tests**

Cover duplicate keys, missing lead, unknown department, unknown field owner, unknown relation/view source, workflow references, communication gaps, missing Skill warnings, and a valid software template.

```ts
const findings = validateCompanyTemplateDraft(draft);
expect(findings).toContainEqual(expect.objectContaining({
  code: 'field_owner_missing',
  severity: 'blocking',
  path: 'knowledgeModel.recordTypes.requirement.fields.status',
}));
```

- [ ] **Step 2: Verify the focused tests fail**

Run: `npm test -- --run tests/unit/template-health.spec.ts`

Expected: FAIL because registry/validator modules do not exist.

- [ ] **Step 3: Convert the four built-ins into packages**

Each package must provide its own `knowledgeModel`, `capabilityBindings`, `automations`, `healthRules`, and `presentation`. Novel concepts remain only inside the novel package. Software must include requirements, modules, API contracts, risks, dependencies, and a release timeline so genericity is tested by a second vertical template.

- [ ] **Step 4: Implement deterministic validation**

Return findings with exact fields:

```ts
interface TemplateHealthFinding {
  id: string;
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  title: string;
  message: string;
  impact: string;
  recommendation: string;
  path?: string;
  action?: { kind: 'open_module' | 'replace_skill' | 'repair_draft'; target: string };
}
```

Never mutate the draft while validating.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- --run tests/unit/template-health.spec.ts tests/unit/company-template-schema.spec.ts tests/unit/company-templates.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/domain/template-registry.ts src/server/domain/template-health.ts src/server/domain/company-templates.ts tests/unit/template-health.spec.ts
git commit -m "feat: register and validate company template packages"
```

### Task 3: Persist Template Versions, Installations, and Capability Bindings

**Files:**
- Create: `src/server/db/migrations/0027_company_template_platform.sql`
- Create: `src/server/domain/template-installation.ts`
- Create: `tests/integration/template-installation.spec.ts`
- Modify: `src/server/domain/company-setup.ts`

**Interfaces:**
- Consumes: validated `CompanyTemplateDraft` and employee ids.
- Produces: `syncBuiltinTemplateVersions(db)`, `installCompanyTemplate(db, input)`, `getCompanyTemplateInstallation(db, companyId)`, `listCapabilityBindings(db, companyId)`.

- [ ] **Step 1: Write failing migration/domain integration tests**

Verify immutable version rows, idempotent built-in sync, full installation snapshot, employee Skill bindings, field-owner bindings, and rollback when company setup fails.

- [ ] **Step 2: Verify the test fails**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/template-installation.spec.ts`

Expected: FAIL because tables and domain functions do not exist.

- [ ] **Step 3: Add migration tables**

Create `template_definition`, `template_version`, `company_template_installation`, and `capability_binding`. Store immutable manifest JSON and validation JSON; enforce unique `(template_id, version)` and one active installation per company.

- [ ] **Step 4: Implement persistence and setup integration**

During `commitCompanySetup()`:

1. reject blocking findings;
2. create company/team/relationships/workflow/project as today;
3. persist the exact confirmed draft snapshot;
4. resolve role keys to created employee ids;
5. persist employee and field capability bindings;
6. keep the whole flow in the existing transaction.

- [ ] **Step 5: Run focused integration tests**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/template-installation.spec.ts tests/integration/company-setup.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0027_company_template_platform.sql src/server/domain/template-installation.ts src/server/domain/company-setup.ts tests/integration/template-installation.spec.ts tests/integration/company-setup.spec.ts
git commit -m "feat: persist company template installations"
```

### Task 4: Template Architect Skill and Generic Draft Generation

**Files:**
- Create: `skills/system/company-template-architect/SKILL.md`
- Create: `src/server/domain/template-architect.ts`
- Create: `tests/integration/template-architect.spec.ts`
- Modify: `src/server/domain/setup-assistant.ts`
- Modify: `src/server/api/company-setup.ts`
- Modify: `tests/integration/setup-assistant.spec.ts`

**Interfaces:**
- Consumes: a base package, user name/goal, installed Skill ids, executor capabilities, and permission policies.
- Produces: `generateCompanyTemplateDraft(input, generator): Promise<ProposalResult<CompanyTemplateDraft>>`.

- [ ] **Step 1: Write failing architect tests**

Cover valid generated blueprint, generic software output, invalid output repaired once, two invalid outputs falling back to the selected built-in template, warning sanitization, and no arbitrary HTML fields.

- [ ] **Step 2: Verify the tests fail**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/template-architect.spec.ts tests/integration/setup-assistant.spec.ts`

Expected: FAIL because the generic architect is not implemented.

- [ ] **Step 3: Add the Template Architect Skill instructions**

The Skill must explicitly distinguish itself from employee business Skills, require stable keys, assign each critical field to a role, explain each recommended Skill binding, keep user decisions minimal, and output only schema-compatible data.

- [ ] **Step 4: Implement structured generation with one repair attempt**

Use `SetupGenerator.generate()` with the shared JSON schema. After parse, run deterministic validation. If parsing or validation fails, send one repair prompt containing only normalized validation messages, then use the selected built-in draft fallback.

- [ ] **Step 5: Make `/api/company-setup/preview` asynchronous and generator-aware**

The API response remains a `CompanyTemplateDraft`. Add `generation.source` and sanitized `generation.warning` inside the draft so saved browser drafts preserve provenance.

- [ ] **Step 6: Run focused tests**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/template-architect.spec.ts tests/integration/setup-assistant.spec.ts tests/integration/company-setup.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/system/company-template-architect/SKILL.md src/server/domain/template-architect.ts src/server/domain/setup-assistant.ts src/server/api/company-setup.ts tests/integration/template-architect.spec.ts tests/integration/setup-assistant.spec.ts tests/integration/company-setup.spec.ts
git commit -m "feat: generate company blueprints with template architect"
```

### Task 5: Server-Driven Template Catalog

**Files:**
- Modify: `src/server/api/company-setup.ts`
- Modify: `src/client/hooks/queries.ts`
- Modify: `src/client/pages/CompanyWizardPage.tsx`
- Modify: `src/client/components/company/CompanySetupWizard.tsx`
- Modify: `src/client/domain/company-templates.ts`
- Modify: `tests/unit/company-setup-wizard.spec.tsx`

**Interfaces:**
- Consumes: `listBuiltinCompanyTemplates()`.
- Produces: `GET /api/company-setup/templates` and `useCompanyTemplateCatalog()`.

- [ ] **Step 1: Add a failing UI test for a server-provided template**

Pass a catalog containing a fifth template and assert that the wizard renders and selects it without modifying a client enum or `TEMPLATE_MARKS` record.

- [ ] **Step 2: Verify the test fails**

Run: `npm test -- --run tests/unit/company-setup-wizard.spec.tsx`

Expected: FAIL because the wizard uses a hard-coded catalog and marks.

- [ ] **Step 3: Add catalog API and query**

Return only safe summary fields: id, name, description, mark, color token, maturity, recommended use, and current version.

- [ ] **Step 4: Make the wizard catalog-driven**

Use a neutral fallback mark/color for unknown templates. Preserve current four templates during loading or API failure.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --run tests/unit/company-setup-wizard.spec.tsx tests/unit/company-templates.spec.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/api/company-setup.ts src/client/hooks/queries.ts src/client/pages/CompanyWizardPage.tsx src/client/components/company/CompanySetupWizard.tsx src/client/domain/company-templates.ts tests/unit/company-setup-wizard.spec.tsx
git commit -m "feat: load company templates from registry"
```

### Task 6: Modular HTML Blueprint Review

**Files:**
- Create: `src/client/components/company/CompanyBlueprintReview.tsx`
- Create: `tests/unit/company-blueprint-review.spec.tsx`
- Modify: `src/client/components/company/CompanySetupWizard.tsx`
- Modify: `src/client/styles/global.css`

**Interfaces:**
- Consumes: `CompanyTemplateDraft`, executor profiles, permission policies, and mutation callbacks.
- Produces: a trusted React-rendered review with module navigation and `guided | compact | visual` density.

- [ ] **Step 1: Write failing review tests**

Assert the six modules, recommended action, fixed post-create-adjustment hint, Skill usage explanation, collapsed advanced details, warning/blocking findings, density switching, and absence of model HTML rendering.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- --run tests/unit/company-blueprint-review.spec.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the six trusted modules**

Render company overview, team/responsibility, business information center, workflow/automation, capabilities/runtime, and risks/recommendations. Each recommended Skill row must display employee, purpose, and load trigger.

- [ ] **Step 4: Simplify wizard actions**

The main flow becomes:

1. choose base and describe company;
2. generate blueprint;
3. review the full modular blueprint;
4. optionally open module-level editing;
5. confirm executor defaults and create.

Keep the current saved-draft and failed-commit retention behavior.

- [ ] **Step 5: Add unified styles**

Use semantic `.blueprint-*` classes and existing design tokens. Do not add a chart or UI dependency.

- [ ] **Step 6: Run UI tests**

Run: `npm test -- --run tests/unit/company-blueprint-review.spec.tsx tests/unit/company-setup-wizard.spec.tsx tests/unit/workbench-shell.spec.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/components/company/CompanyBlueprintReview.tsx src/client/components/company/CompanySetupWizard.tsx src/client/styles/global.css tests/unit/company-blueprint-review.spec.tsx tests/unit/company-setup-wizard.spec.tsx
git commit -m "feat: review generated company blueprints"
```

### Task 7: Task-Level Skill Resolution and Explainable Context

**Files:**
- Create: `src/server/domain/capability-binding.ts`
- Create: `tests/integration/task-skill-resolution.spec.ts`
- Modify: `src/server/domain/task.ts`
- Modify: `src/server/executors/context.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: persisted company/employee/field bindings and Task metadata.
- Produces: `resolveTaskSkills(db, task): ResolvedTaskSkill[]` and context sections that explain why each Skill is loaded.

- [ ] **Step 1: Write failing resolution tests**

Verify that an employee's unrelated Skill is omitted, a field-required Skill is loaded, an explicit Task requirement wins, missing Skill creates a diagnostic, and legacy `agent.skills` names remain a fallback.

- [ ] **Step 2: Verify the test fails**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/task-skill-resolution.spec.ts`

Expected: FAIL because capability resolution does not exist.

- [ ] **Step 3: Implement deterministic resolution**

Return:

```ts
interface ResolvedTaskSkill {
  skillId: string;
  source: 'task' | 'field' | 'employee' | 'legacy';
  required: boolean;
  reason: string;
  content?: string;
  status: 'loaded' | 'missing' | 'disabled';
}
```

Do not search or install external Skills during Task execution.

- [ ] **Step 4: Add Task metadata and context assembly**

Store `requiredSkillIds` and knowledge targets in Task input protocol metadata without changing the Task state machine. Context must include only loaded Skills plus explicit missing/disabled diagnostics.

- [ ] **Step 5: Run focused tests**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/task-skill-resolution.spec.ts tests/integration/context-references.spec.ts tests/integration/task-engine.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/domain/capability-binding.ts src/server/domain/task.ts src/server/executors/context.ts src/shared/types.ts tests/integration/task-skill-resolution.spec.ts
git commit -m "feat: load task skills from capability bindings"
```

### Task 8: Health Findings and Guided Repair Surface

**Files:**
- Create: `src/server/db/migrations/0028_template_health_findings.sql`
- Create: `src/server/domain/template-health-findings.ts`
- Create: `src/server/api/template-health.ts`
- Create: `src/client/components/company/TemplateHealthPanel.tsx`
- Create: `tests/integration/template-health-findings.spec.ts`
- Create: `tests/unit/template-health-panel.spec.tsx`
- Modify: `src/server/server.ts`
- Modify: `src/client/hooks/queries.ts`
- Modify: `src/client/pages/CompanySettings.tsx`

**Interfaces:**
- Consumes: static validator results, runtime bindings, employees, Tasks, triggers, and template installation.
- Produces: persisted/deduplicated findings, list/dismiss endpoints, and guided action links.

- [ ] **Step 1: Write failing domain and UI tests**

Cover orphan field owners, missing Skill, broken trigger target, deduplication, resolved findings, blocking versus reminder behavior, and cards showing what/impact/cause/recommendation/action.

- [ ] **Step 2: Verify tests fail**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/template-health-findings.spec.ts tests/unit/template-health-panel.spec.tsx`

Expected: FAIL because health persistence and UI do not exist.

- [ ] **Step 3: Persist and expose findings**

Create `template_health_finding` in `0028_template_health_findings.sql` with unique `(company_id, fingerprint, state)` semantics, then expose list, refresh, dismiss, and resolve operations. Static validation remains in `template_version.validation_json`; this table stores company-specific runtime findings.

- [ ] **Step 4: Implement guided cards**

Actions may navigate to a module, employee, executor, permission, or workflow editor. Automatic repair only generates a new editable draft; it does not mutate a live company.

- [ ] **Step 5: Run focused tests**

Run: `MUSTER_HOME=/tmp/muster-template-tests npm test -- --run tests/integration/template-health-findings.spec.ts tests/unit/template-health-panel.spec.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0028_template_health_findings.sql src/server/domain/template-health-findings.ts src/server/api/template-health.ts src/client/components/company/TemplateHealthPanel.tsx src/server/server.ts src/client/hooks/queries.ts src/client/pages/CompanySettings.tsx tests/integration/template-health-findings.spec.ts tests/unit/template-health-panel.spec.tsx
git commit -m "feat: guide users through company template health issues"
```

### Task 9: Backward Compatibility, Product Acceptance, and Documentation

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/regression.spec.ts`
- Modify: `scripts/product-acceptance.ts`
- Modify: `docs/PRD-agent-company-workbench.md`
- Modify: `docs/agent-company-implementation-checklist.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified full creation flow and synchronized product documentation.

- [ ] **Step 1: Add end-to-end acceptance coverage**

Cover server-driven catalog, blueprint generation/fallback, six-module review, recommended creation, post-create edit hint, a visible employee Skill-use explanation, and a health issue linking to its configuration surface.

- [ ] **Step 2: Run focused E2E**

Run: `MUSTER_HOME=/tmp/muster-template-e2e npm run test:e2e -- --grep "company blueprint"`

Expected: PASS.

- [ ] **Step 3: Run the complete verification bundle**

Run: `npm run typecheck`

Expected: PASS.

Run: `MUSTER_HOME=/tmp/muster-template-full npm test -- --run`

Expected: all test files pass.

Run: `MUSTER_HOME=/tmp/muster-template-acceptance npm run test:product-acceptance`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `MUSTER_HOME=/tmp/muster-template-e2e npm run test:e2e`

Expected: all Playwright scenarios pass.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Synchronize documentation**

Document the template manifest, Template Architect generation boundary, React-only HTML rendering, capability-binding levels, health finding semantics, migration compatibility, and exact verification evidence.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/smoke.spec.ts tests/e2e/regression.spec.ts scripts/product-acceptance.ts docs/PRD-agent-company-workbench.md docs/agent-company-implementation-checklist.md CLAUDE.md
git commit -m "docs: complete schema-driven company template platform"
```

## Deferred Follow-Up Plans

The approved design also defines a complete generic knowledge-record store, relation/event editing, generic timeline/graph/board renderers, knowledge change proposals, and template upgrade diffs. Those are independent deep subsystems and will receive separate implementation plans after this vertical slice establishes the template contract, installation snapshot, blueprint review, capability binding, and health guidance they depend on.
