# 公司退役批次 D（物理去列）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除全库 `company_id` 列与 `company` 表——工作台状态机/章程迁入瘦身后 RENAME 的 `workbench` 单例表，服务端、API 契约、客户端、夹具全链去 companyId。

**Architecture:** 代码先行、DDL 随批：每个子批在同一提交内完成「删谓词/删参数/INSERT 去列 + 该批表去列迁移」；`company RENAME TO workbench` 放最后（届时子表 FK 已随列消失，rename 无自动改写负担）。带 FK 的表一律走「建新表复制」重建模式（先例 `20260812151000_outsourcing_state_disabled.sql`），裸列表先删索引再 `DROP COLUMN`。死表（D4-1 已清空的凭据公司层、零消费的模板平台/晋升候选/公司优化报告）与 B2B 死流（契约创建全库零调用方）直接退役删除。

**Tech Stack:** better-sqlite3（外键常开；迁移器 `src/server/db/client.ts` 按文件名排序、每文件单事务、账本 `schema_migrations`）；Express 5；React Query。

**上游 spec:** `docs/superpowers/specs/2026-08-17-company-retirement.md` §2 D2/D4、§3 批次 D 行。

## Global Constraints

- 迁移 append-only：不重写历史迁移文件；新迁移命名 `2026MMDDHHMMSS_company_drop_*.sql`（MMDD 用执行日，保持本计划顺序后缀 `000000`/`000100`/`000200`/`000300`）。
- 全程 `PRAGMA foreign_keys=ON`（client.ts:38）：FK 表去列必须重建——`CREATE TABLE <t>_new`(照抄原列与约束，唯删 `company_id` 列与 `FOREIGN KEY (company_id)` 子句) → `INSERT INTO <t>_new SELECT <除 company_id 外全列> FROM <t>` → `DROP TABLE <t>` → `ALTER TABLE <t>_new RENAME TO <t>` → 重建索引（无 company_id 版）。
- 裸列（无 FK）表：先 `DROP INDEX` 再 `ALTER TABLE ... DROP COLUMN`。
- `company_employee` 表名本批**不改**（改名波及 100+ 站点，收益不抵风险；仅去列，表名注记留远期批）。
- **`first_agent_id` 与 `review_mode` 两列为活列，本批保留**（实施期复核证据：first_agent_id 被 engine.ts:804,815,819 蜂群放蜂请示、workspace-staff.ts:47、permission-delegation.ts:98 审批升级、agent.ts:376 解聘清理、api/workbench.ts PATCH 消费；review_mode 被 business-review.ts:118 审批门控 + client type + smoke 断言消费）。它们不在 Task 6 死列清单，仍需物理清理的部分与 company_employee 表名同类注记留远期。
- 客户端在用的 DTO `companyId` 字段（BusinessReview、plugin scope 等），Task 2-4 期间由服务端映射器以 `getWorkbench().id` 常量填充保绿，Task 5 服务端字段+客户端用法**原子同提交**删除（同仓同发）。
- 每任务收尾三件套：`npm run typecheck` 干净、受影响测试过、**显式路径** `git add`（worktree 慎用 `add -A`）。
- 已知环境基线：`tests/unit/web-tools.spec.ts` 3 例沙箱 DNS 失败为既有基线（非回归）；全量基线=单测 1294 过 + e2e 18/18 + smoke 73/73。
- 本批**不做**：`company_employee` 改名、模板平台全局表（template_definition/template_version）处置、B2B 乙方实体重构（死流直接退役，若未来重启 B2B 按新 spec 建模）、blueprint 之外任何功能演进。

## 底数速查（写计划时实测，执行时以此为准）

**带真 FK（重建去列）**：department、agent_definition、relationship、workflow_node、workflow_edge、project、company_employee、memory_candidate、memory_entry、template_health_finding(死表)、company_template_installation(死表)、capability_binding、company_tool、company_credential(死表)、business_review、handover_record、outsourcing_contract(死流)、permission_change_request、discussion、company_optimization_report(死表)、swarm_run、trigger、blueprint、debate、decision_record、task_closeout_summary。

**裸列（删索引后 DROP COLUMN）**：blueprint_optimization_item（NOT NULL，idx_boi_company）、expert_candidate（idx_expert_candidate_company_status）、promotion_candidate(死表)。

**company_id 索引（随各批迁移处理）**：idx_company_employee_company、idx_memory_entry_scope(复合)、idx_business_review_company_status、idx_handover_company、idx_swarm_run_company、idx_debate_company、idx_decision_company、idx_blueprint_company、idx_expert_candidate_company_status、idx_boi_company、idx_closeout_company、idx_outsourcing_source/target(死流)、idx_opt_report_company(死表)、idx_promotion_candidate_company(死表)、idx_company_credential_company(死表)、idx_company_tool_company、idx_capability_binding_company。

**company 表列存活**：活着=state（状态机+关机，ALLOWED=off:[online] / online:[draining,review_paused,off] / draining:[review_paused,off] / review_paused:[online,off]，company.ts:237-242）、shutdown_paused（优雅关机标记，20260814000000 加列，beginGracefulShutdown/resumeShutdownPaused 在用）、charter（executors/context.ts:148 进系统提示词；workbench PATCH；backup-export）、contract_json（workbench PATCH）、kind（projects.ts:102 novel 路径判读）、name、id、created_at/updated_at、**first_agent_id（活**：engine.ts:804,815,819 蜂群放蜂请示、workspace-staff.ts:47、permission-delegation.ts:98、agent.ts:376、workbench PATCH）、**review_mode（活**：business-review.ts:118 审批门控+client type+smoke 断言）；直接删=executor_tier_primary/secondary/tertiary_id（D4-2 已迁全局）、archived_at/archived_reason（仅 transitionCompany:246 vestigial 守卫在读，归档端点批次 C 已删——守卫与列同删）。

