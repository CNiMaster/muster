# 子智能体可观测性与失败诊断加固 Implementation Plan

> **For agentic workers:** 用 superpowers:executing-plans 逐任务执行，checkbox 跟踪。

**Goal:** 把失败分类从"正则猜"升级为结构化分类契约，激活死掉的 no-progress 信号，让被吞的失败可见，并为临时工提供一等健康观测；外包退避封顶转永久失败。
**Spec:** `docs/superpowers/specs/2026-08-12-subagent-observability-design.md`
**Tech Stack:** TypeScript、better-sqlite3、vitest

## Global Constraints
- 不改临时工招/遣模型；不重写 `_pumpThread`，只插点。
- `isRecoverableSessionError(error)` 签名与语义对既有调用方（engine 会话恢复、task.ts:872 failTask）**行为兼容**：原先匹配的超时/网络/exit/context 仍判为可重试；原先不匹配的仍不重试；新增仅是把 config/capability/permanent 显式分类。
- 新增迁移命名 `YYYYMMDDHHMMSS_<slug>.sql`，纯新增列带默认值。
- 每个 B 批次结束跑 `npm run typecheck` + `npm test`（相关 spec）。

## File Structure
- **Modify:** `src/shared/retry-policy.ts`（分类契约）、`src/server/executors/safety.ts`（激活 no-progress + 纯谓词）、`src/server/domain/outsourcing-contract.ts`（退避封顶）、`src/server/domain/inspector.ts` 或 coordinator（临时工健康）。
- **Create:** `tests/unit/retry-policy.spec.ts`、`tests/unit/safety.spec.ts`、`tests/unit/outsourcing-backoff.spec.ts`、迁移 `20260812150000_failure_category.sql`、`20260812151000_outsourcing_auto_accept_max.sql`。

## Task B1：失败分类契约 + 激活 no-progress（基础，杠杆点）
**Files:** `src/shared/retry-policy.ts`、`src/server/executors/safety.ts`、`tests/unit/retry-policy.spec.ts`、`tests/unit/safety.spec.ts`
- [ ] **Step 1：写失败测试** — `tests/unit/retry-policy.spec.ts`：tagged 错误(4 类)、AppError code(no_progress/budget→permanent)、transient 正则(timeout/network/exit/context)、config_error(401/api key)、capability_gap(not supported)、unknown→permanent；`isRecoverableSessionError` 仅 transient 为 true。`tests/unit/safety.spec.ts`：`hasRepeatedFailure`/`hasNoProgress` 纯谓词。
- [ ] **Step 2：跑测试确认失败**
- [ ] **Step 3：实现** — retry-policy 增 `FailureCategory`/`classifyFailureCategory`/`CategorizedFailure`；`isRecoverableSessionError` 改为 `classifyFailureCategory(error)==='transient'`。safety.ts 抽出纯谓词 `hasRepeatedFailure`/`hasNoProgress`，`assertSafeToRun` 接入 no-progress。
- [ ] **Step 4：跑测试确认通过**
- [ ] **Step 5：typecheck 通过**

## Task B2：失败必上报 + 临时工健康聚合（可见性）
**Files:** `src/server/task-engine/engine.ts`（去静默吞）、迁移 `20260812150000_failure_category.sql`（task_event 加 failure_category）、`inspector`/coordinator 临时工健康。
- [ ] 去掉仅 `log.warn` 的 catch：讨论触发/reflection 入队/handover 失败时追加 `task_event` + lifecycle event。
- [ ] `task_event.failure_category` 落分类（engine.ts:534 classifyRunFailure 处）。
- [ ] 临时工健康聚合查询（按 dispatcherAgentId 聚合在岗/失败率/预算/最近 artifact）+ inspector 消费。
- [ ] 测试 + typecheck。

## Task B3：外包退避封顶转永久失败
**Files:** `src/server/domain/outsourcing-contract.ts`、迁移 `20260812151000_outsourcing_auto_accept_max.sql`、`tests/unit/outsourcing-backoff.spec.ts`
- [ ] contract 增 `auto_accept_max_attempts`（默认 8）；`autoAcceptContract` 达上限转 `auto_accept_disabled` 并发 event。
- [ ] 测试 + typecheck。

## Self-Review Notes
- 确认 `isRecoverableSessionError` 对 task.ts:872 传字符串仍按 transient 正则判定（无回归）。
- 确认 no-progress 仅在 ≥3 次 completed-without-artifact 时触发，不误伤正常单次完成任务。
