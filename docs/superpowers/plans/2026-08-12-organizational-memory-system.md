# 组织记忆系统（三库四流 + 晋升流）实现计划

**Status:** In progress — E1 可立即执行；E2–E4 gated（见 Maturity Assessment）。
**Spec:** `docs/superpowers/specs/2026-08-12-organizational-memory-system-design.md`
**关联 PRD:** `docs/PRD-agent-company-workbench.md` — Organizational Memory and Self-Evolution 概念段

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:executing-plans` 与 red-green-refactor 推进每个 Task。每个 Task 完成后必须 `npm run typecheck` + 相关 vitest green 才能进入下一个 Task。

**Goal:** 把 muster 已有但割裂的四套反思机制（`report` / `reflection` / `optimization-report` / `brainstorm`）连成一个统一的组织进化闭环：感知 → 反思 → 晋升 → 装配；补上工具埋点、用户反馈提取、质量进评级三个断点；让公司一次做对率可度量、可改进。

**Architecture:** 三库（工作/经验/结构）四流（sense/reflect/promote/assemble）。晋升流是单循环（reflection）到双循环（optimization-report）之间缺失的桥。**不新建第六套建议表**——复用 `report_action_item` + `optimization-report-executor`。自主性 = 自动 + 版本回滚 + 锁定豁免。

**Tech Stack:** TypeScript, better-sqlite3, Vitest, 既有 reflection/optimization-report/memory 管线。

---

## Maturity Assessment（诚实判断，决定批次优先级）

| 批次 | 成熟度 | 判断 | 依据 |
|---|---|---|---|
| **E1 感知层打通** | 高 | **立即做** | 修复的是已建好却零调用的死代码（`recordCapabilityUsage`）和三个明确断点；低风险、纯收益；不动组织结构，只补数据 |
| **E2 晋升流** | 中 | **gated on E1 数据** | 晋升流是核心创新，但 fingerprint 聚类策略不能拍脑袋——必须先有 E1 跑出的真实 lesson/反馈数据，观察分布后再定 fingerprint 粒度与阈值。否则要么噪声爆炸（一堆重复建议）要么误合并（不同问题被当成同一个） |
| **E3 建议层扩展** | 中 | 依赖 E2 | 机械扩展（4 个 actionType + apply 分支），但只有在 E2 真能产出有价值的 promotion_candidate 后才有意义 |
| **E4 做梦自主回路** | 低 | 依赖 E1–E3 | idle 自主反思的 ROI 和预算频率需观察 E1–E3 效果后再定；现在 brainstorm 手动触发可能是有意为之（控成本） |

**结论：** 本计划 **E1 为可执行 checkbox 清单**，**E2–E4 为 gated 框架**（写出方向、文件、验证门，但具体步骤待 E1 数据回流后再细化为 checkbox）。这符合用户"per-unit verification before advancing"的偏好，也符合 spec"渐进验证"原则。

---

## Global constraints

- 不新建通用建议表：所有结构改动建议复用 `report_action_item`（扩 actionType）。
- 零 schema 改动优先：用户偏好复用 `memory scope='personal'`（已全量注入）；工具复用 `tool_registry.is_default`。
- 测试约定：specs 在 `tests/unit/*.spec.ts` 与 `tests/integration/*.spec.ts`（**不**与 `src/` 同目录）；集成测试用 `tests/integration/setup.ts` 的 `makeTestDb()`/`setDbForTest()`；migration 命名 `YYYYMMDDHHMMSS_<slug>.sql`（实施时用当前时间戳）。
- 每条自动结构变更必须有审计记录（为 E2 回滚铺路）。
- 工具埋点调用方吞异常（`recordCapabilityUsage` 已是纯 INSERT，失败不得影响主流程）。
- 边界：完整 .pptx/Word/视频编辑不在范围；本系统交付物为内容/文案/视觉素材类成果。

---

# 批次 E1：感知层打通（可立即执行）

目标：修复三个断点，让数据真正流动。**这是整个引擎的地基，也是唯一不需要 LLM 策略判断、纯机械修复的批次。**

## Task E1.1 — 工具调用埋点（接通 `recordCapabilityUsage`）

**背景：** `recordCapabilityUsage`（`src/server/domain/capability-quality.ts:33`）和 `capability_usage_stat` 表（`migrations/20260812152000`）已就位，读侧 `getAllCapabilityQuality` 已在 `tool-recommendation.ts:63,74,107` 接入，但**写侧零调用方**，表恒空。

**Files:**
- Modify `src/server/executors/tools/registry.ts`（`executeTool` 约 `:1288`）
- Modify `src/server/executors/tool-loop.ts`（`runToolLoop` 约 `:95-197`）—— 埋点首选位置（已有完整 db/taskId 上下文）
- Modify `src/server/executors/tools/registry.ts` 的 `ToolContext` 类型（若选 executeTool 埋点，需加 `db?` + `taskId?`）
- Test `tests/integration/capability-usage-recording.spec.ts`

**Steps:**
- [x] 确认埋点位置：优先 `runToolLoop`（每个 `executeTool` 调用前后包 try/finally），因其持有 db/taskId；若 `runToolLoop` 拿不到 capability_id，则在 `executeTool` 埋点并给 `ToolContext` 加可选 `db?: DB` / `taskId?: string`（不破坏现有调用方）。
- [x] 埋点逻辑：记录 `outcome`（success/fail，按 `ToolResult` 是否 error 判定）、`durationMs`（`Date.now()` 差）、`capabilityId`（从 `RuntimeTool.source`/`capabilityId` 字段取）、`toolId`（`call.name`）、`taskId`（ctx）。
- [x] 用 `try { ... } finally { try { recordCapabilityUsage(...) } catch { /* 吞掉 */ } }` 包裹，**绝不**让埋点异常冒泡影响工具执行。
- [x] 仅对有 capability_id 的工具记录（内置 file 工具若无 capability 归属可跳过或归入 `builtin`）。

**TDD acceptance:**
- [x] 执行一次成功工具调用后，`capability_usage_stat` 多一行 `outcome='success'` 且 `duration_ms > 0`。
- [x] 工具抛异常时记 `outcome='fail'`，且主流程行为不变（错误照常上报）。
- [x] `getAllCapabilityQuality` 返回非空，`tool-recommendation` 的 `quality` 字段非 null。
- [x] 埋点自身失败不导致 task 失败（注入故意 throw 的 recordCapabilityUsage，task 仍正常完成）。
- [x] `npm run typecheck` green；新 vitest green。

**Commit:** `feat(E1): record capability usage on every tool call — activate quality feedback loop`

---

## Task E1.2 — 用户反馈提取进反思（接通偏好记忆）

**背景：** `reflection.ts:243-258` 的 prompt 只喂 task 字段，不读用户反馈文本。三处反馈（`business_review.feedback` / `conversation_message`(role=user) / `task_message`(role=user)）无提取器。`memory.ts:99-101` 的 author=user 自动批准通道无人使用。

**Files:**
- Modify `src/server/domain/reflection.ts`（`reflectOnTask` 约 `:205`，prompt 装配段 `:243-258`）
- Modify `src/server/domain/memory.ts`（复用 `createMemoryCandidate`，无需改）
- Test `tests/integration/reflection-feedback-extraction.spec.ts`

**Steps:**
- [x] 在 `reflectOnTask` 里 `getTask` 之后，新增查询：拉取该 task 相关的 `business_review.feedback`（按 `review.taskId` 或 `contextRefs LIKE '%business_review:%'`）、最近若干条 `task_message`(role=user)、相关 `conversation_message`(role=user)。
- [x] 把反馈文本拼进反思 prompt（新增 `# 用户反馈` 段），让 LLM 在产 LESSON/RULE 之外，额外识别**用户偏好**信号（"用户明确喜欢/讨厌 X"）。
- [x] 扩展反思输出 schema：增加可选的 `PREFERENCE` 产物（{content, confidence, domain}），命中则 `createMemoryCandidate({scope:'personal', author:'user', sourceTaskId, confidence})` → 走 `memory.ts:99-101` 自动批准。
- [x] 偏好候选带 `domain` 标签（如 `style`/`tone`/`format`），为 E2 fingerprint 铺路。
- [x] 控量：单次反思最多产 1-2 条 preference，避免噪声；置信度 < 0.7 不产。

