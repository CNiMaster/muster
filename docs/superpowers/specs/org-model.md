# 组织与名词（2026-08-19 定案；B5 中央六岗制 2026-08-22 修订）

状态：implemented

## 命名原则

不造概念，优先行业通用叫法；无行业标准词的概念由用户定名。旧词已废弃：特派员/特工/锦衣卫/蜂王/变身（→穿戴人设）；「分身」保留但仅指讨论室 mirror。

## B5 中央六岗制（一个人就是一个公司，2026-08-22）

用户只对**负责人**说话；六中央职能全隐形（`hidden=1 + visible_in='central'`；口子 `GET /api/agents?visible_in=central` 供 @ 下拉/群聊候选；讨论双闸按 `CENTRAL_STAFF_ROLES` 白名单放行；中央岗+负责人互写 contactAllow 种子 `ensureCentralContactAllow`）。"人"隐形"事"可见：右侧三卡（专家池 `specialist_pool` / 蜂群拓扑 `swarm_run` / 验收进度 `acceptanceCriteria`）非人员源常驻。观测口径用 `listPersistentAgents`（可见+隐形中央岗+greyed 临时工，排除一次性工蜂/辩手）。

| 岗位 | 英文 | 职责 | 代码锚点 |
|---|---|---|---|
| 负责人 | Lead | 用户单一接口（**唯一可见入口**）；@负责人 关键词服务端扇出 | `project.firstAgentId`；conversation.ts `LEAD_MENTION_KEYWORDS` |
| 养蜂人 | Beemaster | 放三种蜂；蜂群三限随根任务 breadthTier 钳制 | `swarm-dispatcher`；swarm.ts `clampSwarmLimits`；蜂/替补继承档位 |
| 人事 | HR | 专家供给：建/派/复用、只加不减 | `hr`；`staffingPlan` done 契约 → engine 兑现 |
| 能力管理 | Capability Manager | 装备供给：热路径工具链决议（纯代码）+ 冷路径 [装备请示]（只建议不安装） | `capability-manager`；tool-chain.ts `resolveToolChain` |
| 验收员 | Reviewer | 质量验收+意图守护；返工轮次随档位 | `acceptance-officer`；PASS 按 finalReturnAgentId 回流播报 |
| 裁决法庭 | Judge | 对抗辩论裁决；群聊常驻可被 @ | `debate-judge` |
| 自动化管家 | Automation Steward | 平台自动化；仅自动化页可见 | `automation-steward`（visible_in='automation'）|

## 任务链双指向（B1）

`下一个给谁`可改（outboundTasks reason/division → 子任务 chainReason/chainDivision，默认下一跳=验收员）；`验收后最终给谁`（inputProtocol.finalReturnAgentId）链头不可改（下游覆盖 → final_return_violation 留痕不生效）；chainHistory 封顶 20（提示词压缩为 chainPath 标题路径）；[子任务完成] 回写直接请求者；意图契约 intentAnchor/nonGoals/failurePolicy 随链继承（postUserMessage 自动填 goal）。

## 三档广深（B2）

`breadthTier light|standard|heavy`（inputProtocol 或系统设置 `breadth_default_tier` 默认 standard）——只限天花板不绑模型：轻 1槽/蜂1·3·4/验收1轮/讨论6轮，中 3槽/2·5·12/2轮/12轮，重 4槽/3·8·30/3轮/20轮；蜂群取 min(全局,档位)，预算不钳；watchdog 超时不联动（属执行器档案域）。相关迁移：`20260822000100`。

- 执行层（非固定）：工蜂/专家/辩手（一次性或池复用）。

## 项目专家池与 specialist_pool

`specialist_pool` 表按（项目×人设）记账；`staff` 为跨项目可借的常驻专家。相关迁移：`20260819000900`。

## 记忆归属（四体系）

personal（用户画像，永远全量注入）/ workspace（工作台级，跟员工走，跨项目）/ project（锁项目）/ skill（人设方法论，按 persona_key 全局召回）。

## 机制词

随行讨论（aside）、检查点插入、派发三模式（interleave / sequential / preempt-replace）、清单（checklist）、定时任务（scheduled）、暂停/取消/回滚。

详见 `src/server/domain/specialist-pool.ts`、`src/server/domain/memory.ts`、`src/server/domain/system-agents.ts`。