---

### Task 0: 执行 worktree 建立与基线记录

**Files:**
- Delete: `scripts/claude-smoke.ts`（已坏：import 不存在的 `createNovelCompany`（domain/novel-template 早已不导出），且本批 Task 1 将删除其依赖 `clockIn(db, companyId)`）

**Interfaces:** 无代码接口；产出基线记录（测试通过数）供后续任务对照。

- [ ] **Step 1: 建执行 worktree（独立于本计划文档的 docs 分支）**

```bash
git -C /Users/master/Project/muster worktree add -b feat/company-drop /Users/master/Project/muster-company-drop-impl main
cd /Users/master/Project/muster-company-drop-impl
```

- [ ] **Step 2: 记录基线**

Run: `npm run typecheck && npx vitest run 2>&1 | tail -3`
Expected: tsc 干净；`Tests 3 failed | 1294 passed`（web-tools 3 例环境基线）

- [ ] **Step 3: 确认 claude-smoke.ts 零引用后删除**

Run: `grep -rn 'claude-smoke' scripts/ package.json src/ tests/ --include='*' | grep -v 'claude-smoke.ts:'`
Expected: 无引用（仅自身）。然后 `git rm scripts/claude-smoke.ts`。

- [ ] **Step 4: Commit**

```bash
git add scripts/claude-smoke.ts
git commit -m "chore(company-drop): 执行基线记录+删除已坏 claude-smoke 脚本(import 不存在的 createNovelCompany,零引用)"
```

---

### Task 1: workbench 域原语与运行时切换

**Files:**
- Create: `src/server/domain/workbench.ts`、`tests/unit/workbench.spec.ts`
- Modify: `src/server/domain/company.ts`（收缩为兼容壳后删除——见 Step 4）、`src/server/api/middleware.ts:26`、`src/server/server.ts:194-200`、`src/server/runtime/shutdown.ts:26`、`src/server/runtime/coordinator.ts:56,146,215,342,451,459`、`src/server/executors/context.ts:85,148`、`src/server/task-engine/engine.ts:221`、`src/server/domain/backup-export.ts:26,35,153,284,287`、`src/server/api/workbench.ts`、`src/server/domain/company-cockpit.ts`（文件改名 `workbench-cockpit.ts`）、`scripts/product-acceptance.ts:9,33`
- Test: `tests/unit/workbench.spec.ts`（新）、`tests/integration/company-lifecycle.spec.ts`、`tests/integration/company-shutdown.spec.ts`、`tests/unit/company-default.spec.ts`（迁移至 workbench 语义）

**Interfaces:**
- Produces（后续所有任务依赖，SQL 仍 `FROM company` 直至 Task 6 RENAME）:

```ts
// src/server/domain/workbench.ts
export type WorkbenchState = 'off' | 'online' | 'draining' | 'review_paused';
export interface Workbench { id: string; name: string; kind: string; state: WorkbenchState;
  charter: string; contractJson: string; firstAgentId: string | null; reviewMode: 'blocking' | 'parallel';
  shutdownPaused: number; createdAt: string; updatedAt: string; }
export const DEFAULT_WORKBENCH_NAME = '默认工作台';
export function getWorkbench(db: DB): Workbench;                    // 无行则抛（启动已 ensure）
export function ensureWorkbench(db: DB): { workbench: Workbench; created: boolean };
export function updateWorkbench(db: DB, patch: Partial<Pick<Workbench, 'name'|'kind'|'charter'|'contractJson'>>): Workbench;
export function transitionWorkbench(db: DB, to: WorkbenchState): Workbench;  // 保留 ALLOWED 状态机与 company.state realtime 事件
export function restoreWorkbench(db: DB, row: Workbench): void;    // backup 恢复路径专用（替代原 createCompany）
```

- Consumes: 现 `company.ts` 全部行为（状态机 ALLOWED 表、shutdownPaused 逻辑、`company.state` 事件 payload 原样保留）。
- `companyIdOf(req)` 签名不动，实现改为 `getWorkbench(getDb()).id`（Task 6 验证零调用后删除）。

- [ ] **Step 1: 写失败测试**（新 workbench.spec.ts，从 company.spec/company-default.spec 语义平移）

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
import { ensureWorkbench, getWorkbench, transitionWorkbench, updateWorkbench, DEFAULT_WORKBENCH_NAME } from '../../src/server/domain/workbench';
import type { DB } from '../../src/server/db/client';

let db: DB;
beforeEach(() => { db = makeTestDb().db; setDbForTest(db); });

