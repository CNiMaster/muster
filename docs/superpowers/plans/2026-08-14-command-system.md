# 指挥系统实施计划（checkbox 版）

> 对应设计：`docs/superpowers/specs/2026-08-14-command-system-design.md`
> 分支 `command-system`，每批独立提交，typecheck/测试/e2e 绿。合 main 由用户拍板。

## 批次 1 — 定时自动化补齐

- [ ] 迁移：`trigger` 加 schedule_kind/time_of_day/timezone；`dispatchDueScheduleTriggers` 支持 daily 下次执行计算
- [ ] 不叠跑护栏：上次任务仍 active → 跳过 + 推进 next_run_at + `trigger_skipped_overlap` 事件
- [ ] 公司级自动化：`GET/POST/PATCH/DELETE /api/companies/:id/automation` + 公司页「自动化」卡片
- [ ] 晨醒开关：`morningReportEnabled`（默认 true）+ SettingsPage 开关
- [ ] integration 测试（daily/时区/叠跑/公司级/晨醒）

## 批次 2 — 蜂群

### W0 系统隐形岗基建
- [ ] 迁移：`agent_definition.is_system` + `company_employee.hidden`
- [ ] `listAgents` 默认过滤（includeSystem 选项）；claimNextTask 保持 hidden 可领取
- [ ] `ensureSystemAgents`（调度中心 + 评审中心，coordinator tick 幂等）

### W1 记账与限额
- [ ] 迁移：`swarm_run` + `task.swarm_id/swarm_depth`
- [ ] `swarm.ts`：createSwarm / checkSwarmLimits（深度/宽度/总节点/预算）/ 计数器更新
- [ ] 设置键 swarmMaxDepth/MaxWidth/MaxNodes/BudgetUSD（六步链 + SettingsPage 段）
- [ ] 插入点 A（completeTask outbound 消费）+ 插入点 B（spawn_tasks handler）；isDispatchLoop 补进 spawn_tasks

### W2 临时工蜂
- [ ] `createWorkerBee`（createTempEmployment + hidden + primary 线程 + 结构化摘要 system prompt）
- [ ] 蜂任务终态 grey；swarm 收口/终止 `releaseSwarmBees` 全清

### W3 放蜂与收口
- [ ] `launch_swarm` 工具（仅调度中心）+ swarm_run 创建 + 蜂任务 + 调度中心 waiting_dependency
- [ ] 独立 synthesis 汇总任务（仿讨论 synthesis）+ 收口报告写回发起上下文

### W4 失败可观测与管控
- [ ] completeTask/failTask swarm 计数；失败率 ≥30%/分支全灭 → 去重「蜂群告警」给调度中心；蜂群内失败改道调度中心（不派 [兜底]）
- [ ] 失败 >50%/预算超限 → 自动熔断取消剩余蜂 + swarm_run=failed + 最终摘要
- [ ] SwarmTreeCard（TaskDetailPage 右栏）+ 蜂群徽章 + `POST /api/swarms/:id/abort` + `swarm.*` realtime
- [ ] 测试：限额四检/深度拦截/防环补齐/告警去重/熔断/abort/蜂清理/隐藏 + e2e 树视图

## 批次 3 — 结构化选项 + 对话可见

- [ ] `AgentRunResult.questionOptions`（types + result-schema）+ `task.question_options_json` 迁移 + completeTask 持久化
- [ ] answerClarification + clarify API 支持 optionId；ClarifyCard 选项按钮
- [ ] engine 回帖条件扩 waiting_input；MessageBubble 选项按钮 → clarify
- [ ] 测试：选项往返/optionId/对话可见可点选

## 批次 4 — 对抗评审庭

- [ ] 迁移：`debate` + `decision_record`
- [ ] `debate.ts`：startDebate（2-3 隐藏辩手 + stance + 干净上下文）→ R1 立论 → R2 互攻 →（按需 R3）→ 评审中心裁决
- [ ] 自动触发：waiting_input + ≥2 选项 → 拦截辩论；置信 ≥debateMinConfidence 自动采纳，<则升级用户（优劣表+选项按钮）；对话"帮我权衡"同管道
- [ ] 偏好记忆：决策记录 → enqueueReflection 蒸馏 → 辩论注入
- [ ] 可见性：对话 event 气泡 + `GET /api/companies/:id/debates` + 公司页卡片
- [ ] 测试：编排/干净上下文断言/置信分流/决策记录/偏好注入

## 批次 5 — review + 全量验证

- [ ] code-reviewer 全量审 + 修复带断言测试
- [ ] typecheck + npm test + e2e 全绿 + 报告
