# 蜂群分身专项：专家借调 → 分身穿戴（读记忆、不写记忆）

> 状态：已实施（2026-08-24，T1-T5 全部落地；gate：vitest 1636/1636 + tsc 0 错 + e2e 33/33）
> 前置对话结论：蜂群四种形态（普通蜂群/同种专家群/异种专家团/混编）+ 常驻专家进蜂群一律走「分身」——不借调真人（消排队）、不写回记忆（消乱碎）、带薄记忆快照上岗（读多写零）。

## 一、背景与定案

- **排队问题**：蜂群落地时命中常驻专家（specialist pool）直接返回真人 agentId（swarm.ts:742 `specialistHit?.agentId ?? createWorkerBee`），同 persona 多节点全部指给同一真人，按任务租约串行执行——「八个设计并行」退化成「一人排队做八份」，且常驻专家带跨任务记忆，失去「上下文隔离出不同见解」的分身价值。
- **用户定案**：蜂群不是借调——命中的常驻专家也生成**分身**（穿戴人设 + 记忆快照，只读不写）来工作。分身 = 独立 agent/线程/租约 → 物理上无排队；不写回常驻专家线程/档案 → 无并发污染。
- **快照形态（量与速度已核实）**：不现场跑 LLM 压缩，纯 DB 读常驻专家已有的薄摘要——`project_agent_thread.compaction_summary`（上次上下文治理产物，几百字级）+ 最近 5 个已完成任务的一句话摘要（compaction-summary.ts:33-48 的既有 SQL 模式）。硬预算 ≤800 字，纯读毫秒级。
- **用完即焚**：快照文本只落在蜂任务 `inputProtocol.memorySnapshot`（派发参数留痕，随任务归档走清理管道）；不进任何记忆库（常驻专家线程/档案/专家池都不写）；下次放群从常驻专家线程现读现拼（记忆更新则快照更新）。

## 二、现状代码事实（改动锚点）

| 事实 | 位置 |
|---|---|
| 蜂群落地循环：persona 蜂先查专家池，命中→真人，未命中→临时蜂 | `src/server/domain/swarm.ts:733-780` |
| 专家池命中/计数/晋升（命中常驻后只 use_count+1） | `src/server/domain/specialist-pool.ts:183-206` |
| 工蜂创建：匿名、共用档案、role='swarm-worker'、tempRecruit、跑完即焚 | `src/server/domain/swarm.ts:614-634` |
| persona 穿戴注入 system prompt 的执行侧消费点 | `src/server/executors/context.ts:145-170` |
| 养蜂人 swarmPlan 契约教学（提示词） | `src/server/executors/context.ts:447-455` |
| 薄摘要 SQL 模式（compaction_summary + 最近 5 任务摘要） | `src/server/domain/compaction-summary.ts:30-60` |
| 现有行为断言：第二次同专长由常驻专家本人执行 | `tests/integration/specialist-pool.spec.ts:105` |

## 三、实施步骤

### T1 快照生成器（纯函数，领域层）

新文件 `src/server/domain/specialist-snapshot.ts`：

```
buildSpecialistSnapshot(db, { projectId, agentId }) → { snapshot: string | null, sourceThreadId }
```

- 找常驻专家 primary thread（`project_agent_thread WHERE agent_id=? AND kind='primary'`），无 thread → null（分身退化为纯人设穿戴，行为等同现状临时蜂）。
- 聚合：`compaction_summary`（优先）+ 最近 5 个已完成任务 `title: summary`（`assignee_agent_id=? AND state='completed' AND summary IS NOT NULL`）。
- 硬预算：`SNAPSHOT_MAX_CHARS = 800`，超出按段截断（compaction_summary 保底、任务摘要次之）。
- 单测：空 thread / 只有摘要 / 截断 / 多来源拼接。

### T2 落地循环改为分身优先（核心翻转）

`swarm.ts:733-780` 循环内：

