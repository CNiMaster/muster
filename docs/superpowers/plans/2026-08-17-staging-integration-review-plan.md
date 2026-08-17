# 实施计划：staging 集成审查一期（蜂群）+ 计划同意执行闭环

> 规范文件路径：`docs/superpowers/plans/2026-08-17-staging-integration-review-plan.md`
> 状态：已批准（2026-08-17），在 worktree `feat/staging-executor-pool` 分批实施
> 上游 spec：`docs/superpowers/specs/2026-08-17-staging-integration-review.md`

## 核心策略（探查后修正）

不改发布模型——保留文件级三方合并管线（锁/冲突裁决/publish_record 原样），仅把蜂群系任务的**发布目标目录**从项目根换成持久 staging worktree 检出目录；验收/返工 worktree 基线改为 staging 头；promote = staging 分支 merge 回主干。避免重写 publish-queue 的分支级合并。

关键事实（探查记录）：publish 为同步文件级三方合并（publish-queue.ts:180-331）直写项目 repo 工作区单分支；createWorktree 基线=HEAD（manager.ts:57-73）；蜂/汇总任务各走正常引擎链路各自 publish（engine.ts:911-914）；验收/返工 worktree 基线=主干 HEAD（staging 下必须改，否则读不到被验产物）；计划文本落点=task.summary（无 artifact）。

## 批次

### A0 计划落盘（本文件 + 执行器池计划）
### A1 staging 工作区基建（src/server/worktree/manager.ts）
- `ensureStagingWorktree(rootDir, projectId)`：路径 `~/.muster/worktrees/staging-<projectId>`、分支 `muster/<projectId>/staging`（无则从 HEAD 建）；幂等；返回 `{path, branch}`。
- `createWorktree` 增可选 `baseRef`（默认 HEAD）。
- `promoteStaging(rootDir, projectId)`：staging 侧 commitAll 兜底 → 项目根 commitAll('muster: user edits') → `git merge --no-edit` staging 分支；冲突 `git merge --abort` 返回冲突清单。
- `stageStatus(rootDir, projectId)`：staging 领先主干提交数（供 UI）。
- 单测：建/幂等/基线切出/promote 快进与冲突两路。

### A2 发布目标参数化（publish-queue.ts + engine.ts）
- `PublishQueue.publish(req)` 增 `targetRootDir`（缺省 projectRootDir）；`doPublishInner` 内全部改用该值。
- engine.ts:911-914：`task.swarmId != null` → targetRootDir = ensureStagingWorktree(...)。
- 冲突裁决链路零改动（现场在 staging）。
- 集成测试：双蜂发布到 staging、冲突进裁决、裁决后落定。

### A3 蜂群接线与 promote 触发（swarm.ts / acceptance-review.ts / engine.ts / api/tasks.ts）
- 蜂/汇总任务 worktree 基线 = staging 头；验收/返工任务若源任务发到 staging，基线同取 staging 头。
- promote 三触发：①验收 PASS（源任务属蜂群系）自动 promote；②closeSwarm 收口且无待验收自动 promote；③手动 `POST /api/tasks/:id/swarm/promote`。
- 事件：`publish.staging-promoted` / `publish.staging-promote-conflict`。
- 集成测试：蜂群全链（蜂→staging→汇总→验收 PASS→promote→主干可见）、无验收蜂群收口自动 promote。

### A4 项目页 staging 状态条（ProjectPage.tsx + queries.ts）
- `GET /api/projects/:id/staging-status`；状态条「在审 N 项 · staging 领先 M 提交」+ 手动 promote 按钮。

### A5 计划同意执行闭环（tasks.ts / queries.ts / ConversationPanel / ProjectTaskWorkspace）
- `POST /api/tasks/:id/approve-plan`：校验 mode==='plan' 且 completed；取 task.summary 建执行任务（trigger='plan_execution'，正常读写模式）；postSystemMessage 留痕。
- 前端按钮两处：ConversationPanel 计划消息卡、ProjectTaskWorkspace 任务条。
- 单测：建执行任务+模式剥离；非 plan 任务 400。

### A6 全量验证 + CLAUDE.md
tsc 强制全量 / vitest 全量 / e2e 18 / smoke 77；新增 staging 集成测试；CLAUDE.md 增补 staging 一期章节。

## 验收标准
- 蜂群任务产出不再直进主干；验收员能在集成现场审查；promote 后主干出现整合结果；冲突场景走既有裁决链路。
- 计划任务 completed 后可一键「同意并执行」，执行任务正常读写。