**TDD acceptance:**
- [x] 一个带 `business_review.feedback='太花了，要更商务'` 的 task 反思后，`memory_candidate` 多一条 scope=personal/author=user 的偏好候选。
- [x] 偏好候选命中自动批准条件，落 `memory_entry`。
- [x] 无反馈的 task 反思行为不变（不产 preference，仍产 LESSON/RULE）。
- [x] 下次该 profile 执行时，`loadContextMemories` 注入了该偏好（personal 全量注入）。
- [x] typecheck + vitest green。

**Commit:** `feat(E1): extract user preferences from feedback into personal memory during reflection`

---

## Task E1.3 — rework 反思信号接线

**背景：** `reflection.ts:28-33` 的 `ReflectionSignal` 枚举里有 `'rework'`，但代码无入队点——验收被打回时不反思。

**Files:**
- Modify `src/server/domain/business-review.ts`（返工派发处 `:210-216`，`createTask` 之后）
- Modify `src/server/domain/reflection.ts`（确认 `enqueueReflection` 接受 rework 信号；prompt 对 rework 信号强调"为什么被打回、下次如何一次做对"）
- Test `tests/integration/reflection-rework-signal.spec.ts`

**Steps:**
- [x] `business-review.ts:211` `createTask` 成功后，调 `enqueueReflection({ taskId, signal: 'rework', ... })`（反思对象是原 task + 返工反馈，根因在原 task）。
- [x] reflection prompt 按 signal 分支：`rework` 时强调根因分析与"一次做对"建议，并把 `business_review.feedback` 作为关键输入。
- [x] rework 反思产的 LESSON 带 `signal:rework` 溯源标签（为 E2 质量触发铺路）。

