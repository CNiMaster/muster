# 任务链与组织可见性 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实“一个人就是一个公司”——用户只对负责人说话，后台 6 职能（负责人/人事/养蜂人/能力管理/验收员/裁决庭）隐形但事在右侧可见；任务链以双指向（下一个给谁可改默认给审核、可中转多人；验收后最终给谁不可改）显式流转必经验收→负责人→用户；三档是广深上限不绑模型组内自决；工具分默认套装与按需武器（常用自动带+新工具挑战）用户无须查看；人设按命中率补齐。

**Architecture:** 不动 `company_employee` 以外的组织表（B1-B4 仅在 `task/inputProtocol`、`tool/context`、`persona` 层）；`task.inputProtocol: finalReturnAgentId + chainHistory + intentAnchor/nonGoals/failurePolicy + breadthTier` 继承；`completeTask` 担任双指向与验收网关；`system-agents.ts` 新增 `capability-manager` 隐形岗并翻面 2-3 旗；右侧 3 卡以 `swarm_run/specialist_pool/task.acceptanceCriteria` 非人员源常驻。

**Tech Stack:** TypeScript / better-sqlite3 / Express / React / Vitest / Playwright

## Global Constraints

- 单入口：`workbench.firstAgentId` 唯一对外；中央职能隐形但可在讨论室被 @
- 上限非定额：`breadthTier light|standard|heavy` 只限天花板，组内自决，模型另维正交，简单任务形态不预设
- 不超范围：B1-B4 不碰组织表，B5 最后翻可见性；协作熵完整仪表与重型评分模型不做
- 每批一审一修，全部完成前不合 main，待高级智能审查

---

## File Map

| File | Role |
|------|------|
| `src/shared/types.ts` | `OutboundTaskRequest.reason/division` |
| `src/server/domain/task.ts` | 双指向继承、chainHistory、默认回写、验收网关 |
| `src/server/domain/acceptance-review.ts` | 按 finalReturn 转发 |
| `src/server/domain/setting.ts` | `breadthTier` 默认 standard |
| `src/server/domain/model-tier.ts` | breadthTier 不绑 ExecutorTier |
| `src/server/domain/swarm.ts` | breadthTier 联动 maxDepth/Width/Nodes |
| `src/server/domain/discussion.ts` | maxTurns 上限联动 |
| `src/server/task-engine/engine.ts` | `performCapabilityPrecheck` 后注入 toolChain |
| `src/server/domain/system-agents.ts` | 新增 `capability-manager` 隐形岗 |
| `src/server/domain/tool-registry.ts`, `capability-binding.ts`, `tool-recommendation.ts`, `executors/context.ts` | 分层装备定向注入 |
| `src/server/domain/persona-library.ts`, `reflection.ts` | 人设审计：新沉淀必须带 tools |
| `src/client/components/workbench/ProjectContextInspector.tsx` | 右侧 3 卡 |
| `src/server/domain/conversation.ts`, `src/server/domain/discussion.ts`, `src/client/components/ConversationPanel.tsx` | 群聊 6 人制白名单 |

---

## Task B1 — 链路两个指向 + 验收网关

- [ ] 扩展 `src/shared/types.ts:OutboundTaskRequest` 增加可选 `reason?: string; division?: string`
- [ ] `src/server/domain/task.ts:Task.inputProtocol` 约定 `finalReturnAgentId: string | null` + `chainHistory: Array<{taskId,agentId,title}>` + `intentAnchor/nonGoals/failurePolicy`（与 B3 复用类型）
- [ ] `createTask:443` 继承 `finalReturnAgentId`（有 parent 取 parent.finalReturn，否则取入参，无则回落 `project.firstAgentId ?? workbench.firstAgentId`），下游覆盖则 `task_event final_return_violation` 阻断并回落链头值；`chainHistory` 追加 `parent.chainHistory + {cur.id, assignee}`
- [ ] `completeTask:786` 将 `[子任务完成] summary.slice(0,600)` 写回直接请求者（`parentTaskId` 指向者 via `addTaskMessage`），不广播；`outboundTasks` 为空且未显式 next 时默认 `[验收员]` 兜底（查 `acceptance-officer`）；`waiting_dependency` 时 `addDependency`
- [ ] 验收网关：`acceptanceCriteria.length>0` 时先 `waiting_dependency` 挂 `[验收]`，`PASS` 按 `finalReturnAgentId` 转发、`FAIL` 回原产出者（上限 3 轮 `acceptance-review.ts:30`），无标准按 `nextRecipients` 直转；所有链最终 `验收→按finalReturn→负责人→用户`
- [ ] 单测 `tests/unit/task-chain.spec.ts`：C→Q 不回 B / finalReturn 不可改 / 默认→验收 / 多 next 带 reason/division；`npm run typecheck` + `npm test`

## Task B2 — 三档广深上限自决（不绑模型）

