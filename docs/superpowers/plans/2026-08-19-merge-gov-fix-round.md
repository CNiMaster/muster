# 合并治理大计划 · 修复轮实施计划（2026-08-19 review 后）

> 状态：implemented（修复 1-8 全部交付；验证门：tsc 0 错 + vitest 1320/1320 全绿）
>
> 背景：`feat/merge-governance-and-blueprint-crews` 分支由执行 agent 完成，review 判定**不可直接合并**。批次 A/B/D 达标保留；C/E 部分达标；F 方向做反；G 核心架构未做且引入蜂群旁路 bug；H 清理路径不安全；I 只做了只读查看器；J 做成了计划外功能。本计划逐项修复对齐原计划（`2026-08-19-merge-governance-and-blueprint-crews.md`，已随本分支入库）。一批一提交，每批过验证门（typecheck 0 错 + vitest 全绿，web-tools 3 例环境基线除外）。

## 修复 1（批次 F·服务器侧）：personal 记忆改回全局可见

- `memory.ts loadContextMemories` 两处查询分支：personal 条件从 `profile_id=? AND (project_id IS NULL OR project_id=?)` 改为 **`scope='personal'`（无 profile 过滤、无 project 过滤）**——偏好属于用户不属于员工（原计划定案 #8 / 批次 F.1）。
- `searchMemory` 同步恢复 personal 全局口径；`validateScope` 恢复"personal 不能绑定项目"。
- 测试反转：`personal-memory-scope.spec` 改为断言**乙的上下文包含甲沉淀的用户偏好**；personal 仍全量注入。
- 删除错误复盘 `docs/postmortems/2026-08-19-memory-scope-leak.md`（该文把定案需求写成漏洞）。

## 修复 2（批次 F·客户端）：蓝图卡改回「任务→最优蓝图」方向

- 删 `BlueprintSpecialistSidebar` 及其挂载（BlueprintCanvasPage）——它是反方向的"蓝图→人设 Top Matches"。
- `ProjectContextInspector.tsx` 新增「最优蓝图」卡：`useBlueprintMatches` top-N（label/评分/班底摘要），当前选中任务上下文命中时显示"已匹配最优蓝图 N 个"，无人设命中不显示。
- 删 API `GET /:blueprintId/top-personas`、`POST /:blueprintId/adopt-persona` 与域函数 `matchTopPersonasForBlueprint`（`addBlueprintStaffingSlot` 保留并入修复 7 扩展 role）。

## 修复 3（批次 E）：工程地基补全

- `package.json`：lefthook 进 devDependencies（MIT）+ `prepare` 脚本（lefthook install）；`THIRD_PARTY_NOTICES.md` 登记 lefthook（核对 vitest/playwright 缺则补）。
- `lefthook.yml` pre-push 降为 typecheck 必挂（受影响测试口径不稳，退化只 typecheck，CI 兜底全量——原计划 E1 明示的退化选项，比全量 vitest 每次 push 轻）。
- `ci.yml`：恢复独立 build job；push 触发恢复仅 main（PR 已覆盖分支）；e2e job 保留。
- postmortem 重写：目录改 `docs/postmortem/`，按原计划 E4 指定主题补写三篇（0001 发布白名单静默丢 a49ac6a / 0002 迁移 FK 规程 company-drop 终审 / 0003 蜂群记忆三连修 c99611d），模板四段：事实/根因/为什么自检没拦住/补强了什么；CLAUDE.md 加索引。
- CLAUDE.md 增 spec/plan 状态行惯例（proposed/implemented/rejected+一句原因，rejected 同样入库）。

## 修复 4（批次 G·核心）：任务级集成区全架构对齐

- **迁移重建**：删 `20260819001500_task_merge_mode.sql`（task.merge_mode/default_merge_mode 两列——计划外）；新迁移 `20260819001500_task_merge.sql` 建 `task_merge_record` 表（promote 审计：project_task/project/actor/summary/merged_files/commit_hash/status/created_at）。mergeMode 走 `project.settings_json.mergeMode: 'manual'|'auto'`（默认 manual，零列变更）。
- **task.ts**：删 Task.mergeMode 字段及 createTask 继承链。
- **manager.ts**：`taskStagingBranch = muster/<pid>/pt-<ptid>`；`ensureTaskStagingWorktree`（照抄 ensureStagingWorktree 幂等/重挂载，路径 `worktrees/pt-<ptid>`）；`taskStageStatus`（领先 commit 数）。
- **engine.ts**：
  - 删 manual 旁路分支（修复蜂群 staging 绕过 bug——原实现 `merge_mode==='manual'` 判断在 `isSwarmLinkedTask` 之前，项目 manual 时蜂群产物绕过集成审查直进主干）；
  - **所有** runtime task 发布 targetRootDir = 所在 project_task 的任务集成分支 worktree（`isSwarmLinkedTask` 语义改任务级：基线与发布目标同源）；蜂群蜂 worktree 基线从任务集成分支切出；
  - 完全访问（no-approval）任务发布范围为全量（定案 #9：worktree 全部变更，不走白名单，仍只进任务集成区）；
  - compaction_summary 写入按 thread.id（修镜像行双写）；
  - 删死代码 `compactThreadWithAutoSummary` 引用核对。
