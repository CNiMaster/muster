# 指挥系统（定时自动化 / 蜂群 / 对抗评审庭）设计

> 日期：2026-08-14 ｜ 分支：`command-system`
> 对应 PRD：`docs/PRD-agent-company-workbench.md`（Triggers and Discussions / Task Dispatch Protocol 之后新增「指挥系统」段）

## 背景：三件事是一套指挥系统

用户提出三个能力，调研后确认它们共享同一底座，是"指挥层"的三个件：

1. **定时自动化** = 什么时候做（触发层）。
2. **蜂群（swarm）** = 怎么放多个一次性子智能体并行做（编队层）。
3. **对抗评审庭（debate）** = 做之前怎么把两难决定做对（决策层）。

蜂群与对抗共用同一 substrate：**N 个干净上下文的临时智能体 + 并行任务 + 各自结构化交回 + 一个收口人汇总**。做一次底座，两处复用。

## 现状（file:line 证据，全部可复用）

### 定时：已有七成
- `trigger` 表 + `TriggerScheduler` 每秒扫描到期派发（`src/server/domain/triggers.ts:137` `dispatchDueScheduleTriggers`），重启续调度不重复（`0004_trigger_schedule_state.sql`）。
- 项目级 API/UI 完整：`POST /api/projects/:id/automation/schedules`（`src/server/api/projects.ts:184`）+ `ProjectPlansPage.tsx`（启停/删除/下次执行时间）。
- 缺口：只有 intervalMinutes 没有"每天 N 点"（`cron_expr` 列建了未用）；必须绑项目任务；无公司级；无"上次没跑完不叠跑"护栏；晨醒（每日优化报告 `coordinator.ts:483`）无条件跑无开关。

### 派活：fan-out/join 骨架已在
- 员工 A 给 B 派活：`outboundTasks`（全执行器，`task.ts:589-628` 事务内建子任务）+ `spawn_tasks` 工具（仅 API 执行器，单次 ≤10，join 策略 all/any/quorum/best-effort，`registry.ts:635-734`）。
- 收口三层：`waiting_dependency` 全等 + `spawnJoinPolicy`（any/quorum 提前收口取消其余，`task.ts:647-692`）+ `[子任务汇总]` 注入；讨论 parallel 模式已有独立 synthesis 汇总任务样板（`discussion.ts:413-441`）。
- 临时工基建现成：`createTempEmployment`（`temp-worker.ts:58`，is_temp_only=1、豁免 org lock、独立 primary 线程 `thread.ts:62`、dismiss 全清）。
- **缺口**：无深度上限（parentTaskId 链任意深）、outboundTasks 无广度上限；`isDispatchLoop` 防环只挂 outboundTasks 路径，`spawn_tasks` 没查环；同员工并行度=1（每员工每项目一个 primary 线程）；无整群视角的失败观测（失败传播 `task.ts:912-982` 是逐条 [兜底]，嵌套蜂失败会埋没）。

### 决策：单人决策、无结构化选项
- `waiting_input` 的 question 是纯文本（`shared/types.ts:84`、`result-schema.ts`），无 A/B/C 选项；对话窗只有 completed 才回帖（`engine.ts:987-1012`），agent 挂着追问用户毫无感知（现存缺口）。
- `agent.stance` 列已存在未消费（`agent.ts:35`，"辩论时锁定立场"——正好给辩手用）。
- 无任何红队/辩论机制；讨论室是合作式。

### 外部经验（调研结论，指导参数）
- 蜂群：业界普遍 1-2 层 fan-out；深度/扇出/预算上限是必配项不是可选项（防委派瀑布失控）。
- 辩论：2-3 轮封顶（3-5 轮后收益递减甚至下降：从众塌缩、跑题漂移）；辩手必须干净上下文（带原上下文会被锚定）；人数 2-3 个够。

## 关键决策（用户已拍板）

1. **调度员/评审官 = 系统隐形岗**：`agent_definition.is_system=1` + `company_employee.hidden=1`，公司上线时幂等自动创建（仿 `ensureProjectThreads`），花名册/能力路由/组织图全过滤，用户不可见不可控。「调度中心」管放蜂，「评审中心」管辩论裁决。
2. **工蜂 = 一次性虚拟智能体**：复用临时工基建 + hidden 标记；干净上下文、跑完即焚、不占编制、不写员工记忆。
3. **限额 = 系统设置项（上限非目标）**：swarmMaxDepth=3 / swarmMaxWidth=5（每节点）/ swarmMaxNodes=30（可调大）/ swarmBudgetUSD=5。分解多少由调度员按需决定，上限只做熔断。
4. **失败必须可观测可管控**（用户深究点）：单一记账咽喉 + 整群计数器 + 阈值去重告警给调度中心 + 失败过半自动熔断 + 树视图 + 一键停群。
5. **对抗无配额**：两难即自动辩（2-3 轮），辩不出（裁判置信 <0.6）才升级用户；目的是**减少用户决断次数**。用户每次选择沉淀为决策记录 → 蒸馏偏好记忆 → 注入后续辩论，越用越少问。
6. 晨醒加开关（默认开）；辩论裁判低置信阈值 debateMinConfidence=0.6（设置键）。