- 命中常驻专家（`specialistHit.agentId` 存在）时**不再用真人**：改 `createWorkerBee`（建分身）+ 蜂任务带 `personaId`（既有）+ `inputProtocol.memorySnapshot = buildSpecialistSnapshot(...)`。
- use_count 记账保留（分身同样证明专长需求，喂沉淀管道）；promote 分支只对无 agent 条目生效，不受影响。
- `spawned_child` 事件留痕补字段：`{ specialist: true, avatar: true, snapshotFrom: specialistHit.agentId }`（审计：这只蜂是常驻专家的分身、快照来源）。
- 快照缺失（常驻专家无 thread/无摘要）不阻断：分身照建，只穿人设。
- **未命中池的原路径不动**（记需求计数 + 临时蜂 + persona_miss 留痕，现状保持）。

### T3 执行侧消费快照

`context.ts` 人设穿戴段（145-170）后追加：

```
# 常驻专家记忆快照（只读）
你是该专家的分身。以下为派群时刻的只读记忆快照（工作手册），帮助你延续其经验与判断风格；
快照不更新、不回写——你的产出走汇总任务收口，不写入原专家的任何记忆。
【摘要】…【最近任务】…
```

- 读取条件：`task.inputProtocol.memorySnapshot` 存在（蜂任务派发时写入，重试/恢复确定性一致）。
- 放在人设段之后、任务正文之前——「先穿身份、再领手册、再干活」。

### T4 养蜂人四形态拆解指引

`context.ts:447-455` swarmPlan 契约教学追加：

- ①普通工蜂群（省 personaId）：机械并行、抓取粗筛。
- ②同种专家群（多个 worker 同一 personaId）：同专长、不同任务切片——上下文差异产生不同见解，适合方案探索/多角度评审。
- ③异种专家团（不同 personaId 各管一段）：专业互补的流水协作。
- ④混编（部分带 personaId 部分不带）：专家做关键节点、普通蜂做支撑。
- 指引注明：命中常驻专家也会以分身入群（不占用本人），放心按需同 persona 多蜂。

### T5 测试翻转与新增

- **翻转**：`specialist-pool.spec.ts:105`「第二次同专长由常驻专家执行（不建临时蜂）」→「第二次由常驻专家**分身**执行：蜂 assignee ≠ 常驻 agentId、personaId 穿戴、inputProtocol.memorySnapshot 含常驻摘要、spawned_child 带 avatar 留痕、use_count 仍 +1」。
- **新增**（integration）：同 persona 3 节点群 → 3 只分身并行（3 个不同 assignee，全部非常驻真人）——排队消除的直接断言。
- **新增**（unit T1）：快照生成器四例。
- e2e 不动（UI 四形态显示已交付，本专项纯后端）。

## 四、边界与不做

- **不写回**：分身产出不回写常驻专家线程/档案/专家池（读多写零）。群收口回写（读八写一）留后续专项，本轮不做。
- **不做快照缓存**：DB 读足够便宜，按需现读，不引入缓存失效复杂度。
- **不动非蜂群路径**：`borrowStaffSpecialist` 显式借调（specialist-borrow-review.spec 覆盖）是另一语义（真人带记忆上工），保持不变。
- **趋同阀门**：快照只带摘要+任务列表，不带对话原文；800 字硬上限。

## 五、验收清单

- [ ] 同 persona 多节点蜂群：每节点独立分身（不同 agentId/thread），无节点指向常驻真人
- [ ] 分身蜂任务带 personaId + memorySnapshot（≤800 字）；常驻专家无 thread 时优雅退化
- [ ] 常驻专家线程/档案在群全程零写入（前后摘要比对）
- [ ] use_count 记账照常；persona_miss 路径不回归
- [ ] specialist-pool 翻转用例 + 新增并行用例绿；全量 vitest / tsc -b --force / e2e 全绿