**TDD acceptance:**
- [x] 验收 changes_requested 后，`task_reflection` 多一条 `signal='rework'` 的 pending 记录。
- [x] drain 后产出的 LESSON 引用了返工反馈。
- [x] 不影响现有 completed/failed 信号路径。
- [x] typecheck + vitest green。

**Commit:** `feat(E1): enqueue reflection on rework — learn from rejected deliverables`

---

## Task E1.4 — `task.rework_count` + 质量进评级

**背景：** 普通 task 无返工一等字段（返工靠 JOIN `business_review` 反推）；`calculateRating`（`employee-rating.ts:30-76`）四维纯体量；`failureRate` 在 `optimization-report.ts:182` 算过却没回灌评级。

**Files:**
- Create `src/server/db/migrations/<TS>_task_rework_count.sql`
- Modify `src/server/domain/business-review.ts`（返工派发 `:211` 后递增）
- Modify `src/server/domain/task.ts`（TaskRow/类型加 `rework_count`）
- Modify `src/server/domain/employee-rating.ts`（`calculateRating` 加质量维度）
- Modify `src/shared/` 相关类型（如 `RatingBreakdown` 扩展）
- Modify `src/client/api/types.ts`（前端类型）
- Test `tests/integration/task-rework-count.spec.ts`
- Test `tests/integration/employee-rating-quality.spec.ts`

**Steps:**
- [x] Migration：`ALTER TABLE task ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0`。
- [x] `business-review.ts` 返工派发处：`UPDATE task SET rework_count = rework_count + 1 WHERE id = ?`（对原 task；即使原 task 被 cancel，rework_count 作为历史统计保留）。
- [x] `calculateRating` 加质量维度：查询该 profile 的 `SUM(rework_count)` 与 `COUNT(completed task)`，算返工率；纳入 score（负向权重，如 `score -= reworkCount * 0.8`，或单独质量分维度）。同步更新 `RatingBreakdown` 类型与 STAR 阈值（可能需微调阈值，用 `recalculateAllRatings` 验证不破坏现有星级分布）。
- [x] 一次通过率视图：新增查询函数 `getOnboardingPassRate(db, {profileId?|companyId?})` = `rework_count=0 的完成 task / 总完成 task`。