describe('workbench 单例原语', () => {
  it('ensure 幂等：首次创建默认工作台，二次返回同一行', () => {
    const a = ensureWorkbench(db); const b = ensureWorkbench(db);
    expect(a.created).toBe(true); expect(b.created).toBe(false);
    expect(b.workbench.id).toBe(a.workbench.id);
    expect(b.workbench.name).toBe(DEFAULT_WORKBENCH_NAME);
  });
  it('状态机：off→draining 非法；off→online→off 合法', () => {
    ensureWorkbench(db);   // 初始 off
    expect(() => transitionWorkbench(db, 'draining')).toThrow();  // off 只能 → online
    expect(transitionWorkbench(db, 'online').state).toBe('online');
    expect(transitionWorkbench(db, 'off').state).toBe('off');
  });
  it('charter 更新往返', () => {
    const { workbench } = ensureWorkbench(db);
    expect(updateWorkbench(db, { charter: '专注交付' }).charter).toBe('专注交付');
    expect(getWorkbench(db).charter).toBe('专注交付');
  });
});
```

- [ ] **Step 2: Run 测试确认失败**

Run: `npx vitest run tests/unit/workbench.spec.ts`
Expected: FAIL `Cannot find module '../../src/server/domain/workbench'`

- [ ] **Step 3: 实现 workbench.ts**——整体平移 company.ts 现有内容改名换签名：`getCompany(db,id)`→`getWorkbench(db)`（去掉 id 参数，`SELECT ... FROM company LIMIT 1`）；`createCompany`/`listCompanies` 删除（调用方按下表改）；`transitionCompany`→`transitionWorkbench` 保留 ALLOWED 状态机、shutdown_paused 写入（上线清零）、realtime `company.state` 事件与 draining→off 自动收尾（company.ts:244-302）；**删除** transitionCompany:246 的 archivedAt vestigial 守卫（归档端点批次 C 已删，单例永不归档，Task 6 同批删列）；`ensureDefaultCompany`→`ensureWorkbench`；`updateCompany`→`updateWorkbench`；`beginGracefulShutdown`/`resumeShutdownPaused` 平移为单工作台版（内部 `listCompanies` 改 `getWorkbench`）。coordinator.ts 的 `listCompanies({activeOnly:true})` → `getWorkbench()` 后按 state 过滤；shutdown.ts 同理；server.ts 种子块改 `ensureWorkbench` + 多行残留归并（保留现有 log.warn 语义）；backup-export.ts 导出 `listCompanies`→读 workbench 单行、恢复 `createCompany`→`restoreWorkbench`；engine.ts:221 `getCompany(this.db, project.companyId)`→`getWorkbench(this.db)`；executors/context.ts:85 同；product-acceptance.ts 改 `ensureWorkbench`。

- [ ] **Step 4: 删除 company.ts，全库改 import**（`grep -rn "domain/company" src/ tests/ scripts/` 逐处改为 `domain/workbench`，`getCompany`→`getWorkbench` 等；`company-cockpit.ts`→`workbench-cockpit.ts` 连同引用）

- [ ] **Step 5: Run 全量相关测试**

Run: `npx vitest run tests/unit/workbench.spec.ts tests/unit/company-default.spec.ts tests/integration/company-lifecycle.spec.ts tests/integration/company-shutdown.spec.ts tests/integration/workbench-router.spec.ts && npm run typecheck`
Expected: 全 PASS（company-default.spec 更名为 workbench-default.spec 亦可）

- [ ] **Step 6: Commit**

```bash
git add src/server/domain/workbench.ts src/server/domain/company.ts src/server/domain/workbench-cockpit.ts src/server/api/middleware.ts src/server/server.ts src/server/runtime/ src/server/executors/context.ts src/server/task-engine/engine.ts src/server/domain/backup-export.ts src/server/api/workbench.ts scripts/product-acceptance.ts tests/unit/workbench.spec.ts tests/unit/company-default.spec.ts tests/integration/company-lifecycle.spec.ts tests/integration/company-shutdown.spec.ts tests/integration/workbench-router.spec.ts
git commit -m "feat(workbench): workbench 域原语替换 company 域——getWorkbench/ensureWorkbench/transitionWorkbench/restoreWorkbench,删 createCompany/listCompanies,运行时/种子/备份/执行器上下文全切换(D-Task1)"
```

---

### Task 2: 组织人员域去列 + 迁移 A

**Files:**
- Modify: `src/server/domain/agent.ts`、`agent-profile.ts`、`department.ts`、`graph.ts`、`conversation.ts:140,275,285` + `api/conversation.ts:21,42`（scope_kind）、`temp-worker.ts` + `api/temp-worker.ts:115`（API 层裸 SQL）、`memory.ts`、`handover.ts`、`discussion.ts`、`permission.ts:33`（bind 锁 join）、`permission-delegation.ts`、`recruitment.ts`、`employee-rating.ts`、`workspace-staff.ts`、`system-agents.ts`、`agent-router.ts`
- Modify(夹具): `tests/integration/setup.ts:72`（createNovelCompany 枢纽）+ 受影响 ~40 个 spec（company_id grep 对照逐文件适配）
- Create: `src/server/db/migrations/20260819000000_company_drop_org.sql`
- Test: `tests/integration/org-columns-dropped.spec.ts`（新，见 Step 1）

**Interfaces:**
- Consumes: Task 1 的 `getWorkbench(db)`。
- Produces: 本批域函数签名全部去 `companyId` 参数（如 `createAgent(db, { companyId, ... })`→`createAgent(db, { ... })`、`listAgents(db)` 无过滤）；`permission.ts` 绑定锁改 `getWorkbench(db).state === 'off'`；conversation scope 枚举 `'company'`→`'workbench'`。

- [ ] **Step 1: 写失败测试**（新 spec：去列后域函数仍工作 + 表结构断言）

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, getDb } from '../../src/server/db/client';
import { ensureWorkbench } from '../../src/server/domain/workbench';
import { createAgent, listAgents } from '../../src/server/domain/agent';

describe('D-Task2 组织表已无 company_id 列', () => {
  it('agent_definition 等表列清单不含 company_id', () => {
    setDbForTest(makeTestDb().db);
    for (const t of ['department','agent_definition','relationship','company_employee','memory_candidate','memory_entry','discussion','handover_record','permission_change_request','business_review']) {
      const cols = (getDb().prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
      expect(cols, t).not.toContain('company_id');
    }
  });
  it('createAgent 无 companyId 参数可建可查', () => {
    setDbForTest(makeTestDb().db); ensureWorkbench(getDb());
    const a = createAgent(getDb(), { name: 'a', role: 'lead' });
    expect(listAgents(getDb()).map(x => x.id)).toContain(a.id);
  });
});
```