- **staging.ts**：
  - `promoteTaskStaging(db, projectId, projectTaskId, {actor, force?})`：diff 概要（`git diff --stat` + 关键文件 cap）→ `callLlm({tier:'premium'})` approve/concern + 合并摘要 → approve 走 `promoteStaging` 同款 merge 回主干（冲突返清单走修复 6）→ 摘要写 `task_merge_record` + 项目群播报；concern/LLM 失败本轮跳过不阻塞；
  - `listPendingMerges` 改为按 project_task 集成分支领先状态列出；
  - 看门狗 `sweepStaleStaging` 改造：扫任务级集成分支，条件=该 project_task 无在飞子任务+无在办[验收]任务+项目 mergeMode='auto'；孤儿永不碰；项目级 staging 保留只读兼容。
- **API**：`POST /api/projects/:id/project-tasks/:ptid/merge`（mergeMode=auto 直接执行；manual 返回 needsConfirm；有非终态子任务返回 pendingTasks 提醒不阻止）；`GET .../merge-status`（领先数+pending 状态）。
- **TaskTopBar.tsx**：「⏫ 合并」按钮——领先 commit 数轮询；点击调 merge；manual 弹确认（内嵌"本项目以后自动合并"=写 settings mergeMode auto 后重试）；未完成先弹提醒可继续。
- 删 `promoteTaskMerge`/`discardTaskMerge` 旧简化实现（发布不走白名单守护/无审查，均被新架构取代；丢弃安全版并入修复 5）。
- 测试：发布目标指向任务集成分支（普通+蜂群各一）、开关双路径、premium concern 拦截、未完成提醒、看门狗新条件、完全访问全量发布、蜂群项目 manual 不旁路。

## 修复 5（批次 H）：孤儿检测与丢弃安全

- 孤儿检测改 `git worktree list --porcelain` 全量 − `task_runtime` 登记集口径（删目录扫描假设 entry=taskId 的实现）。
- 丢弃/清理**强制内容检测**：丢弃前用 `listTaskBranchChanges` 同款检测未合并内容→返回摘要与三选语义（丢弃需显式 confirm 才执行）；`cleanOrphanWorktrees` 有未合并内容时默认只报告不清删，force 才清——堵死"静默丢改动"复活（原计划 H.2/H.4 明确防误删）。
- 看板 `ProjectMergesPage` 适配任务级集成分支数据源 + 孤儿区三选交互。
- 测试：孤儿识别（未登记 worktree）、丢弃防误删（有未合并内容拒绝静默删）、批量合并。

## 修复 6（批次 I）：冲突时间线加权裁决

- 意图时间线构造域（conflict-timeline.ts 扩展）：冲突发生时收集——冲突各方 project_task/runtime task **开始时间**（created_at，非完成时间）倒序 + `conversation_message` 用户本人消息倒序 top-N。
- 裁决接线：promote/发布冲突时派裁决法庭任务（role=debate-judge），输入=base/ours/theirs+时间线，输出 `debateVerdict` 扩展（语义判定+时间线 tilt 说明）；置信 ≥ `debateMinConfidence` → 自动选边（`git merge -X ours/theirs` 整边偏好重试）+播报理由；低于 → 升级用户（时间线展示"任务 X 是你 N 点开始的较新意图，但语义检查发现…"，经 postSystemMessage+事件）。
- 保留既有只读时间线聚合器作为展示层。
- 测试：时间线按开始时间排序、加权生效（高置信选边）、双低置信升级。

## 修复 7（批次 J）：蓝图专家组合按原计划

- `blueprint.ts` staffing 条目扩展 `{personaId, personaName?, role?}`（分工）；读取兼容旧数据（无 role=单人组合）。
- `task.ts` 蓝图命中**派整组**：组内每位优先 `findActiveSpecialistAgent`（池内专家）；命中多位于同 project_task 时各自为 runtime task（缺省并行）；缺员降级留痕（`blueprint_crew_slot_unfilled` 事件，原计划 J.2 明示降级选项），不绕人事岗造 agent。
- 删死代码 `applyBlueprintCrewStaffing`（无 API 消费方、绕过人事岗）与 `generateBlueprintCrewStaffing`、`GET crew-staffing` 端点。
- 穿戴文案改派遣（client「穿戴」→「派遣」）。
- 测试：组合命中派整组、旧单人蓝图兼容、缺员留痕降级。

## 修复 8（收尾）

- `context.ts` 环境段 binaryName 取 basename（不注绝对路径）。
- CLAUDE.md 回填本轮全部批次交付状态（验证门要求）。
- 全量验证：typecheck 0 错 + vitest 全绿 + 提交信息中文详述风格。

## 明确不做（沿原计划，另加）

- 不引 eslint/prettier；不做撤回 UI；不写项目级 staging 新路径；Claude 原生 compactSession 不对接。
- 不保留本分支引入的计划外概念：task.merge_mode 列、"编制推荐+一键入职"链路、memory"双层作用域"。