- [ ] `src/server/domain/setting.ts:52 SystemSettings` 新增 `breadthTier: 'light'|'standard'|'heavy'` 默认 `standard`；`src/server/domain/task.ts:90` 透传 `inputProtocol.breadthTier`
- [ ] 档位映射表（上限）：轻 1专家/1槽/蜂1/3/4/验收1轮/讨论6轮；中 2-3槽/2/5/12/2轮/12轮；重 4槽满配/3/8/30/3轮/20轮
- [ ] 7 处联动：`domain/swarm.ts:127 EXPERT_SWARM_LIMITS / 194 checkSwarmLimits`、`domain/task.ts:359 crew`、`domain/acceptance-review.ts:30 MAX_REWORK`、`domain/discussion.ts:248 maxTurns`、`task-engine/run-watchdog.ts` 超时；帽内自决，超帽才 `request-escalated:swarm.ts:138`
- [ ] 模型另维正交：`domain/model-tier.ts:18` 的 `ExecutorTier` 不随 `breadthTier` 强制，轻广深+高模型合法；负责人轻量启发式定档（读可拆分/并行信号）
- [ ] 单测 `tests/unit/breadth-tier.spec.ts`；`npm run typecheck`

## Task B3 — 能力管理隐形岗 + 分层装备 + 意图锚点

- [ ] `src/server/domain/system-agents.ts` 新增 `CAPABILITY_ROLE='capability-manager' / 能力管理 / Capability Manager` 隐形岗 `ensureCapabilityManager`（`isSystem:true` 默认 hidden，不设 visible:true）
- [ ] 时机：`src/server/task-engine/engine.ts:321 performCapabilityPrecheck` 后、`executors/context.ts:271` 定向注入前必经 `resolveToolChain`
- [ ] 分层装备：默认套装 `Read/Write/Edit/Bash/WebFetch` 每任务必带（`DEFAULT_REGISTRY vetted`）；专精武器按 `intentAnchor+personaId+capability_binding:147` 现配入 `resolvedToolChain` 定向注入 `context.ts:271`；常用阈值自动带（≥5次）+ 新工具挑战（每次扫 `tool_registry:122 + capability-quality:52`）
- [ ] 意图锚点：`intentAnchor{goal,constraints,acceptanceCriteria}+nonGoals[]+failurePolicy` 随 parent 继承并注入 `# 用户意图锚点`；验收员兼意图守护（`aligned/deviation/needConfirm`，PASS 但偏离转用户确认）
- [ ] 单测 `tests/unit/tool-steward.spec.ts`；e2e 不阻塞

## Task B4 — 人设审计与回写管线 + 极简日志

- [ ] `src/server/domain/persona-library.ts:118` 审计：`domain/reflection.ts:maybeSynthesizeExpertCandidates` 新沉淀必须带 `tools` 才准入库（否则 `expert_candidate dismissed`）；`personas/` 薄壳（15 个 516-560 字）按命中率补 P0 `tools` + 可执行 `技术交付物`
- [ ] 极简日志：`task.inputProtocol` 记 `breadthTier/toolChain/rework` 三字段（`task_event` 附带），供白日梦/反思后续用，不建完整协作熵仪表
- [ ] 单测 `tests/unit/persona-depth.spec.ts`；`npm test`

## Task B5 — 6岗隐形翻面 + 右侧3卡 + 群聊6人制

- [ ] `src/server/domain/system-agents.ts:73 ensureOne` 去 `visible:true`（`HR/DISPATCHER` 翻 `hidden=1`，裁决已隐形不动），补迁移 `UPDATE company_employee SET hidden=1 WHERE legacy_agent_id IN (SELECT id FROM agent_definition WHERE role IN ('swarm-dispatcher','hr','acceptance-officer'))`（若验收员需同步隐形）
- [ ] 右侧 `src/client/components/workbench/ProjectContextInspector.tsx:33` 新增 3 块非人员源常驻卡：当前任务专家（`specialist_pool:58 + personaId`）、蜂群拓扑（`swarm_run`，搬 `TaskDetailPage.tsx:214` 入右栏不受 `uiSimple` 隐藏）、验收进度（`task.acceptanceCriteria`）
- [ ] 群聊：讨论室参与者即中央 6 人（负责人/人事/养蜂人/能力管理/验收员/裁决庭），`src/server/domain/conversation.ts:299` @ 解析 + `src/server/domain/discussion.ts:574` 选择面 + `src/client/components/ConversationPanel.tsx:133` 白名单放行 6 岗；用户可 `@所有负责人` 扇出（`conversation.ts:317` 已支持多收件人）
- [ ] 更新 `CLAUDE.md:15` 四固定岗可见为“仅负责人可见，中央 6 职能隐形”；`docs/superpowers/specs/org-model.md` 同步
- [ ] 存量 `tests/integration/swarm.spec.ts:57 / system-agents-lazy.spec.ts:62` 随翻面更新；`npm run typecheck` + `npm test` + `npm run test:e2e`

## Verification

- 每批 `npm run typecheck` 0 错 + `npm test` 对应单测 + e2e 不回归
- 全量完成后 `npm run typecheck` + `npm test`（1380/1380）+ `npm run test:e2e`（24/24）