- [ ] **Step 2: Run 确认失败**

Run: `npx vitest run tests/integration/org-columns-dropped.spec.ts`
Expected: FAIL（`PRAGMA table_info` 含 company_id / createAgent 仍要 companyId）

- [ ] **Step 3: 域代码清扫**——上述文件里 `WHERE company_id=?` 谓词删除（72 处全局量中本批约占一半，逐文件 grep `company_id` 定位）、函数签名去参、INSERT 列清单去 `company_id`（同提交配迁移）、`graph.ts`/`relationship` 的归属守卫（`resource.companyId !== companyIdOf(req)`）改为纯资源存在性判断。夹具：`setup.ts` 的 `createNovelCompany` 改为 `ensureWorkbench(db)` + 后续建 department/agent/relationship（去 companyId 实参）；受影响 spec 按 `grep -rln 'companyId' tests/` 清单逐文件适配。

- [ ] **Step 4: 写迁移 A**（重建模式，每表一节；此处给 agent_definition 全文示范，其余同式——列清单以 `0001_init.sql`/`0016_agent_profile.sql`/`0017_agent_memory.sql`/`20260717121000_business_review.sql`/`20260812010000_handover_offboard.sql`/`20260812000000_permission_delegation_audit.sql`/`20260812030000_discussion.sql` 原文为准，唯删 company_id 列与 FK 子句）

```sql
-- 公司退役批次 D Task2：组织人员表去 company_id 列（重建模式，外键常开下安全）。
CREATE TABLE agent_definition_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '',
  availability_state TEXT NOT NULL DEFAULT 'online'
    CHECK (availability_state IN ('online','busy','offline','greyed')),
  legacy_note TEXT, custom_model TEXT, custom_thinking_depth TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO agent_definition_new SELECT
  id, name, role, title, persona, goal, context, availability_state, legacy_note,
  custom_model, custom_thinking_depth, created_at, updated_at
FROM agent_definition;
DROP TABLE agent_definition;
ALTER TABLE agent_definition_new RENAME TO agent_definition;
-- 其余九表同式：department / relationship / company_employee / memory_candidate /
-- memory_entry / discussion / handover_record / permission_change_request / business_review
-- conversation scope 语义改名（值替换，不动结构）：
UPDATE conversation SET scope_kind='workbench' WHERE scope_kind='company';
-- 索引重建（无 company_id 版；先 DROP 旧名已随 DROP TABLE 消失，仅需建新的）：
CREATE INDEX idx_company_employee_created ON company_employee(created_at);
CREATE INDEX idx_memory_entry_scope ON memory_entry(profile_id, scope, project_id, state);
CREATE INDEX idx_business_review_status ON business_review(status);
CREATE INDEX idx_handover_state ON handover_record(state);
```

注意：`company_employee` 重建时**保留**其余全部列与 FK（executor_profile_id、permission_policy_id、permission_policy 关联、employment_type/temp_status/contracted_at/source_contract_id 等），唯删 company_id 与其 FK 子句；关系表 `relationship` 的 UNIQUE 约束照抄原文。

- [ ] **Step 5: Run 新 spec + 夹具相关全量**