**TDD acceptance:**
- [x] Migration 后 `task.rework_count` 存在，默认 0。
- [x] 一次返工后原 task `rework_count=1`；两次返工后 `=2`。
- [x] `calculateRating` 对高返工 profile 给出更低 score（同等体量下）；高质量 profile 星级不低于现状。
- [x] `getOnboardingPassRate` 返回正确比率；无 task 时返回 null（区分"无数据"）。
- [x] `recalculateAllRatings` 不抛错；现有集成测试（依赖评级路由/外包排序）仍 green——必要时调整阈值。
- [x] typecheck + vitest green。

**Commit:** `feat(E1): add task.rework_count, feed quality dimension into employee rating`

---

## E1 整体验收

- [x] 跑一次真实 Task 流程（含一次返工），确认：`capability_usage_stat` 有数据、返工后 `rework_count` 递增、反思产出了偏好候选与 rework lesson、评级反映质量。
- [x] `npm run typecheck` + `npm test` 全 green。
- [x] **E1 数据回流检查点（E2 准入门）**：跑 1–2 天真实使用后，观察：
  - `capability_usage_stat` 的分布（哪些工具高频/高失败）
  - `memory_candidate`(scope=personal) 的偏好候选数量与去重难度
  - `task_reflection`(signal=rework) 的 lesson 是否有可聚类的共性
  - 据此**才**能定 E2 的 fingerprint 粒度与晋升阈值（写进 E2 细化计划）

---

# 批次 E2：晋升流（执行中）

**调整（实施时判断）：** E1 数据回流主要用于调阈值/粒度，不是前置硬门槛。fingerprint 策略改由 reflection 产经验时 LLM 同时产结构化 category 标签（`domain:topic`），聚类 = group by + count + distinct profile，初版用保守阈值，真实数据回流后再调优。这绕开了"必须先有数据才能定 fingerprint"的循环。

## Task E2.1 — memory fingerprint 基础设施
- [x] migration：memory_candidate + memory_entry 加 `fingerprint TEXT`（nullable，向后兼容）
- [x] createMemoryCandidate 接受 fingerprint；approveMemoryCandidate 透传到 entry；类型 + fromRow 映射
- [x] reflection prompt 让 LLM 为每条 LESSON/RULE/PREFERENCE 产 `domain:topic` 标签；parseSection 兼容解析（fingerprint 行可选，旧格式无标签时 null）
- Test `tests/integration/memory-fingerprint.spec.ts`
- Commit: `feat(E2): memory fingerprint — 结构化标签供晋升聚类`

## Task E2.2 — lesson 聚类 + 晋升触发
- [x] migration：promotion_candidate 表（fingerprint + scope + count + distinct_profiles + sample_entry_ids + status + created_at）
- [x] 新建 `src/server/domain/promotion.ts`：聚合查询 + 晋升触发（达阈值幂等 insert）+ 列表查询
- [x] reflection drain 完成后调用 `detectPromotions(db)`（检查未晋升 fingerprint 是否达阈值）
- [x] 保守阈值：同 fingerprint count ≥ 3 或 distinct profile ≥ 2（跨员工重复 = 组织级信号）
- Test `tests/integration/promotion.spec.ts`
- Commit: `feat(E2): lesson 聚类 + 晋升触发 → promotion_candidate`

## Task E2.3 — 结构记忆版本化 + 回滚（护栏，为 E3 自动落地铺路）
- [x] migration：structure_change_log（仿 artifact_change_log）
- [x] recordStructureChange + listStructureHistory + rollbackStructure(to version)
- Test + Commit: `feat(E2): 结构记忆版本化 + 回滚`

## Task E2.4 — 锁定豁免
- [x] migration：entity_lock（entity_type/entity_id/scope: personal|org/locked_fields）
- [x] 晋升流生成 action item 前查 lock 清单，命中降级为信息性 finding
- [x] 锁定/解锁记 structure_change_log
- Test + Commit: `feat(E2): 锁定豁免`

**E2 准出：** 同 fingerprint 达阈值后自动生成 promotion_candidate；结构变更有审计可回滚；锁定字段不被自动优化。晋升→report_action_item 的落地衔接在 E3。

---

# 批次 E3：建议层扩展（执行中）