## 定时自动化设计（批次 1）

- `trigger` 表加 `schedule_kind('interval'|'daily')` + `time_of_day('HH:mm')` + `timezone`（默认服务器本地）；daily 的 next_run_at = 时区内下一个该时刻。
- **不叠跑**：派发前查该 trigger 上次派的任务仍 active（queued/claimed/running/waiting_*）→ 跳过创建、推进 next_run_at、留 `trigger_skipped_overlap` 事件。
- **公司级自动化**：`/api/companies/:id/automation`（镜像项目版），派发复用 postUserMessage 的公司 scope 机制（给第一负责人派任务）；UI 公司页「自动化」卡片。
- **晨醒开关**：`morningReportEnabled`（默认 true）门 `scheduleOptimizationReports`，SettingsPage 开关。

## 蜂群设计（批次 2）

### 结构：树管控制面，依赖管执行面
task 表天然两者都有（`parent_task_id` 树 + `task_dependency` 多对多）。深度/宽度/预算/熔断/可视化按树算账（`swarm_run` + `task.swarm_id/swarm_depth`），等待收口按依赖算（现状机制不动）。

### 生命周期
```
launch_swarm(goal, workerTasks[])     [仅调度中心可用]
  → swarm_run(active, 限额快照) + 逐蜂 createWorkerBee(depth=1) + 蜂任务
  → 调度中心任务 waiting_dependency 等全群
  → 蜂可经 outboundTasks 再下探（depth+1，达 max_depth 拦截，留 swarm_limit_blocked 事件）
  → 全完 → 独立 synthesis 汇总任务（各蜂结构化摘要 → 收口报告写回发起上下文）
  → releaseSwarmBees 清理全部蜂
```

### 失败观测与管控（W4 核心）
- **记账咽喉**：蜂任务终态统一过 completeTask/failTask → 更新 swarm_run 计数（nodes_total/done/failed）。
- **告警**：失败率 ≥30% 或任一父节点连同全部子节点死亡 → 给调度中心派**去重的**「蜂群告警」任务（仿 [兜底] dedupe），附失败摘要（分支/原因/重试次数）；蜂群内失败不派 [兜底] 给第一负责人（改道调度中心）。
- **熔断**：失败 >50% 或预算超限 → 自动 cancel 剩余蜂、swarm_run=failed、调度中心收最终摘要。
- **处置**：调度中心可补蜂/缩群（cancel_child_task）/终止；仅目标不可达才 waiting_input 升级用户。
- **视图**：TaskDetailPage 右栏 SwarmTreeCard（useTasks 按 rootTaskId 建树，状态着色，task.* realtime 自动刷新）+ 根任务蜂群徽章 + `POST /api/swarms/:id/abort` + `swarm.*` realtime 事件。

### 工蜂上下文纪律
蜂返回必须带结构化摘要（结论+证据+来源，长度上限）；中间层只传摘要不传全文；汇总由独立 synthesis 任务做（父任务上下文可能已满）。

## 对抗评审庭设计（批次 4，复用 W0/W2 + 批次 3 机制）

### 编排
```
触发：waiting_input 且带 ≥2 选项（自动拦截，不直接问用户）
  → startDebate：2-3 个隐藏临时辩手（干净上下文：只拿问题+选项+最小背景+近期偏好记忆；stance 注入立场）
  → R1 立论（并行蜂任务） → R2 互攻（各见他人 R1，专攻致命伤）
  →（仅裁判要求时 R3 补救）
  → 裁决任务给评审中心：{推荐项 / 各选项致命缺点 / 置信度 / 理由}
  → 置信 ≥0.6：自动采纳（answerClarification），继续执行，全程留档
  → 置信 <0.6：升级用户——精炼优劣表+差评清单+选项按钮（不是裸问题）
```

### 偏好记忆闭环
用户每次选择（+可选"为什么/以后偏好"备注）→ `decision_record` → enqueueReflection 蒸馏偏好 memory_entry → 后续辩论注入 → 升级次数随使用下降。对话里用户明说"帮我权衡"走同一管道。

## 不在本轮范围

- 通用 cron 表达式（只做 interval + 每日时刻两种）。
- 辩论配额/预算门（用户明确不需要——两难即辩）。
- token 级流式输出。
- 蜂群跨公司协作（蜂与调度中心同公司）。
- 智能体包（knowledge-work-plugins）导入员工系统（另议项，与本轮无关）。

## 数据模型（5 个迁移）

1. `trigger`：schedule_kind/time_of_day/timezone。
2. `agent_definition.is_system` + `company_employee.hidden`。
3. `swarm_run` + `task.swarm_id/swarm_depth`。
4. `task.question_options_json`。
5. `debate` + `decision_record`。

## 系统设置新键

`morningReportEnabled`(true) / `swarmMaxDepth`(3) / `swarmMaxWidth`(5) / `swarmMaxNodes`(30) / `swarmBudgetUSD`(5) / `debateMinConfidence`(0.6)。走 autonomousReflection* 同款六步链（setting.ts → api/settings.ts → queries.ts → SettingsPage）。
