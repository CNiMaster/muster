# staging 集成审查发布技术方案

> 规范文件路径：`docs/superpowers/specs/2026-08-17-staging-integration-review.md`
> 状态：方案草案（2026-08-17 用户批准方向：「中间层合并到一起后审查修复通过后再合并回来」）
> 背景痛点：现状 publish-queue 对任务 worktree 做**文件级三方合并直接进项目 repo**，验收在合并之后——「逐个审太慢，合并后再审有风险」。

## 1. 核心设计

```
蜂群各蜂分支 ──┐
员工任务分支 ──┼──→ staging/<project> 集成分支 ──(验收员在 staging 检出的 worktree 审查+修复)──→ promote ──→ main
```

- **staging 分支 = 审核现场**（不绑任何个人的 worktree；分支中立，操作者可换班）。
- **集成责任**：蜂群汇总任务（第一负责人）负责把各蜂分支合入 staging——蜂群天然有汇总节点；普通任务的发布目标从 main 改为 staging。
- **验收形态**：验收员的验收任务 worktree 检出 staging HEAD——看到的是集成后的整体效果（不再是孤立的单任务产出）；修复冲突/问题直接改在 staging 上。
- **promote**：验收通过 → `staging → main` fast-forward（或用户在 main 有手改时一次 merge）；main 永远只进过审内容。
- **计划模式受益**：计划等待期间他人改动最多到 staging，main 纹丝不动。

## 2. 必须接受的三个代价（已与用户确认方向）

1. **派发基线改为 staging HEAD**：新任务 worktree 从 staging 切出——项目内后续任务会读到在审内容（项目内信任 staging）；否则 staging 与 main 持续漂移、审查期反复冲突。
2. **main 直改的合并**：用户手改 main 后 promote 需处理一次 merge（提示即可，不自动吞）。
3. **回滚语义**：从「回滚单任务」变为「回滚 staging 一段」（git revert 到 promote 点）。

## 3. 分期

| 期 | 范围 | 理由 |
|----|------|------|
| 一期 | **仅蜂群场景**：蜂分支 → 汇总任务合入 staging → 验收任务 staging worktree → promote | 蜂群天然有汇总节点、并行写冲突最集中、爆炸半径可控 |
| 二期 | 普通任务发布目标切 staging；文件级三方合并管线退役或仅作 staging 内部工具 | 待一期稳定 |

## 4. 改造面（一期）

- `publish-queue.ts`：发布目标参数化（main → staging 分支）；蜂群任务标记 staging 归属。
- `swarm.ts`：汇总任务职责增加「集成各蜂分支到 staging」（现汇总已读各蜂产出，改为 git merge 动作）。
- `acceptance-review.ts`：验收任务 worktree 检出 staging；通过动作触发 promote。
- `worktree/manager.ts`：createWorktree 支持指定基线分支（staging HEAD）。
- UI：项目页 staging 状态条（在审内容 N 项 / promote 按钮）；验收卡展示集成差异概要。
- 迁移：无表结构变更；分支命名 `muster/<project>/staging`。

## 5. 非目标

- 不做跨项目 staging（staging 每项目一条）。
- 不改变验收员自动派发机制（maybeTriggerAcceptanceReview 原样）。
- 二期前保留文件级合并代码路径（蜂群走新链、普通任务走旧链并行）。
