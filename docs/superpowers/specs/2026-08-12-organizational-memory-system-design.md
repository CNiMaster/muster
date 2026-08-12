# 组织记忆系统（三库四流 + 晋升流）设计

**日期**：2026-08-12
**状态**：设计稿（待实现）
**关联 PRD**：`docs/PRD-agent-company-workbench.md` — 新增「组织记忆与自我进化」概念段
**关联代码**：`src/server/domain/optimization-report.ts`、`src/server/domain/optimization-report-executor.ts`、`src/server/domain/reflection.ts`、`src/server/domain/report.ts`、`src/server/domain/brainstorm.ts`、`src/server/domain/memory.ts`、`src/server/domain/employee-rating.ts`、`src/server/domain/capability-quality.ts`、`src/server/domain/template-health-findings.ts`、`src/server/executors/tools/registry.ts`、`src/server/executors/context.ts`、`src/server/runtime/coordinator.ts`

---

## 背景与动机

### 起因

对标 MemSlides（清华/上交/北邮，2026-07，记忆驱动 Slides Agent）：它用「用户画像记忆 + 计划-执行-守卫 + 严格验证 + 工具记忆」让 AI 做 PPT 时一次做对率显著提升（闭环 96.3% / 严格验证 53.4% / 首次正确编辑 242.5s）。把它的四项能力抽掉 PPT 外衣，本质是**通用组织学习问题**：一个由 Agent 组成的"公司"如何从每一次执行中进化，使得下一次更接近"一次做对、减少返工"。

muster 已有一套接近"组织进化引擎"的雏形（`optimization-report` + `optimization-report-executor`，每日定时 + 8 种 actionType + 审批 + 自动固化），但与另外三套反思机制（`reflection` / `report` / `brainstorm`）**互相割裂**，且关键感知数据（工具调用、用户反馈）**零采集或零提取**，导致"进化"只停在 prompt 注入这一层，到不了组织结构。

### 病因诊断：知识转换链条断裂

muster 现状不是"缺进化能力"，而是**知识转换链条断裂**。用两个理论解释：

**组织学习的两个循环（Argyris & Schön）**

- 单循环（Single-loop）：做错 → 改动作。例：「这次 PPT 红色不对 → 下次别用红」。muster 的 `reflection` 是单循环——产 LESSON/RULE 注入 prompt，修正下次动作。
- 双循环（Double-loop）：做错 → 改规则/结构。例：「为什么默认用红？风格预设本身有问题」。muster 的 `optimization-report` 是双循环——调整员工/工作流/执行器/权限这些"结构"。

**问题**：两者不通。单循环的经验永远晋升不到结构层。同一个错反复犯，只动 prompt，不动结构。**缺一座从单循环到双循环的桥**。

**知识转换四环节（野中郁次郎 SECI）**

muster 四套机制正好各占一环，但断裂：

| SECI 环节 | 含义 | muster 对应机制 | 现状 |
|---|---|---|---|
| 社会化（Tacit→Tacit） | 经验共享 | `brainstorm` 头脑风暴 | 纯手动触发，产物不外溢 |
| 外化（Tacit→Explicit） | 隐性经验 → 显性规则 | `reflection` 任务反思 | 通到 memory，但只进 prompt |
| 组合（Explicit→Explicit） | 散落知识 → 结构建议 | `optimization-report` | 每日跑，但不消费 reflection/brainstorm 产物 |
| 内化（Explicit→Tacit） | 规则 → 个体本能 | `context` 装配 | 通（注入 prompt） |

四环断裂 = 信息孤岛。每一环都在工作，但环与环之间没有流。

---

## 设计目标

1. **一次做对、减少返工**：让公司从每次执行中学习，使下一轮更接近一次通过。
2. **统一进化引擎**：把四套孤岛连成一个连贯的闭环，而非叠加第五套。
3. **自动 + 可回滚 + 可锁定**：进化默认自动进行，但每次结构变更有版本历史可还原；关键要素可手动锁定豁免。
4. **平台级通用能力**：不绑定 PPT/视觉公司，任何公司模板通用；完整 .pptx 编辑仍在本地工作台范围外（CLAUDE.md 既定边界）。

