# 子智能体可观测性与失败诊断加固 设计

**日期**：2026-08-12
**状态**：设计稿（待实现）
**关联 PRD**：`docs/PRD-agent-company-workbench.md` — Operations Inspector / Usage, Limits, and Failure Handling
**关联代码**：`src/server/task-engine/run-watchdog.ts`、`src/server/task-engine/engine.ts`、`src/shared/retry-policy.ts`、`src/server/executors/safety.ts`、`src/server/domain/outsourcing-contract.ts`

## 背景

muster 已经把"临时工"当成一等公民建模：`employment_type='temp'` + `temp_status`（`src/server/domain/temp-worker.ts`）、`recruitAgentProfile` 的 `tempRecruit` 通道。失败检测的骨架也相当完整——`RunWatchdog` 七类失败、任务级自动重试、3 次熔断、`propagateChildFailure` 兜底、`isDispatchLoop` 循环保护、reflection 反思队列、inspector 告警。

问题在于：这个骨架**最依赖的那一环——失败分类——是脆弱的**，并且存在死信号和被静默吞掉的失败。分类一错，下游的重试、熔断、反思、兜底全跟着错，临时工就在错误的方向上空转，这正是"做无用功"的根源。本设计聚焦于把分类做准、把死信号激活、把吞掉的失败亮出来，并为临时工提供一等观测面。临时工模型本身不动。

## 真实缺口（带代码证据）

1. **失败分类靠"猜"**
   - `classifyRunFailure`（`run-watchdog.ts:18-24`）粗糙：任何不显式匹配 `empty_result`/`process_exit` 正则的异常都 fallthrough 到 `process_exit`，误分类概率高。
   - `isRecoverableSessionError`（`src/shared/retry-policy.ts:16-20`）是对**英文报错字符串做正则**。它是会话级和任务级恢复的唯一分类器，行为完全依赖 adapter 的错误措辞——中文 adapter 报错或措辞一改，静默退化为"不重试"。

2. **"无进展"检测是死代码**
   - `detectNoProgress`（`src/server/executors/safety.ts:22`）已定义，但 `assertSafeToRun`（`safety.ts:32`）只调用了 `detectRepeatedFailure`，从不调用它。临时工空转烧预算时，平台检测不到。

3. **大量失败被静默吞掉**
   - `engine.ts` 多处 `try { ... } catch (e) { log.warn('... failed', ...) }`（讨论触发、reflection 入队、外包审核、rating、handover）只在日志里，**不进实时事件流、不派任务**。看不见的失败＝无法管的失败。

4. **外包退避永不转永久失败**
   - `AUTO_ACCEPT_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000]`（`outsourcing-contract.ts:31`）封顶 15 分钟，`auto_accept_attempt_count` 无限自增（`revertAcceptToPending` `:270-286`、`autoAcceptContract` `:300`）。配错的乙方公司每 ≤15 分钟重试到永远。

5. **没有"临时工看板"**
   - 子任务不是一等概念，无 `owned-children` 索引、无 agent 树视图。要查"agent X 现在养着哪些子任务、它们的健康如何"得手撸 task 表按 `dispatcherAgentId`/`parentTaskId` 走。

## 核心设计

设计原则：**不改临时工招/遣模型，不重写 `_pumpThread`，只插点和加观测**。所有下游机制（重试/熔断/反思/兜底）共享一个统一的失败分类契约。

### 1. 统一失败分类契约（取代正则）

把分类从"对字符串正则"升级为"对结构化类型匹配"：

- adapter 侧（`ExecutionAdapter`）抛出的错误统一为带 `code: FailureCategory` 的结构化类型。`FailureCategory` 取值与现有 `RunWatchdog` 分类对齐并对齐恢复策略：
  - `transient`（网络抖动、限流、启动超时）→ 可重试
  - `capability_gap`（执行器无某能力、缺工具）→ 不重试，转能力补齐（见 [[2026-08-12-task-investigation-capability-provisioning-design]]）
  - `config_error`（凭据错、参数错、权限拒绝）→ 不重试，转人工
  - `permanent`（确定性失败、内容违规）→ 终止
- `classifyRunFailure` 改为消费 `FailureCategory`，而非正则匹配消息。
- `isRecoverableSessionError` 改为 `category === 'transient'` 的查表判断。
- 对**无法改造的旧 adapter**（如纯 CLI），保留一个兜底启发式分类器，但记 `classification_confidence: 'low'`，便于后续审计。

> 这一步是杠杆点：分类准了，重试、熔断、`capability_gap` 路由、反思信号才全部正确。

### 2. 激活 no-progress 信号

- 在安全预检（`assertSafeToRun`）中接入 `detectNoProgress`。"进展"定义为时间窗口内是否出现：artifact 产出、文件变更、或工具调用成功。
- 触发后不直接判失败，而是产出 `EXECUTOR_NO_PROGRESS`（该 AppError 路径已存在于 `handleRunError`，当前因 `assertSafeToRun` 不发它而成为死路径）。
- 窗口与阈值放进 `src/shared/constants.ts`，默认值保守，可配。

### 3. 失败必上报（不静默吞）

- 约定一条规则：**任何 `catch` 不得只 `log.warn`**。按严重度分流：
  - 可忽略类（如非关键的遥测）→ 记 `task_event` 但不告警。
  - 影响协作/恢复类（讨论触发失败、reflection 入队失败、handover 失败）→ 发结构化 lifecycle event + 写 `task_event`，确保进入可观测面。