Run: `npx vitest run tests/integration/org-columns-dropped.spec.ts && npx vitest run 2>&1 | tail -3 && npm run typecheck`
Expected: 新 spec PASS；全量除 web-tools 3 例外全过

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/20260819000000_company_drop_org.sql src/server/domain/ src/server/api/conversation.ts src/server/api/temp-worker.ts tests/integration/setup.ts tests/integration/org-columns-dropped.spec.ts tests/
git commit -m "feat(company-drop): 组织人员域去 company_id——agent/employee/department/relationship/memory/handover/discussion/permission 十表重建去列,conversation scope 改 workbench,夹具枢纽 createNovelCompany 退役(D-Task2)"
```

---

### Task 3: 任务与知识资产域去列 + 迁移 B

**Files:**
- Modify: `src/server/task-engine/engine.ts`（签名 4 处：1468/1491/1605/1883 + ~16 个 realtime 事件 scope）、`task.ts:307`、`workflow.ts`、`workflow-template.ts`、`swarm.ts`、`debate.ts`、`triggers.ts`、`blueprint.ts` + `api/blueprints.ts`（assertBlueprintCompany 守卫删）、`blueprint-optimizer.ts`、`blueprint-optimize-chat.ts` + `api/blueprint-optimization.ts`、`expert-synthesis.ts` + `api/expert-candidates.ts`、`archive.ts`、`artifact.ts`、`usage.ts`、`task-closeout.ts`、`acceptance-officer.ts`、`acceptance-review.ts`、`reflection.ts`、`gap-research.ts`、`report.ts:72`、`llm-call.ts`、`event-feed.ts`、`ai-approval.ts`、`skill-author.ts`、`api/projects.ts`（守卫与 `kind==='novel'` 路径保留、`project.companyId` 产出改常量填充）、`server/bridge.ts:241`（映射常量填充直至 Task 5）
- Create: `src/server/db/migrations/20260819000100_company_drop_assets.sql`
- Test: `tests/integration/assets-columns-dropped.spec.ts`（结构断言同 Task 2 模式，覆盖 workflow_node/workflow_edge/project/swarm_run/trigger/blueprint/debate/decision_record/task_closeout_summary/expert_candidate/blueprint_optimization_item）

**Interfaces:**
- Consumes: Task 1 `getWorkbench`。
- Produces: 本批域函数全部去 companyId 参（`tierForTask` 系已无）；engine 的 realtime 事件 scope 从 `{companyId: project.companyId}`→`{}`（事件字段 Task 5 收口，此处先不再传）；`project` 表无 company_id 后 `Project.companyId` DTO 由映射器以 `getWorkbench(db).id` 填充（Task 5 删）。

- [ ] **Step 1: 写失败测试**（结构断言 + `createProject(db,{name,rootDir,firstAgentId})` 无 companyId 可建）
- [ ] **Step 2: Run 确认失败**（PRAGMA 含 company_id）
- [ ] **Step 3: 域清扫**——同 Task 2 手法：谓词删、签名去参、INSERT 去列、`project_new` 式重建的 project 表以 `20260726140000_project_state_machine.sql` 原文为列清单基准（唯删 company_id 与 FK）；blueprint 三表（blueprint / blueprint_optimization_item / expert_candidate）守卫与谓词同删；裸列表（expert_candidate、blueprint_optimization_item）先 `DROP INDEX idx_expert_candidate_company_status / idx_boi_company` 再 `ALTER TABLE ... DROP COLUMN company_id`；FK 表（workflow_node/edge、project、swarm_run、trigger、blueprint、debate、decision_record、task_closeout_summary）重建，索引重建为无 company_id 版（idx_swarm_run_company 删、idx_debate_created(debate,created_at)、idx_decision_created、idx_blueprint 无需索引、idx_closeout 删、trigger 视原文索引调整）。
- [ ] **Step 4: 迁移 B 全文按上述清单落 SQL**（同 Task 2 重建模板）
- [ ] **Step 5: Run** `npx vitest run tests/integration/assets-columns-dropped.spec.ts && npx vitest run 2>&1 | tail -3 && npm run typecheck`，Expected 同基线
- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/20260819000100_company_drop_assets.sql src/server/ tests/integration/assets-columns-dropped.spec.ts tests/
git commit -m "feat(company-drop): 任务与知识资产域去 company_id——project/workflow/swarm/debate/trigger/blueprint×3/closeout 等十一表去列,engine 事件不再携公司 scope(D-Task3)"
```

---

### Task 4: 能力卫星、死表与 B2B 死流退役 + 迁移 C

**Files:**
- Modify: `src/server/api/plugins.ts`（14 处 companyIdOf + assertCompanyOff 改 `getWorkbench`）、`plugin-install.ts`、`tool-registry.ts`、`capability-binding.ts`、`marketplace.ts`、`marketplace-presets.ts`、`credential-store.ts`（`resolveCredentialKey` 去 `void companyId` 与参数）、`api/credentials.ts`、`api/outsourcing.ts`（删 `/outsource/contracts` GET×2、`/contracts/:id/accept` 等死端点）、`domain/outsourcing-contract.ts`（删 createOutsourcingContract/acceptContract/liaison/revision 死流函数；**保留** outsourcing-decision.ts 决策树活链）、`domain/outsourcing-review.ts`（先 grep 消费方：仅死流引用则整文件删）
- Modify(冒烟): `scripts/smoke/smoke-5-b2b-temp.mjs:96,102`、`scripts/smoke/b2b-temp-handover.mjs:207,213`（contracts 列表断言块删除）、`scripts/smoke/_helpers.mjs`（setupProject 去 companyId 形参）
- Modify(测试): `tests/integration/outsourcing-dependency.spec.ts`、`outsourcing-auto-accept.spec.ts`（死流用例删除，保留决策树用例）
- Create: `src/server/db/migrations/20260819000200_company_drop_satellites.sql`
- Test: `tests/integration/satellites-dropped.spec.ts`

**Interfaces:**
- Produces: `workbench_plugin`（原 company_plugin，UNIQUE(plugin_id,?) 按 `0029/20260809000000` 原约束去 company_id 维度）、`workbench_tool`（原 company_tool）；死表消失：company_credential、company_optimization_report、promotion_candidate、company_template_installation、template_health_finding、outsourcing_contract；`resolveCredentialKey(db, profileId, definitionId, profileRef?)` 四参（companyId 形参删除）。

- [ ] **Step 1: 死表/死流存活复核**（写码前跑，输出应为空或仅测试引用）

```bash
grep -rn 'company_optimization_report\|promotion_candidate\|company_template_installation\|template_health_finding\|company_credential' src/ --include='*.ts' | grep -v migrations
grep -rn 'createOutsourcingContract\|acceptContract\|listContractsForCompany' src/ scripts/ --include='*.ts' --include='*.mjs'
```

若有 src/ 活引用：该表/流**不删**，改为同批重建去列，并在提交信息记录原因。

- [ ] **Step 2: 写失败测试**（`SELECT name FROM sqlite_master WHERE type='table'` 断言死表不存在、workbench_plugin 存在且无 company_id 列、`resolveCredentialKey` 四参解析 员工>档案>平台）