---

## 现状诊断（file:line 依据）

### 四套割裂的反思机制

| 机制 | 粒度 | 触发 | 产物 | 落地 |
|---|---|---|---|---|
| `report` 周期复盘 | 公司/项目 | 计数/时间/里程碑（`report.ts:174-220`） | 人工备注 | → 纠正 Task（仅此一种，`triggers.ts:317-336`） |
| `reflection` 任务反思 | 单 task | task 终态（`reflection.ts:28-33`） | LESSON+RULE | → `memory_candidate` → 注入 prompt（`reflection.ts:205-326`） |
| `optimization-report` | 公司 | 每日定时（`coordinator.ts:391`） | AI+规则 action items | → 8 类自动固化（`optimization-report-executor.ts:115-263`） |
| `brainstorm` 头脑风暴 | 项目 | **纯手动**（`phase7.ts:87`） | suggestions | → 建议 Task 待采纳（`brainstorm.ts:179-210`） |

**信息孤岛**：reflection 的 lesson 不进 optimization-report 的事实基础（`collectCompanyStats`）；brainstorm 的 suggestion 不进任何东西；report 的备注只转 Task。

### 三个最高杠杆的断点

**断点 ①：工具调用零埋点**
`capability_usage_stat` 表（`migrations/20260812152000`）和写入函数 `recordCapabilityUsage`（`capability-quality.ts:33-46`）已就位（支持 outcome/durationMs/toolId/taskId），但**全局零调用方**。读侧 `getAllCapabilityQuality`（`capability-quality.ts:80-103`）已在 `tool-recommendation.ts:63,74,107` 接入推荐并标注 quality 字段，但表恒为空。PRD 提到的"真实使用质量（成功率、耗时、是否被反复弃用）"未落地。`tool_registry`（`migrations/0029`）只有 maturity/is_active/is_default，**无频次/惯用字段**。

**断点 ②：用户反馈零提取**
三处用户反馈文本——`business_review.feedback`（`migrations/20260717121000`）、`conversation_message`(role=user)（`0002_conversation:5-15`）、`task_message`(role=user)（`0001_init:240-247`）——**没有任何提取器**。`reflection.ts:243-258` 的 prompt 只喂 `task.summary/failureCount/interruptionCount/alignmentRounds/acceptanceCriteria`，不读反馈文本。这就是"程序缺用户偏好记忆"的根因。`memory.ts:99-101` 的自动批准通道（`scope='project' || author='user'`）存在但无人以 author=user 写入。

**断点 ③：评级无质量维度**
`calculateRating`（`employee-rating.ts:30-76`）四维全是体量：completedTasks×1 + memoryEntries×0.5 + employmentDays×0.2 + deliveredContracts×3。`failureRate` 在 `optimization-report.ts:182` 算过但**没回灌评级**。导致评级只反映"做了多少/多久"，不反映"做得多好"，进而路由（`agent-router.ts:82-87`）和外包排序（`outsourcing-decision.ts:199`）无法按质量择优。普通 task 也无 `rework_count` 一等字段（返工靠 JOIN `business_review` 反推）。

### 可复用骨架（不另起炉灶的依据）

