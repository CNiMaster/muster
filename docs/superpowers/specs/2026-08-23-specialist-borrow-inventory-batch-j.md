# 批次 J：专家群借调流 + 记忆盘点制（队列第 4 项）

状态：proposed（2026-08-23；来源=队列「专家群借调流+记忆盘点」，模型定案见 org-model 记忆 2026-08-22 补定调）

## 背景与现状缺口

已有（批次二 20260819000900）：specialist_pool 三级阶梯（需求计数→project 专家→use≥5 晋 staff）；materializeSwarm persona 蜂**本项目池**优先（acquireSpecialistForPersona）；人事 staffingPlan 兑现；只加不减（dismiss 手动）。

缺口（对照模型定案）：
1. **借调循环**：「专家群需专家时向人事借调：池匹配→无则 staffingPlan 生成入池→派遣，用完归还池——蜂群不私自造专家」。现状 acquireSpecialistForPersona 只查本项目池：本项目无计数行时直接放一次性临时蜂，**全局 staff 专家从不被跨项目借**（listStaffSpecialists 已存在但零消费方）；也无所谓"归还"的借调留痕。
2. **记忆盘点制**：「项目归档触发人事『待处置清单』（晋升入池/归档/删除用户拍板）+定期盘点长期未借调者；不自动删除」。现状归档只翻状态，专家池无人过问；staff 长期闲置无人盘点（孤儿专家担忧的既定解法未落地）。

## 模型

### J1 借调流（域+蜂群接线）

- 新表 `specialist_borrow`（迁移官方时间戳）：id/from_project_id/to_project_id/specialist_id/agent_id/task_id NULL/returned_at NULL/created_at——借调留痕（归还=记账非状态迁移，符合"专家默认不排队"定论）。
- 域 `borrowStaffSpecialist(db, {specialistId, toProjectId, taskId?})`：
  - 校验 tier='staff' 且 active；from=entry.projectId（≠to 才算借调）；同项目直用走既有 recordSpecialistUse。
  - INSERT borrow 行 + recordSpecialistUse（use_count++ 可能触发晋升已含）+ appendTaskEvent(taskId, 'specialist_borrowed')。
- 蜂群接线：acquireSpecialistForPersona 本项目池未命中（row 无 agent 或首次计数前）→ **先试全局 staff 借调**（persona 匹配优先→specialty 模糊匹配）→ 借调命中即返回 agentId（借来的专家执行，本项目计数行不动——需求计数只统计本项目真实需求，借调不虚增）；仍未命中→ 既有路径（计数/临时蜂）。用户模型「池匹配→无则 staffingPlan」中 staffingPlan 生成留给人事岗既有机制，蜂群侧不做生成（不私自造专家）。
- 手动借调入口：API `POST /api/projects/:id/specialists/:specialistId/borrow`（人事/负责人手动借全局专家进本项目，走同一域函数）。

### J2 记忆盘点（归档触发+定期盘点）

- 新表 `specialist_review`（同迁移）：id/kind('archive-disposition'|'idle-inventory')/project_id NULL/specialist_id/agent_id NULL/status('pending'|'resolved')/suggestion TEXT（晋升/归档/保留建议+依据）/resolution NULL/resolved_at NULL/created_at。
- **归档触发**：updateProject state→'archived'（软归档；硬删项目走 recordsDeleted 全删不触发）时，事务内为该项目全部 active pool 条目生成 archive-disposition 待处置行（suggestion=启发式：use_count≥晋升阈值→建议晋升 staff；use_count≤1→建议归档；否则建议保留）。
- **定期盘点**：coordinator 每 10 分钟 sweep 既有挂点旁加 `sweepIdleStaffSpecialists(db)`：staff 且 updated_at 距今 >30 天且无 pending 盘点行 → 生成 idle-inventory pending 行（同项目 30 天内只提一次——按 specialist+kind 去重）。
- **处置动作（用户拍板）**：API `POST /api/specialist-reviews/:id/resolve` {action: 'promote'|'archive'|'keep'|'dismiss'}——promote=maybePromoteToStaff 强制档；archive=dismissSpecialist（归档口径=保留行不派遣）；keep=仅关单；dismiss=下岗。批量端点 `POST /api/projects/:id/specialist-reviews/resolve-all` 按建议一键执行（每条仍留痕）。
- **清单消费**：人事岗上下文（system-agents HR prompt）注入 pending 数量+摘要（人事看得见才叫盘点制）；UI：项目设置页/能力中心加「专家盘点」区（pending 列表+逐条四动作）。

## 边界与不做

- 不做自动删除/自动降级（用户拍板制）；不做借调时限（专家并发定论：不排队不锁定）；不做跨项目记忆迁移（专家记忆跟 agent 走，借调共用同一 agent 记忆——模型既定）。
- dismissed 条目不参与借调匹配；borrow 只针对 staff（project 专家不跨项目——三级阶梯语义）。

## 测试

- 域：borrow 往返+非 staff 拒+同项目不算借调+use 记账；归档触发生成清单（三档建议）；idle sweep 去重+30 天阈值；resolve 四动作落库。
- 接线：acquireSpecialistForPersona staff 借调优先路径（本项目无池→全局 staff 命中→借调行+返回 agent）；本项目有池不借。
- API：borrow/resolve/resolve-all/清单列表 HTTP 级。
- e2e 或 smoke：人事盘点清单页可见（择一，按现有 e2e 容量）。

## 实施记录

（待实施）