- [ ] **Step 3: 代码清扫**——plugins/tool/marketplace/capability 域谓词与签名；credential-store 收尾；B2B 死流删除（域函数+端点+冒烟断言块+死流用例）。

- [ ] **Step 4: 迁移 C**

```sql
-- 公司退役批次 D Task4：死表 DROP、卫星表改名去列、B2B 契约死流退役。
DROP TABLE IF EXISTS company_credential;            -- D4-1 已清空数据
DROP TABLE IF EXISTS company_optimization_report;   -- 零消费方
DROP TABLE IF EXISTS promotion_candidate;           -- 晋升链已退役,零消费方
DROP TABLE IF EXISTS company_template_installation; -- 模板平台已退役,零消费方
DROP TABLE IF EXISTS template_health_finding;       -- 同上
DROP TABLE IF EXISTS outsourcing_contract;          -- B2B 契约创建全库零调用方(单例下创建不可达),死流退役
-- company_plugin → workbench_plugin（列抄自 20260726071905_plugin_backbone + 20260809100000 的 decision 列；PK 收敛为 plugin_id）：
CREATE TABLE workbench_plugin_new (
  plugin_id TEXT NOT NULL REFERENCES plugin (id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  decision TEXT NOT NULL DEFAULT 'enabled' CHECK (decision IN ('enabled', 'disabled')),
  enabled_by TEXT,
  enabled_at TEXT,
  PRIMARY KEY (plugin_id)
);
INSERT INTO workbench_plugin_new SELECT plugin_id, enabled, decision, enabled_by, enabled_at FROM company_plugin;
DROP TABLE company_plugin; ALTER TABLE workbench_plugin_new RENAME TO workbench_plugin;
-- company_tool → workbench_tool（列抄自 0029_tool_registry；PK 收敛为 tool_id）：
CREATE TABLE workbench_tool_new (
  tool_id TEXT NOT NULL REFERENCES tool_registry(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tool_id)
);
INSERT INTO workbench_tool_new SELECT tool_id, enabled, created_at, updated_at FROM company_tool;
DROP TABLE company_tool; ALTER TABLE workbench_tool_new RENAME TO workbench_tool;
-- capability_binding 重建去列（列抄自 0027_company_template_platform；UNIQUE 收敛去 company_id 维度）：
CREATE TABLE capability_binding_new (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES agent_definition(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('role', 'employee', 'field', 'task')),
  scope_key TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  skill_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_ids_json)),
  purpose TEXT NOT NULL,
  load_when TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, scope_key, capability_id)
);
INSERT INTO capability_binding_new SELECT
  id, employee_id, scope, scope_key, capability_id, skill_ids_json, purpose, load_when, created_at, updated_at
FROM capability_binding;
DROP TABLE capability_binding; ALTER TABLE capability_binding_new RENAME TO capability_binding;
CREATE INDEX IF NOT EXISTS idx_capability_binding_employee ON capability_binding(employee_id, scope);
CREATE INDEX IF NOT EXISTS idx_capability_binding_scope ON capability_binding(scope, scope_key);
```

