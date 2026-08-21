# 组织与名词（2026-08-19 定案）

状态：implemented

## 命名原则

不造概念，优先行业通用叫法；无行业标准词的概念由用户定名。旧词已废弃：特派员/特工/锦衣卫/蜂王/变身（→穿戴人设）；「分身」保留但仅指讨论室 mirror。

## 四固定岗（全部对用户可见）

| 岗位 | 英文 | 职责 |
|---|---|---|
| 负责人 | Lead | 用户单一接口，随时待命沟通；协调撤销/插话；定时/清单/随行讨论 |
| 养蜂人 | Beemaster | 放三种蜂：普通工蜂/同种专家蜂群/临时专家组；需要专家时从专家库取用或让人事专项设计 |
| 人事 | HR | 专家组织岗：维护专家库、创建专家（人造人）、按任务分派（用户自建且上岗中优先） |
| 验收员 | Reviewer | 质量验收 |
| 自动化管家 | Automation Steward | 平台自动化固定岗：对话创建自动化、组织编排（仅在自动化页可见）|

- 隐形岗：裁决法庭（Judge，role=`debate-judge`）——对抗辩论裁决。
- 执行层（非固定）：工蜂/专家/辩手（一次性或池复用）。

## 项目专家池与 specialist_pool

`specialist_pool` 表按（项目×人设）记账；`staff` 为跨项目可借的常驻专家。相关迁移：`20260819000900`。

## 记忆归属（四体系）

personal（用户画像，永远全量注入）/ workspace（工作台级，跟员工走，跨项目）/ project（锁项目）/ skill（人设方法论，按 persona_key 全局召回）。

## 机制词

随行讨论（aside）、检查点插入、派发三模式（interleave / sequential / preempt-replace）、清单（checklist）、定时任务（scheduled）、暂停/取消/回滚。

详见 `src/server/domain/specialist-pool.ts`、`src/server/domain/memory.ts`、`src/server/domain/system-agents.ts`。