- **优化报告管线**：`optimization-report.ts` 每日定时（`coordinator.ts:391` `scheduleOptimizationReports`，dbToday 去重）+ AI 优先规则 fallback（`:278-333`）+ 8 种 actionType（`:24-33`）+ 一键审批 + pending_offline 补执行（`coordinator.ts:431`，重试上限 `optimization-report-executor.ts:356-365`）。
- **统一 apply 入口**：`optimization-report-executor.ts:115-263` 按 actionType switch 分发。
- **fingerprint 去重**：`template-health-findings.ts:170` 的 `${code}:${target}` + refresh 事务 upsert/resolved（`:19-48`）。
- **记忆候选管线**：`memory.ts:76` `createMemoryCandidate` → 审批 → `memory_entry`；`scope='personal'` 已被 `loadContextMemories` 全量注入（`memory.ts:264-266,280-287`）——**用户偏好记忆零 schema 改动即可落**。
- **审计模式**：`artifact_change_log`（`artifact-audit.ts`）可扩展为结构变更审计。
- **brainstorm 安全护栏**：预算（`brainstorm.ts:64-71` `dailyDiscussionBudgetUSD`）+ 让位正式 Task（`:142-165`）+ `autoSelectParticipants` idle 检测（`:91-101`）。
- **装配顺序**：`context.ts:59-311` 共 14 层，记忆在第 12 层（`:206-219`）；偏好可复用 personal scope 或在第 6 层后单推 `# 用户偏好` 段。

---

## 核心架构：三库四流

### 三个记忆库（按稳定度分层）

| 记忆库 | 稳定度 | 内容 | 现有承载 |
|---|---|---|---|
| **工作记忆** Working | 易变（单 task） | 当前任务上下文 | thread 会话、`compaction_summary`、recentDiscussion |
| **经验记忆** Episodic | 中稳（按事件） | lesson / rule / 用户反馈 | `memory_entry`（scope=project/personal） |
| **结构记忆** Structural | 高稳（组织形态） | 员工能力 / 工作流 / 工具配置 / 用户偏好画像 | `agent_definition` / `workflow` / `capability_binding`+`tool_registry` / 偏好记忆(personal 聚合) |

分层依据：变更成本与影响面。工作记忆每 task 重置；经验记忆跨 task 累积但单条可弃；结构记忆改动影响整个组织，需版本化与锁定。

### 四条流

```
感知流 → 反思流（单循环）→ 晋升流（单→双循环的桥）→ 装配流
   ↑                                                        │
   └────────────── 执行产生新数据（下一轮感知）←──────────────┘
```

| 流 | 输入 | 输出 | 现状 |
|---|---|---|---|
| **感知流** Sense | 执行事件（task 终态、工具调用、用户反馈、返工） | 结构化原始数据 | 部分有（task 字段），工具/反馈断 |
| **反思流** Reflect | 工作记忆 + 感知数据 | 经验记忆（lesson/rule） | `reflection.ts` 通，但输入不含反馈文本，rework 信号未接线 |
| **晋升流** Promote ⭐ | 经验记忆聚类 + 质量指标 | 结构改动建议（→ optimization-report） | **完全缺失（核心创新）** |
| **装配流** Assemble | 结构记忆 + 经验记忆 | 下次执行上下文 | 通（`context.ts`） |

### 晋升流（核心创新）

muster 当前最缺的一环，也是"做梦"真正的工程价值。

**机制**：经验记忆里的 lesson/rule 按 fingerprint 聚类。当满足下列任一条件，自动晋升为结构改动建议，喂给 optimization-report：

- **频次阈值**：同一 fingerprint 的 lesson 出现 ≥ N 次（默认 N=3，可配）。
- **跨员工重复**：同一 lesson 模式被 ≥ 2 个不同 profile 沉淀（说明是组织级问题而非个人）。
- **质量触发**：某员工/环节的返工率/失败率超阈值（质量指标驱动）。
- **用户强信号**：用户反馈中同主题出现 ≥ M 次（"不要红色""要更商务"反复说 → 晋升为偏好画像条目）。

**fingerprint 设计**（复用 `template-health-findings.ts:170` 模式）：`${domain}:${target}:${intent}`，例如：
- `preference:color:avoid-red`（用户偏好）
- `skill:investor-deck:needs-chart`（员工能力缺口）
- `workflow:designer→reviewer:frequent-handoff`（工作流模式）
- `tool:image-gen:high-failure`（工具质量）

**晋升产物**：一条 `report_action_item`（复用现有载体，扩 actionType），走现有审批/AI 预筛/pending_offline 管线。**不新建通用建议表**（避免第 6 套孤岛）。