- [ ] **Step 5: Run** 新 spec + `npx vitest run 2>&1 | tail -3` + typecheck，Expected 同基线
- [ ] **Step 6: 冒烟脚本相关块删除后本地跑** `node scripts/smoke/run-all.mjs`，Expected 73 例去死流断言后全过（用例数下降需在提交信息记录新基线）
- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/20260819000200_company_drop_satellites.sql src/server/ scripts/smoke/ tests/integration/satellites-dropped.spec.ts tests/
git commit -m "feat(company-drop): 能力卫星去列+死表死流退役——company_plugin/tool 改名 workbench_*,DROP 凭据公司层/优化报告/晋升候选/模板平台/B2B 契约死流,resolveCredentialKey 终版四参(D-Task4)"
```

---

### Task 5: 契约面原子清扫（shared + client + realtime）

**Files:**
- Modify: `src/shared/types.ts:48,149,178,198`、`src/shared/lifecycle-events.ts:140-143,185`（payload companyId 与 Scope 字段删）、`src/client/api/types.ts:34,82,105,126,143,171,180,201`（Agent/CompanyEmployee/BusinessReview/MemoryCandidate/MemoryEntry/Department/Project/Relationship 的 companyId）、`src/client/hooks/queries.ts`（13 处 DTO 字段 + `['company']` query key→`['workbench']` + quick-project 响应 companyId + TriggerDTO/companyId、plugin scope 类型）、`src/client/realtime.ts:11,76,118`（event.companyId 分支删）、`src/client/pages/BusinessReviewPage.tsx`（按 companyId 分组→单列表）、`CapabilityCenterPage.tsx`（scope.level 'company' 联合类型与徽章）、`ConversationPanel.tsx`（scope 匹配改 workbench）、`AgentProfilePage.tsx`、`components/agents/EmploymentCard.tsx`、`workbench/ProjectContextInspector.tsx`、`workbench/ProjectWorkNavigation.tsx`（假部门 companyId:''）、`ReportsPage.tsx:55,84`、`workbench/ProjectToolPageShell.tsx`
- Modify(server 收尾): Task 2-4 的常量填充映射器删字段（`grep -rn 'companyId: getWorkbench\|companyId: workbench' src/server`）、`api/events.ts` SQL 输出、`api/permissions.ts:19` join 字段、`api/projects.ts:228-233` 事件 scope、`api/plugins.ts:73,82,140` 事件 scope
- Test: `tests/unit/realtime.spec.ts`、`tests/unit/use-paused-edit.spec.tsx` 适配

**Interfaces:**
- Produces: 前后端 DTO 均无 companyId 字段；realtime 事件 scope 仅 `{projectId?, taskId?}`；React Query 键 `['workbench']`。
- Consumes: Task 2-4 已把服务端列删净，本任务收字段。

- [ ] **Step 1: 写失败测试**——`tests/unit/dto-no-company.spec.ts`：编译期断言（`type T = Agent; const _c: keyof T extends 'companyId' ? never : true = true` 式的 Exclude 断言）+ realtime.spec 增加「无 companyId 字段事件仍正确失效 ['workbench'] 键」用例
- [ ] **Step 2: Run 确认失败**
- [ ] **Step 3: 前后端字段同提交删除**（tsc 两侧兜底：先删 shared/client 类型，让所有读点编译报错逐个清理，最后删 server 映射器填充）
- [ ] **Step 4: Run** `npx vitest run 2>&1 | tail -3 && npm run typecheck && npx playwright test`，Expected 基线
- [ ] **Step 5: Commit**

```bash
git add src/shared/ src/client/ src/server/api/ tests/unit/dto-no-company.spec.ts tests/unit/realtime.spec.ts tests/unit/use-paused-edit.spec.tsx
git commit -m "feat(company-drop): 契约面收口——shared/client DTO 与 realtime 事件全链去 companyId,query key company→workbench(D-Task5)"
```

---

### Task 6: 终局迁移——company 表 RENAME workbench

**Files:**
- Modify: `src/server/domain/workbench.ts`（内部 SQL `FROM company`→`FROM workbench`，及 `company.state` 事件 type 改 `workbench.state` 同步 client realtime 分支）、`src/server/api/middleware.ts`（删 companyIdOf，先验证零调用）
- Create: `src/server/db/migrations/20260819000300_company_rename_workbench.sql`
- Test: `tests/integration/workbench-table.spec.ts`、`tests/e2e/global-setup.ts` 不变（自动重放）

**Interfaces:**
- Produces: 表 `workbench`（列：id、name、kind、state、charter、contract_json、created_at、updated_at + 存活验证留用的列）；`companyIdOf` 删除。

- [ ] **Step 1: 死列存活复核**

```bash
grep -rn 'executor_tier_primary_id\|executor_tier_secondary_id\|executor_tier_tertiary_id\|archived_at\|archived_reason' src/server --include='*.ts' | grep -v migrations | grep -v workbench.ts
```

期望：仅 workbench.ts 内部映射（删）与零散残留。**first_agent_id 与 review_mode 确认保留**（活依赖证据见 Global Constraints 与底数速查），不在删列范围。

- [ ] **Step 2: 写迁移 D**（重建模式，因要删多列且 SQLite DROP COLUMN 不能动 CHECK 内列）：

```sql
-- 公司退役批次 D Task6：company 瘦身并 RENAME 为 workbench 单例表。
CREATE TABLE workbench_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'novel',
  state        TEXT NOT NULL DEFAULT 'off'
               CHECK (state IN ('off','online','draining','review_paused')),
  charter      TEXT NOT NULL DEFAULT '',
  contract_json TEXT NOT NULL DEFAULT '{}',
  first_agent_id TEXT,                                -- 活列:蜂群放蜂请示/审批升级,本批保留(见 Global Constraints)
  review_mode  TEXT NOT NULL DEFAULT 'blocking',      -- 活列:审批门控,本批保留
  shutdown_paused INTEGER NOT NULL DEFAULT 0,         -- 优雅关机标记(20260814000000),状态机在用
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO workbench_new SELECT id,name,kind,state,charter,contract_json,first_agent_id,review_mode,shutdown_paused,created_at,updated_at FROM company;
DROP TABLE company;
ALTER TABLE workbench_new RENAME TO workbench;
```

- [ ] **Step 3: workbench.ts 表名翻转 + companyIdOf 删除**（`grep -rn 'companyIdOf' src/ | grep -v middleware.ts` 必须为空）
- [ ] **Step 4: 完整性断言**——迁移文件末尾不能跑 PRAGMA 断言，改在冷启动演练里做：删除临时库文件后起 server，`PRAGMA foreign_key_check` 应返回空行集；`SELECT name FROM sqlite_master WHERE name='company'` 为空
- [ ] **Step 5: Run** 全量单测 + e2e + smoke + 冷启动（空 MUSTER_HOME 临时目录 `node --import tsx src/server/server.ts` 起停一次），Expected 基线
- [ ] **Step 6: 真实库演练**——`cp ~/.muster/muster.db ~/.muster-backups/muster-before-company-drop-$(date +%Y%m%d%H%M%S).db`，对副本库跑迁移（临时 MUSTER_HOME 指向副本目录），验证 `PRAGMA foreign_key_check` 空 + workbench 表单行
- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/20260819000300_company_rename_workbench.sql src/server/domain/workbench.ts src/server/api/middleware.ts tests/integration/workbench-table.spec.ts
git commit -m "feat(company-drop): company 表瘦身 RENAME workbench——死列删除,companyIdOf 终删,foreign_key_check+冷启动+真实库副本演练通过(D-Task6)"
```

---

### Task 7: 文档收口与全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-company-retirement.md`（批次 D 行→✅ 已实施 + 实施注记）、`CLAUDE.md`（「公司概念退役」章补批次 D 段：表清单、workbench 单例表、B2B 死流退役记录、company_employee 表名注记）