**核心目标：** 把 promotion_candidate 衔接进既有 optimization-report 管线，并扩 4 个 actionType + apply 分支，让晋升流产出的候选能真正落地为结构变更。

## Task E3.1 — 扩 actionType 枚举 + executor 4 个 apply 分支
- [x] `optimization-report.ts:24` ACTION_TYPES 加 4 类：`update_user_preference` / `bind_habitual_tool` / `learn_workflow_pattern` / `adjust_skill_binding`
- [x] `optimization-report-executor.ts:115` executeAction switch 加 4 分支：
  - `update_user_preference` → createMemoryCandidate(scope=personal, author=user)（复用 reflection 偏好通路）
  - `bind_habitual_tool` → tool_registry.is_default=1 + capability_binding.recommended_tool_ids 重排
  - `learn_workflow_pattern` → 默认 skipped（只产建议，提示手动改流程图，与现有 adjust_workflow 一致的安全策略）
  - `adjust_skill_binding` → capability_binding.skill_ids_json 追加
- [x] 每个分支 apply 前查 isFieldLocked，命中则 skipped（复用 E2.4）
- [x] 每个分支 apply 后调 recordStructureChange（复用 E2.3 版本化）
- Test tests/integration/optimization-report-executor-e3.spec.ts
- Commit: `feat(E3): 扩 4 actionType + executor apply 分支（偏好/惯用工具/工作流/技能）`

## Task E3.2 — promotion_candidate → report_action_item 衔接
- [x] promotion.ts 新增 `promoteCandidatesToActions(db, companyId)`：读 pending promotion_candidate，按 scope/domain 翻译成对应 actionType 的 report_action_item（附在当日 optimization-report 或独立批次），写后 markPromoted
- [x] fingerprint→actionType 映射规则：scope=personal→update_user_preference；domain 含 tool→bind_habitual_tool；domain 含 workflow→learn_workflow_pattern；否则→adjust_skill_binding（附 sample contents 作 reason）
- [x] 由 coordinator 在 optimization-report 生成后调用（复用每日调度）
- Test tests/integration/promotion-to-action.spec.ts
- Commit: `feat(E3): promotion_candidate → report_action_item 衔接`

## Task E3.3 — AI 预筛分级（低风险自动 / 高风险审批）+ 锁检查
- [x] 复用 ai-approval.ts：低风险（偏好/惯用工具/提示词）AI 预筛后自动 approved；高风险（工作流/技能绑定/增裁员工/权限）保持 pending 等用户审批
- [x] executeApprovedActions 前对每个 item 跑 isFieldLocked，命中跳过 + 记录原因
- [x] 自动落地项的 result 写 structure_change_log（已在 E3.1 做）+ 通知公司对话窗
- Test 补 AI 预筛分级 + 锁跳过用例
- Commit: `feat(E3): AI 预筛分级 + 锁检查`

**E3 准出：** promotion_candidate 可翻译为 4 类 actionType 并落地（低风险自动/高风险审批）；apply 受锁保护、有版本审计；用户可在公司对话窗看到自动变更结果。工作流边运行时统计（traversal_count）留作可选增强，不阻塞本批次。

---

# 批次 E4：孤岛打通 + 可选做梦回路（执行中）

**范围聚焦（实施时判断）：** E4 拆成两半。**孤岛打通**（promoteCandidatesToActions 接进每日调度）是确定性高价值、零 LLM 成本的，必须做。**idle 自主 brainstorm**（做梦）有烧钱风险、ROI 需真实数据观察，做成**默认关闭的可配开关**，不贸然全自动。

## Task E4.1 — 孤岛打通：promoteCandidatesToActions 接进每日 optimization-report 调度
- [x] coordinator.scheduleOptimizationReports：每日报告生成后调 `promoteCandidatesToActions(db, company.id)`，把晋升候选转成 action item（低风险自动执行、高风险进报告等用户审批）
- [x] 这是 promoteCandidatesToActions 此前零调用方的唯一接入点——补上后整条 感知→反思→晋升→落地 闭环才真正在运行时跑起来
- Test tests/integration/coordinator-e4.spec.ts（调度后 promotion_candidate 被 consume + action item 产生）
- Commit: `feat(E4): 孤岛打通——promoteCandidatesToActions 接进每日调度`