**置信度与防噪**：晋升建议带置信度（频次/跨度/质量加权）；低置信度只入"待观察池"，不立即生成 action item。复用 reflection 的置信度门槛思路（`reflection.ts:296,315` 的 ≥0.8 自动批准）。

---

## "做梦"的工程对应（非玄学）

睡眠神经科学为"事后反思系统"提供阶段划分，每阶段对应一个工程组件：

| 睡眠阶段 | 神经科学功能 | 工程对应 | muster 实现 |
|---|---|---|---|
| **REM**（快速眼动） | 整合当日记忆、情绪加工 | 任务级反思 | `reflection.ts`（已有，补 rework 信号 + 反馈读取） |
| **慢波睡眠** | 记忆巩固，海马体 → 新皮层（短期→长期） | 经验晋升到结构 | **晋升流（新）** |
| **晨醒整理** | 整理完毕，准备新一天 | 每日组织级汇总 | `optimization-report` 每日定时（已有） |
| **白天走神** | 发散思维，受限于注意力 | idle 自主头脑风暴 | idle 自主 brainstorm（新，复用护栏） |

"做梦" = **反思流 + 晋升流的离线整合**。它不是新机制，而是给现有 reflection + optimization-report 补上中间的晋升环节，并让它们在公司 idle 时自主运行。

---

## 自主性模型：自动 + 可回滚 + 可锁定

落实用户要求"建议自主自动，保留历史记录可还原，可被自动升级修改的提供手动锁定，锁定后下次不再优化该个人或组织"。

### 自动（乐观写入）

- 晋升流默认开启。
- **低风险类别**（用户偏好 / 惯用工具 / 提示词原则）AI 预筛后自动落地（复用 `ai-approval.ts` 预判）。
- **高风险类别**（改工作流边 / 权限 / 增裁员工）仍走用户审批（现状模式）。
- 所有自动落地仍记 `pending_offline`，需下班执行的组织变更在公司 draining→off 时补执行（复用现有安全网）。

### 可回滚（结构记忆版本化）

- 新建 `structure_change_log`（仿 `artifact_change_log`）：每次结构变更（无论自动/人工）记一条——entity_type / entity_id / field / old_value / new_value / source（promotion:user-feedback / promotion:lesson-cluster / manual / optimization-report）/ version / changed_at / changed_by。
- 每个 structure entity 维护版本号；回滚 = 恢复指定旧版本（带 diff 预览）。
- 复用 `artifact_change_log` 的审计 API 模式（`artifact-audit.ts`）。

### 可锁定（手动豁免）

- 结构要素可标 `locked`，分两个作用域：
  - **个人锁**（`agent_definition.metadata.lockedFields` / 偏好条目 locked）：该员工的指定字段不被晋升流优化，但组织级优化仍可绕过。
  - **组织锁**（公司级锁清单）：该要素任何来源的自动优化都跳过，只有用户手动可改。
- 晋升流生成 action item 前先查 lock 清单，命中则降级为"信息性 finding"（展示但不执行），并在 UI 提示"已锁定，如需优化请解锁"。
- 锁定/解锁本身记入 `structure_change_log`（可审计）。

---

## 四个固化出口（用户要的四件事，统一为晋升流的出口）

所有出口复用 `report_action_item` 载体 + `optimization-report-executor` apply 分发，仅扩 actionType 与对应 apply 分支。

### 出口 1：用户偏好记忆

| 维度 | 设计 |
|---|---|
| 感知源 | `business_review.feedback` + `conversation_message`(role=user) + `task_message`(role=user) |
| 提取 | 反思流 drain 增读反馈文本，LLM 提炼偏好候选 → `createMemoryCandidate(scope='personal', author='user')`，命中 `memory.ts:99-101` 自动批准 |
| 晋升 | 同主题偏好 ≥ M 次晋升为画像条目（actionType `update_user_preference`） |
| 固化 | 写 `memory_entry`(personal)，已被 `loadContextMemories` 全量注入（`memory.ts:264-266`）；可选在 `context.ts:126` 后单推 `# 用户偏好` 段更显眼 |
| schema 改动 | **零**（复用 personal scope） |

