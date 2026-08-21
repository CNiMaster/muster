# 合并并发收口 + 冲突事前可见性（2026-08-21）

> 状态：in-progress（批次 1-4）
> 工作制：worktree `.worktrees/merge-concur` + 分支 `feat/merge-concurrency-and-visibility`（并行进程在 main 树活跃改 UI，隔离验证门）；收口协议=检查无误→对齐计划→合并回 main→删 worktree。

## 提交与合并时序口径（preamble，回填 CLAUDE.md）

三问三答留档：

1. **合并入口有几条？** 两条：UI 手动（`api/projects.ts`）与看门狗自动（`staging.ts` sweepStaleTaskStaging，mergeMode='auto' 项目任务收口后自动 promote）。两路同走 `promoteTaskStaging`，同一门禁（premium 审查 + 确定性检查 + expectedHead TOCTOU）。
2. **worktree 提交和 main 提交一样吗？** git 层完全等价：同一仓库同一对象库，提交的真实性/持久性无差别，差别只是挂在哪个分支。「提交完再合并」才有稳定快照供审查（TOCTOU 卫兵锚定分支头）、合并才是单一原子操作、可 revert/bisect；「先合并再提交」会让审查对象与最终内容分离——正是门禁要防的形态。
3. **约定**：内容提交永远发生在分支上（任务 worktree 快照提交 → 集成分支发布提交）；main 只收两种提交——promote 的 merge commit 与 user edits 收口提交。任何内容不直接在 main 上提交。

三处提交位：任务 worktree（引擎快照）/ 任务集成分支 pt-（发布管线落盘）/ 主干（promote merge + user edits）。并发安全性：单进程单线程 + `promoteTaskStagingMerge` 全程同步无 await（合并序列原子不可交错），交错只发生在审查/检查的 await 点。

## 批次 1：promote in-flight 去重

- `staging.ts` 模块级 `Set<projectTaskId>`；`promoteTaskStaging` 进入即查，命中返回「该任务的合并正在进行中（手动/自动另一路已在发起），本轮跳过」；try/finally 全包删除。
- 一处覆盖全部入口（UI+看门狗+未来任务收口钩子），消除双发起时「Already up to date 也记成功」的重复 promoted 记录+播报。
- 测试：mock 审查延迟 + Promise.all 双发 → 一成功一跳过；收敛后第三次 → 暂无待合并。

## 批次 2：behind 徽章（分叉可见性）

- `manager.ts` `branchBehindCount(rootDir, branch)`（`rev-list --count branch..HEAD`）。
- `listPendingTaskMerges` 行加 `behindCommits`（按行所在仓库根，锚点/载体同参）；DTO/API 透传。
- ProjectMergesPage 行加 warn 徽章「主干已前进 N」（behind>0 时）——合并 A 后 B 的风险立刻可见。
- 测试：主干前进 1 提交 → behindCommits=1。

## 批次 3：合并预演（merge-tree 零副作用冲突预测）

- `manager.ts` `taskStagingMergePreview(rootDir, branch)`：`git merge-tree --write-tree --name-only HEAD branch`——exit 0 干净 / 1 冲突（解析文件清单，过滤首行 40-hex tree OID）/ 不支持或异常 → `supported:false`（老 git 兜底不炸）。
- 接线 `listPendingTaskMerges`：仅 behind>0 的行预演（behind=0 是 fast-forward 不可能冲突，零额外 spawn）；模块级缓存 key=`root:branch:ptHead:mainHead`（15s 轮询下 head 未动即命中，稳态开销=1 次 rev-parse/仓库）。
- 行加 `mergePreview?: { conflicted: boolean; conflicts: string[] }`；UI conflicted 时红徽章「⚠ 预计冲突 N 处」+ title 列前 3 文件。
- 测试：同区域双改→conflicted+文件命中；不重叠→干净；behind=0→无预演字段。

## 批次 4：口径回填 + 收口

- CLAUDE.md 合并治理区增「提交与合并时序」小节；本计划状态 implemented。

## 明确不做（防再提）

- 显式合并队列/分布式锁：单线程 + 同步合并序列已天然串行，加锁过度设计。

## 挂观察（写触发条件）

- 集成分支自动追平主干（main→pt 合并）：冲突化解提前到追平时点且审查 diff 更准，但引入追平冲突处置归属（谁在追平时点跑法庭）+ pt 历史噪音。触发条件：预演「预计冲突」高频出现且用户反复手动处理同类冲突 → 再立项。

## 验证门

每批 tsc 0 错 + 批次新测试 + 相关回归；worktree 内一批一提交中文详述；收口前全量 vitest + 本地 e2e + review 轮（盲区镜头清单）。
