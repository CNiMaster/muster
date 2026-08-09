# B2B 跨组织任务委派（外包）设计

**日期**：2026-08-10
**状态**：已实现（MVP）
**关联迁移**：`20260810100000_b2b_outsourcing.sql`

## 背景

Muster 的「公司」是软件内的本地组织概念，非真实企业实体。本设计实现**同软件内不同组织间的任务委派**（B2B 外包）：例如游戏公司需要美术素材、软件公司需要 UI 设计，均可外包给系统内的设计公司。

PRD 原将「跨公司共享」列为 Out of Scope；本设计在单进程本地软件前提下（无跨机/多租户问题）安全引入跨组织委派。

## 用户需求

1. 做事前调研：内部能做→外包→招聘（**全自动决策树**）
2. 由专人对接、特定工作才可委派
3. 接受方专人分配给员工
4. 任务有标准化「公司需求」（资料+验收标准）
5. 完工检查 → 可反复修改 → 回传
6. 文件交付：**让接活公司直接在发包方指定目录内工作（写入权）+ 授予发包方资料只读权**

## 核心设计

### 数据模型：outsourcing_contract 契约表

```
甲方 source company ──contract──→ 乙方 target company
   │                                    │
   ├─ sourceProjectId（委派源项目）      ├─ outsourcedTaskId（承接任务）
   ├─ sourceTaskId（发起任务，可选）     ├─ vendorLiaisonAgentId（对接人）
   ├─ deliverableDir（交付子目录）       └─ 承接项目（接受时自动创建）
   ├─ readonlyRefs（授予乙方只读路径）
   ├─ acceptanceCriteria（验收标准）
   └─ requiredCapabilityIds（所需能力，决策树用）
```

task 表新增 `outsourcing_contract_id` 列：标记本 task 是某契约的承接任务。engine.ts 据此切换 worktree 源 repo 与 publish 目标。

### 状态机

```
pending（待乙方接受）
  → accepted（乙方接受）
    → in_progress（承接任务创建）
      → delivered（乙方完工，产物已 publish 到甲方 rootDir）
        → reviewing（甲方验收）
          → completed（验收通过）
          → changes_requested（返工，revisionRound++，→ in_progress + 创建返工任务）
          → rejected（拒绝，终态）
  → cancelled（任一方取消）
```

### 全自动决策树（outsourcing-decision.ts）

```
runOutsourcingDecisionTree(companyId, requiredCapabilityIds):
  1. hasInternalCapability? → 路径 'internal'（返回可分配的内部员工）
  2. findVendorCompany?     → 路径 'outsource'（返回具备能力的乙方公司）
  3. 都没有                 → 路径 'recruit'（本轮记事件 + 提示）
```

能力匹配基于 `capability_binding` 表（`employee_id IS NOT NULL` + `capability_id` 命中），跨公司扫描找乙方。

### 跨公司任务派发：守卫旁路

4 处同公司硬守卫，通过 `outsourcingContext` 显式参数旁路（默认不传 = 完全保持原行为，零回归）：

| 守卫 | 位置 | 旁路方式 |
|------|------|----------|
| createTask assignee/dispatcher 同公司 | task.ts:248-261 | `outsourcingContext` 跳过检查 |
| assertContactAllow 同公司 | agent.ts:137-148 | 外包任务不经过 contactAllow |
| ensureProjectTaskThread 同公司 | project-task-thread.ts:14 | 承接任务在乙方项目，自然通过 |
| createMirror 同公司 | thread.ts:80-85 | 同上 |

**关键**：承接任务在**乙方自己的项目**里（assignee/project 同属乙方），thread 守卫自然通过。唯一的跨公司入口是 `createOutsourcedTask`（封装 outsourcingContext 设置）。

### 文件交付：基于甲方 repo 的 worktree

```
乙方承接任务执行时：
  1. engine.ts 检测 task.outsourcing_contract_id
  2. createWorktree(sourceProject.rootDir, ...)  ← 基于甲方 git repo 切 worktree
     （普通任务基于自身 project.rootDir；外包任务基于甲方）
  3. readonlyDirs 追加甲方 rootDir + readonlyRefs（--add-dir 只读授权）
  4. 工作目录 = worktree（乙方在甲方 repo 的隔离分支上工作）
  5. 完成时 publishArtifacts 目标 = sourceProject.rootDir（甲方目录）
     （三方合并的 baseCommit 在甲方 repo 有效，复用全部合并/冲突/裁决管线）
```

Muster 是单进程本地软件，所有公司项目目录同属一个 workspace，git 访问天然可行（无跨机问题）。

### 跨公司依赖恢复：resumeDependents

现有 `completeTask` 的恢复逻辑只走 `parentTaskId` 单链（task.ts:537-543），无法唤醒通过 `addDependency` 建立的跨公司依赖。新增 `resumeDependents` 扫描 `task_dependency` 全表，在 completeTask 的 completed 分支调用，补齐跨公司依赖恢复。

### 交付触发：onOutsourcedTaskCompleted

乙方承接任务完成时，engine.ts 调 `onOutsourcedTaskCompleted`（幂等）：契约 → delivered，发 `outsource.delivered` 事件通知甲方验收。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/companies/:companyId/outsource/dispatch` | 甲方发起委派（含全自动决策树） |
| GET | `/api/companies/:companyId/outsource/contracts?role=source\|target` | 列契约 |
| GET | `/api/outsource/contracts/:id` | 契约详情 |
| POST | `/api/outsource/contracts/:id/accept` | 乙方接受（自动创建承接任务） |
| POST | `/api/outsource/contracts/:id/review` | 甲方验收（completed/changes_requested/rejected） |
| POST | `/api/outsource/contracts/:id/cancel` | 取消契约 |

## Realtime 事件

`outsource.requested` / `.accepted` / `.delivered` / `.reviewed` / `.completed`（扩展 LifecycleEventPayloadMap）

## 前端

- `/outsourcing`（OutsourcingCenterPage）：契约看板，两栏（甲方委派/乙方承接），含状态流转、验收操作、发起表单
- hooks：`useOutsourceContracts` / `useDispatchOutsource` / `useAcceptContract` / `useReviewContract` / `useCancelContract`

## 验证

- typecheck 通过
- 643 测试全绿（含 24 个新增 B2B 测试：决策树 8 + 契约 10 + 交付 6）
- e2e smoke 10/10 通过
- 零回归：所有守卫旁路通过 outsourcingContext 显式参数，默认行为不变

## 不在本轮范围

- 招聘流程的自动触发（决策树 'recruit' 路径仅记事件 + 提示，不自动跑招聘 wizard）
- 跨公司 loop protection（isDispatchLoop 跨公司扩展）—— 契约状态机天然防环
- deliverable_dir 路径前缀过滤（当前 publish 全部产物到甲方 rootDir，未按子目录过滤）