### 出口 2：惯用工具

| 维度 | 设计 |
|---|---|
| 感知源 | `executeTool`（`registry.ts:1288`）包 try/finally → `recordCapabilityUsage`（接通断点 ①） |
| 聚合 | `capability_usage_stat` 按 tool_id/company 聚合 success_rate / count / avg_duration |
| 晋升 | 高频高成功工具晋升为 `capability_binding.recommended_tool_ids` 首位；低成功工具降级或弃用建议 |
| 固化 | actionType `bind_habitual_tool` → 写 `tool_registry.is_default` / `capability_binding.recommended_tool_ids_json` |
| 推荐 | `tool-recommendation.ts:31-33` quality 字段激活，按真实成功率排序 |

### 出口 3：工作流模式

| 维度 | 设计 |
|---|---|
| 感知源 | task 交接链（`dispatcher_agent_id`/`parent_task_id`/`assignee_agent_id` 已有）聚合 A→B 频次 |
| 晋升 | 高频交接且不在现有 workflow 图中的 → 建议加边；回流频繁的 → 建议加条件边/maxTraversals |
| 固化 | actionType `learn_workflow_pattern` → **默认只产建议**（工作流改动风险高，不自动 apply，用户确认后走 `saveWorkflow`）；可配为自动 |
| 注意 | workflow 边无运行时 traversal 统计（`workflow.ts:326` 只单次防环），本出口新增持久化统计列 |

### 出口 4：员工能力

| 维度 | 设计 |
|---|---|
| 感知源 | lesson 聚类（某员工重复某类 lesson）+ 返工率/失败率（质量指标） |
| 晋升 | 重复能力缺口 → 建议补 skill；高返工 → 建议调提示词原则或换执行器 |
| 固化 | actionType `adjust_skill_binding`（新，写 `capability_binding.skill_ids_json`）/ 复用 `prompt_optimization`（`optimization-report-executor.ts:241-260`）/ `adjust_executor` |

---

## 质量指标双用途

一个数据源驱动两个循环（路由 + 进化）：

- **task 新增 `rework_count`** 一等字段（类比外包 `outsourcing_contract.revision_round`），由 `business-review.ts:178-223` 派返工 Task 时递增。一次通过率 = `rework_count=0 的完成 task / 总完成 task`。
- **`calculateRating`（`employee-rating.ts:30-76`）加质量维度**：在现有四维体量分之外，新增质量分（返工率/一次通过率/平均验收轮次加权），合成最终星级。质量分既有的原料（`failureRate`）已在 `optimization-report.ts:182` 算过，搬到评级即可。
- **质量信号驱动晋升流**：高返工的员工/环节触发结构优化建议（出口 4），形成"质量差 → 自动找根因 → 改结构 → 质量提升"闭环。

---

## 做梦自主回路

**现状**：brainstorm 完全手动（`phase7.ts:87`），公司 idle 时不会主动思考。

**设计**：coordinator（`coordinator.ts`）检测公司 idle（online 且无活跃 task 且未在 review_paused）→ 自主触发轻量反思/brainstorm：
- 复用 `autoSelectParticipants`（`brainstorm.ts:91-101`）的 idle 检测选参与者。
- 复用 `dailyDiscussionBudgetUSD`（`:64-71`）预算控制与让位护栏（`:142-165`）——正式 Task 到达立即中止。
- 反思/优化频率可配（系统设置或公司设置：每日/每 N 小时/idle 触发，默认每日）。
- 产物汇入 optimization-report 事实基础（打通孤岛）。

**安全**：做梦期间不派发生产 Task；产出只进反思/建议通道，不直接改结构（仍走晋升流+审批/自动+回滚）。

---

## 数据模型变更（按批次，最小化）