## Task E4.2 — collectCompanyStats 消费反思/复盘产物（孤岛打通 2）
- [x] optimization-report.collectCompanyStats 增读：reflection 产出的 lesson 数、rework lesson 数、pending promotion_candidate 数（让 AI 报告看到进化信号）
- [x] 不改 AI prompt 结构（stats 是 AI 输入），只补字段
- Test 补 collectCompanyStats 含新字段
- Commit: `feat(E4): collectCompanyStats 消费反思/晋升信号`

## Task E4.3 — idle 自主反思开关（默认关闭，可选）
- [ ] 系统设置加 `autonomousReflectionEnabled`（默认 false）+ `autonomousReflectionBudgetUSD`（默认 0）
- [ ] coordinator 检测公司 idle（online 且无活跃 task）且开关开 → 触发轻量 reflection（复用 drainReflectionQueue 对近期 completed task 补反思）；受预算约束、正式 Task 到达让位
- [ ] 不做全自动 brainstorm（烧钱风险），只补 reflection（已有 LLM 成本控制）
- Test + Commit: `feat(E4): idle 自主反思开关（默认关闭）`

**E4 准出：** 每日调度自动消费晋升候选 → action item（闭环在运行时跑通）；optimization-report 能看到反思/晋升信号；自主反思默认关闭、用户可开。

---

## 回访修复（2026-08-13，E4 提交后的深度审计）

全部批次提交后做了一次深度审计（code-reviewer 两度因网络失败，改为人工逐文件复核 + 全量测试），发现并修复了 4 处问题——其中第 1 处意味着此前宣称的"自动落地闭环"实际是断的：

- [x] **自动落地路径死代码（Critical）**：`fingerprintToActionType` 默认映射 `adjust_skill_binding`，但晋升流只产 `{fingerprint}` 参数，而该 actionType 需要 agentName/skillId/capabilityId——所有晋升 item 永远 failed/pending，`update_user_preference` 自动执行分支不可达。修复：默认映射改 `update_user_preference`（重复经验固化为主导员工 personal 偏好记忆）；`tool:<toolId>` 主题段作 toolId；`workflow:` 保持 pending。测试改写为端到端断言"真的落地了"（promotion-to-action.spec.ts）。
- [x] **evolution 采集了但从不消费（High）**：`collectCompanyStats` 算 `evolution` 但规则报告与 AI 提示词都不读。修复：summary 提及 + stats 输出 + AI 提示词注入（optimization-report.ts）。
- [x] **skipped 状态不持久化（Medium）**：锁定豁免/已存在等"已处理但不执行"的结果不回写，item 永远停在 pending。修复：`executeItem` 持久化 `skipped`，状态枚举扩展。
- [x] **E4.1/E4.2 零测试（Medium）**：coordinator 串接与 evolution 消费无测试。修复：抽 `runDailyOptimizationReport` 可测 helper（coordinator.ts）+ 三类新测试（端到端落地 / evolution 入报告 / 每日链路串接）。

全量验证：typecheck green；1076 tests 通过（+3）。

---

## 风险与回滚（贯穿）

- **E1 低风险**：纯数据采集与既有管线接入，不动组织结构，不动 hot-path 语义。最坏情况是埋点多耗一点写入开销（可接受）。
- **E2 自动进化失控**：靠"低风险自动 + 高风险审批 + 版本回滚 + 锁定"四重护栏；E2 细化计划必须先做 fingerprint 原型验证。
- **评级阈值变动影响路由**：E1.4 改 `calculateRating` 可能影响现有依赖评级路由/外包排序的测试；用 `recalculateAllRatings` 验证分布，必要时微调 `STAR_THRESHOLDS`。
- **反馈提取误读**：E1.2 产的偏好候选走 `memory_candidate` 审核 UI，用户可修正/删除——不绕过审核。

## 不做（Out of Scope）

- 完整 .pptx/Word/视频编辑（CLAUDE.md 既定边界）。
- 多租户 SaaS、支付。
- 本计划 E2–E4 的具体 checkbox（待前置门通过后另出细化计划）。