- 不改变这些路径"不阻塞主流程"的韧性，只补"可见性"。

### 4. 临时工健康聚合观测

- 不新增重表，用聚合查询/view 实现 `subagent_health` 视图，按 `dispatcherAgentId`（临时工/根员工）聚合：
  - 在岗子任务数、近 N 次失败率、预算消耗、最近产出 artifact 时间、是否触发熔断。
- 在 inspector（`runInspectorAlerts` `coordinator.ts:280-347`）中消费，产出新的告警 kind（如 `temp_unhealthy`）。
- UI 侧作为一等看板展示（属于客户端范畴，本设计只约定数据契约）。

### 5. 外包退避封顶转永久失败

- `outsourcing-contract` 增加 `auto_accept_max_attempts`（默认如 8）。
- `autoAcceptContract` 在 `auto_accept_attempt_count >= max` 时转入终态（如 `auto_accept_disabled`），停止重试，发 lifecycle event 上报第一负责人。
- 计数器在成功 accept 时清零的逻辑（`outsourcing-contract.ts:253-258`）保持不变。

## 数据模型

最小改动，优先复用：

- `task_event`（`src/server/domain/task-event.ts`）：新增 `failure_category TEXT NULL`（记录分类契约结果，便于审计与反思）。非破坏性，旧记录为 NULL。
- `outsourcing_contract`：新增 `auto_accept_max_attempts INTEGER NOT NULL DEFAULT 8`；状态枚举增加 `auto_accept_disabled`。
- `subagent_health`：物化视图（或 coordinator 周期计算的内存聚合），不落新业务表。

迁移按 CLAUDE.md 约定：`YYYYMMDDHHMMSS_<slug>.sql`，新增列带默认值，不动旧数据。

## 变更点（带 file:line）

**后端**
- `src/server/task-engine/run-watchdog.ts:18-24` — `classifyRunFailure` 消费 `FailureCategory`。
- `src/shared/retry-policy.ts:16-20` — `isRecoverableSessionError` 改为 category 查表。
- `src/shared/retry-policy.ts` — 新增 `FailureCategory` 类型与恢复策略映射。
- `src/server/executors/safety.ts:22,32` — `assertSafeToRun` 接入 `detectNoProgress`。
- `src/server/task-engine/engine.ts` — 多处 `catch { log.warn }` 改为发 event + 写 `task_event`；`handleRunError`（`:1199-1326`）消费新 category。
- `src/server/domain/outsourcing-contract.ts:31,253-258,270-300` — 封顶 + `auto_accept_disabled` 终态。
- `src/server/runtime/coordinator.ts:280-347` — inspector 消费 `subagent_health`，新增告警 kind。
- 各 adapter（`src/server/executors/*-adapter.ts`）— 抛出带 `FailureCategory` 的结构化错误。

**数据**
- 新增迁移：`task_event.failure_category`、`outsourcing_contract.auto_accept_max_attempts` + 状态枚举。
- 新增 view：`subagent_health`。

## 实现批次

- **B1（基础）**：统一失败分类契约 + 激活 no-progress。先让分类正确，下游才有意义。含 adapter 改造与单元测试矩阵。
- **B2（可见性）**：失败必上报（去静默吞）+ 临时工健康看板数据契约 + inspector 消费。
- **B3（收尾）**：外包退避封顶转永久失败 + 相关回归测试。

## 验收标准

1. 失败分类有确定性测试矩阵：每种 adapter 错误（网络、超时、缺能力、凭据错、确定性失败）映射到正确 `FailureCategory` 与恢复策略。
2. `isRecoverableSessionError` 不再依赖英文正则；中文 adapter 报错也能正确分类。
3. 空转任务（无 artifact/文件/工具成功）在窗口内被标 `EXECUTOR_NO_PROGRESS` 并进入 `handleRunError`。
4. 原先被 `log.warn` 吞掉的失败（讨论/reflection/handover）现在出现在 lifecycle event 流和 `task_event` 中。
5. inspector 能展示每个临时工/根员工的在岗数、失败率、预算消耗、最近 artifact 时间；触发 `temp_unhealthy` 告警。
6. 外包 contract 达 `auto_accept_max_attempts` 后停止重试、转 `auto_accept_disabled`、上报第一负责人。
7. 回归：现有重试/熔断/兜底/循环保护行为不退化（靠 B1 的测试矩阵保障）。

## 不在本轮范围

- 不改临时工的招募/遣散/镜像模型。
- 不重写 `_pumpThread`（只在其内插点）。
- 不引入新的 `SubAgent`/`Worker` 类型或 agent 树持久化结构（看板用聚合视图即可）。
- 不做 UI 看板的客户端实现（只约定数据契约）。
- 不改造外包的业务语义，只加封顶。

## 与其他 spec 的衔接

- 本 spec 的 `FailureCategory`（尤其 `capability_gap`）是 [[2026-08-12-task-investigation-capability-provisioning-design]] 任务级预检与缺口自愈的复用基础：执行期判定为能力缺口的失败，应触发"补能力"而非"重试"。
- 本 spec 的"失败必上报"事件总线，与 [[2026-08-12-capability-marketplace-quality-loop-design]] 的质量反馈闭环共享：能力调用失败也是该能力质量分的输入。