| 变更 | 批次 | 说明 |
|---|---|---|
| `task.rework_count` INTEGER DEFAULT 0 | E1 | 返工一等字段 |
| `employee_rating_quality`（或扩 `agent_profile` 列） | E1 | 质量分缓存（可由 calculateRating 重算） |
| 接通 `recordCapabilityUsage` 调用（无新表） | E1 | 激活现有空表 `capability_usage_stat` |
| `structure_change_log` 新表 | E2 | 结构变更版本审计（仿 artifact_change_log） |
| `entity_lock`（或在各 entity 加 locked metadata） | E2 | 锁定豁免 |
| `lesson_cluster` / `promotion_candidate` 新表 | E2 | 晋升流聚类与待观察池 |
| `report_action_item.actionType` 枚举扩展 | E3 | 加 4 类（见四出口） |
| `workflow_edge.traversal_count` | E3（配合出口3） | 工作流边运行时统计 |
| 反馈提取（无新表，复用 memory_candidate） | E1 | reflection drain 增读反馈 |

**原则**：零 schema 改动优先（用户偏好复用 personal scope、工具复用 is_default）；新增表只在确无现成载体时引入。

---

## 批次划分

### E1 感知层打通（地基，最高杠杆）

目标：修复三个断点，让数据真正流动。

1. **工具调用埋点**：`executeTool`（`registry.ts:1288`）包 try/finally，按 `RuntimeTool.source`/capability_id 调 `recordCapabilityUsage`（success/fail + durationMs + task_id）。激活整条"工具质量 → 推荐排序 → 惯用工具固化"链路。
2. **用户反馈提取**：reflection drain（`reflection.ts:147-181`）增读 `business_review.feedback` + 相关 `task_message`/`conversation_message`(role=user)，LLM 提炼偏好候选 → `createMemoryCandidate(scope='personal', author='user')`。接通断点 ②。
3. **返工一等字段 + 质量进评级**：task 加 `rework_count`（business-review 派返工时递增）；`calculateRating` 加质量维度；一次通过率可查。
4. **rework 反思信号接线**：`reflection.ts:28-33` 的 `rework` 信号枚举已有但无入队点，在 business-review changes_requested 时 `enqueueReflection({signal:'rework'})`。

### E2 晋升流（核心创新）

目标：搭建单循环 → 双循环的桥。

1. **lesson fingerprint 聚类**：`lesson_cluster` 表 + 聚合查询（按 `${domain}:${target}:${intent}`）。
2. **晋升触发**：频次/跨员工/质量/用户强信号四类触发 → 生成 `promotion_candidate` → 达阈值转 `report_action_item`。
3. **结构记忆版本化**：`structure_change_log` + entity 版本号 + 回滚 API。
4. **锁定机制**：`entity_lock`（个人/组织作用域），晋升流查 lock 清单降级为信息性 finding。

### E3 建议层扩展

目标：四出口落地。

1. `report_action_item.actionType` 扩 4 类（`update_user_preference` / `bind_habitual_tool` / `learn_workflow_pattern` / `adjust_skill_binding`）。
2. `optimization-report-executor` 扩 apply 分支（偏好→memory personal / 工具→is_default+recommended / 工作流→建议 / 技能→skill_ids）。
3. AI 预筛分级（低风险自动、高风险审批），复用 `ai-approval.ts`。
4. 工作流边运行时统计列 + 从交接链生成工作流建议。

### E4 做梦自主回路 + 孤岛打通

目标：让引擎自主运转。

1. coordinator idle 检测 → 自主反思/brainstorm（复用护栏）。
2. reflection/report/brainstorm 产物汇入 optimization-report `collectCompanyStats`（打通四孤岛）。
3. 反思/优化频率可配（系统设置或公司设置）。
4. 结构变更通知进公司对话窗（复用 `notifyExecutionResults` 模式）。

---

## 改动面清单（按批次）

### E1
- `src/server/executors/tools/registry.ts`（executeTool 埋点）
- `src/server/domain/capability-quality.ts`（已有，接通调用）
- `src/server/domain/reflection.ts`（drain 增读反馈 + rework 信号）
- `src/server/domain/business-review.ts`（派返工时 rework_count++ + enqueueReflection）
- `src/server/domain/employee-rating.ts`（calculateRating 加质量维度）
- `src/server/db/migrations/`（task.rework_count）
- `src/server/api/*`（返工指标查询）