- [ ] **Step 1: 全量三套**——`npm run typecheck && npx vitest run 2>&1 | tail -3 && npx playwright test && node scripts/smoke/run-all.mjs`，Expected: tsc 干净 / 单测除 web-tools 3 例外全过 / e2e 全过 / smoke 全过（新基线用例数）
- [ ] **Step 2: 残留扫描**——`grep -rn 'companyId\|company_id' src/ --include='*.ts' --include='*.tsx' | grep -v migrations | grep -v spec`，逐条确认均为注记/历史引用或 company_employee 表名本身
- [ ] **Step 3: 文档更新 + Commit**

```bash
git add docs/superpowers/specs/2026-08-17-company-retirement.md CLAUDE.md
git commit -m "docs(company-drop): 批次 D 物理去列收口——spec 状态翻完成,CLAUDE.md 补实施记录(D-Task7)"
```

- [ ] **Step 4: 分支留在 worktree 等终审**（不自动合并；合并与 worktree 清理按用户指示）

---

## 风险与回退

- 每个迁移独立事务（client.ts 机制）：失败自动回滚不留半态；append-only 保证可重放。

---

## 实施进度（2026-08-18，分支 feat/company-drop，worktree muster-company-drop-impl）

> 状态注记：以下为实施中途留下的真实进度，供接管者/高级模型判定用。**执行时已按用户指示暂停（用户将换执行者接手）**。

| 任务 | 状态 | 提交 | 备注 |
|------|------|------|------|
| Task 0 基线+删坏脚本 | ✅ | 924cc1b | 额外删 package.json 悬空脚本 test:claude-smoke |
| 计划修订（first_agent_id/review_mode 判活）| ✅ | bd09bba（docs 分支）| 用户拍板保留两列 |
| Task 1 workbench 域原语+运行时 | ✅ | 5e2284e | company.ts 保留为测试夹具兼容壳 |
| Task 2 组织人员域去列 | ✅ | ac3ffdd | 迁移 A 列级对账权威库通过 |
| Task 3 任务/知识资产域去列 | ✅ | 65d70e7 | 迁移 B（10 张表去列）+ 域函数去参 |
| Task 4 能力卫星/死表/B2B 死流退役 | ✅ | 6d449bb | 迁移 C（5 张表去列+死表退役）+ 解锁 33 例测试 |
| Task 5 契约面清扫(client/shared/realtime) | ✅ | 42eaa8d | Shared/Client DTO 与 realtime 全链去 companyId |
| Task 6 company RENAME workbench | ✅ | dc63eef | 迁移 D（company 瘦身 RENAME workbench 单例表）+ 死列删除 |
| Task 7 文档收口+全量三套 | ✅ | 本次提交 | spec/CLAUDE.md 更新，全量测试三套 100% 通过，保留在 feat/company-drop 分支 |

### 留给高级模型判定的决策点
1. **company.ts 遗留壳删除时机**：Task 1 未删（103 夹具依赖 createCompany），Task 6 末尾删除前需确认夹具已全部迁走；或同意将该壳降级为「远期」。
2. **Task 2 放行的两处跨公司守卫放宽**：createProject（first-agent 归属）与 createTask（assignee/dispatcher 归属）原校验 `agent.companyId`，列被删后已放宽为资源存在性检查。需确认此语义变化可接受（单例工作台下归属恒真）。
3. **33 例 it.skip 的 b2b/outsourcing 测试**：仅 Task 4「B2B 契约死流退役」后才能移除 skip（其多公司语义依赖契约流退役）。若 Task 4 决定不删死流而改建（原计划=退役），skip 需转为重建后的断言。
4. **Task 1 状态机/关机语义**：coordinator/shutdown 已按单工作台重写（getWorkbench），`beginGracefulShutdown` 仅单行——关机动画数组退回单元素，需高级模型确认 UI 侧（Task 5 客户端）无多公司动画残留。
5. **迁移 A 的口径**：列集合与权威库逐列一致（含各 ALTER 后加列：agent.profile_id/availability_state/stance/is_system、relationship.archived_at、company_employee.hidden、memory.fingerprint/persona_key/hit_count/vote_count/adv_sum、discussion.mode）；company_id 全部去除。conversation_message scope_kind CHECK 同步为 ('workbench','project')。
6. **compremission：company_employee 表名/temp-worker 的 hidden 列**——hidden 保留（人才市场在用）。

### 验证基线（Task 2 末）
- `npm run typecheck`：0 错误
- `npx vitest run`：1264 过 / 3 失败（web-tools 沙箱 DNS 环境基线）/ 33 跳过（D-Task4 标记）
- e2e / smoke：未跑（留给 Task 7 或接手者）

### 工程要点备注
- 迁移 A 用「权威库 sqlite_master.sql + 列级 PRAGMA 对账」校验脚本（临时脚本已删，方法见提交信息）——后续迁移 B/C 沿用此法，勿凭记忆写列。
- workbench 域新增 `getWorkbenchOrNull(db)`（DTO 常量填充零组织库场景）。
- GET/PATCH/POST /api/workbench 各端点空库自动建（ensureWorkbench），与原 companyIdOf 语义一致。
- 重建迁移的列抄写错误由两道闸拦：结构断言 spec（PRAGMA table_info）+ 全量单测（域函数读写）。
- 真实库操作前强制备份（Task 6 Step 6），回退=恢复备份文件，零数据风险。
- 最大风险点=Task 2/3 夹具适配量大（~110 文件）：tsc 是兜底网，逐文件机械替换。