### E2
- 新建 `src/server/domain/promotion.ts`（晋升流核心）
- 新建 `src/server/domain/structure-versioning.ts`（版本+回滚）
- `src/server/domain/template-health-findings.ts`（fingerprint 模式参考）
- `src/server/domain/optimization-report.ts`（消费 promotion_candidate）
- `src/server/db/migrations/`（lesson_cluster / promotion_candidate / structure_change_log / entity_lock）

### E3
- `src/server/domain/optimization-report.ts`（actionType 枚举）
- `src/server/domain/optimization-report-executor.ts`（apply 分支）
- `src/server/domain/workflow.ts`（边统计 + 模式生成）
- `src/shared/`（actionType 类型）
- 前端审批/建议面板

### E4
- `src/server/runtime/coordinator.ts`（idle 检测 + 自主触发）
- `src/server/domain/brainstorm.ts`（复用护栏）
- `src/server/domain/optimization-report.ts`（collectCompanyStats 汇流）
- 系统设置（频率配置）

---

## 验收标准

### E1
- 工具调用后 `capability_usage_stat` 有数据；`tool-recommendation` 的 quality 字段非空且按真实成功率排序。
- 用户在审批/对话里表达偏好后，下次相关任务执行时 system prompt 出现该偏好（personal 记忆注入）。
- task 返工后 `rework_count` 递增；公司看板/复盘可见"一次通过率"。
- 星级反映质量（高返工员工星级下调，高质量员工上调），并影响路由/外包排序。

### E2
- 同一 lesson 出现 N 次后自动生成 promotion_candidate，达阈值转 action item。
- 任何结构变更（自动/人工）在 `structure_change_log` 有记录，可按版本回滚。
- 锁定某员工字段后，晋升流不再生成针对该字段的 action item（降级为信息性 finding）。

### E3
- 四类新 actionType 可生成、可审批/自动落地、可在 executor 执行。
- 工作流建议基于真实交接频次（非凭空）。

### E4
- 公司 idle 时自主触发反思/brainstorm，受预算约束，正式 Task 到达让位。
- optimization-report 的事实基础包含 reflection/report/brainstorm 产物（孤岛打通）。

---

## 风险与边界

- **自动进化的失控风险**：靠"低风险自动 + 高风险审批 + 版本回滚 + 锁定"四重护栏。回滚是最后安全网。
- **晋升流噪声**：fingerprint 设计 + 置信度门槛 + 待观察池，避免一次性偶发 lesson 就改结构。
- **反馈提取误读**：用户反馈 LLM 提炼需用户可在记忆审核界面修正/删除（复用现有 memory 审批 UI）。
- **做梦打扰正式工作**：严格让位护栏 + 预算上限 + 不派发生产 Task。
- **工作流自动改风险高**：出口 3 默认只建议不自动 apply，用户确认后走 saveWorkflow。
- **边界（不做）**：完整 .pptx/Word/视频编辑仍在本地工作台范围外；本 spec 交付物为内容/文案/视觉素材类成果，PPT 仅作示例场景。多租户 SaaS、支付不在范围。
- **通用化**：所有能力平台级，不绑 PPT/visual 模板。

---

## 与现有约定的关系

- **不新建通用建议表**：复用 `report_action_item` 扩 actionType（避免第 6 套孤岛，与 `graph-proposal`/`permission-change-request`/`handover`/`template-health-finding`/`memory_candidate` 并存而不重叠）。
- **复用安全护栏**：pending_offline + retry + 死信 + 上班锁（`optimization-report-executor.ts`），不另造。
- **装配层零侵入优先**：用户偏好复用 personal scope 全量注入，不强制改 `context.ts` 层级；如需更显眼锚定，单推 `# 用户偏好` 段是可选增强。
- **记忆审核边界**：所有自动写入的经验/偏好记忆仍走 `memory_candidate` 审核 UI（用户可修正），不绕过。
