# 合并治理 + 蓝图专家组合 + 上下文经济学与工程地基 · 交接实施计划（2026-08-19 定案，同日扩编）

> 状态：已批准待执行
>
> 交接说明：本文档为完整实施计划，两段合流——「合并治理与蓝图班组」（批次 F-J，已与用户在会话中逐条定案）+「上下文经济学与工程地基」（批次 A-E，经 WorkBuddy 运行时流程 / DSH SDLC 两张外部流程图与 muster 现状对照分析定案）。不再有开放问题。执行者按批次 A→J 顺序交付，每批过验证门后一批一提交。验收人按文末「验收清单」逐条验收。
>
> 外部参照原则（用户定调）：缺口识别参考了外部 harness，但**每项收法都是 muster 既有机制的延伸，不引入外来概念**——环境信息=「模型无状态、记忆由产品注入」哲学的补全；token 窗口=激活自留未接通的参数；压缩摘要=复用 llm-call 分档用脑；蜂群收口契约=done/VERDICT 契约校验同款；门禁重量=DSH「治理 9/10 可持续 3/10」教训的反面教材（只要能拦住"agent 自检通过但机制有洞"的那一层）；spec 状态行与 postmortem=task_event/decision_record 的 append-only 留痕文化延伸到设计决策层。

## 背景与现状锚点（代码事实，勿凭记忆重查）

**合并治理与蓝图班组（批次 F-J）：**

- 任务执行：每个 runtime task 独立 git worktree（分支 `muster/<projectId>/<taskId>`，`src/server/worktree/manager.ts`）。
- 发布：`publish-queue.ts` 文件级三方合并（git merge-file）+ 产物白名单；**当前普通任务直接发布进 main**，蜂群系任务发布进**项目级 staging**（`ensureStagingWorktree`，分支 `muster/<pid>/staging`）。
- promote 现状：蜂群收口（无验收标准）或验收 PASS 自动 promote（`swarm.ts maybePromoteSwarmStaging` / `acceptance-review.ts`）；10 分钟看门狗 `staging.ts sweepStaleStaging`（coordinator tick 驱动，`staging_watchdog` 表去重）。
- 项目任务（project_task）= 用户心中的"任务/计划"；runtime task 是中间过程。任务级集成区**尚不存在**（staging 是项目级）。
- 专家池：`specialist-pool.ts`（项目×人设，第 2 次需求落常驻专家、use≥5 晋 staff）；人事岗 staffingPlan 契约已交付。
- 蓝图 staffing 现状：`blueprint.ts` staffing 数组，第 1 槽人设穿戴给执行者（`task.ts` 蓝图匹配块，优先池专家），2-4 槽文字注入。
- 记忆四维度：personal/workspace/project/skill（`memory.ts loadContextMemories`；personal 当前按 profile_id 过滤——**用户偏好被隔离在单个员工档案下，是缺口**）。
- premium 模型调用：`llm-call.ts callLlm({tier:'premium'})` 现成。
- 时间线数据源：`conversation_message`（用户消息）、task 行（created_at=开始时间）、`task_event`。

**上下文经济学与工程地基（批次 A-E）：**

- 上下文装配 `executors/context.ts assembleContext`：注入了身份/人设/记忆/素材/归档/契约等十几段，但**无任何「运行环境」段**——全库搜不到当前日期/时间/时区/OS 进 prompt（模型连今天几号都不知道，只能按训练截止日期编造）；`tz.ts` 已有无依赖时区换算能力（trigger 在用）。
- 会话判定 `domain/session-manager.ts`：`recordRun` 已收真实 usage（engine 传 inputTokens/outputTokens）但**未传 contextWindow**——`tokenRatio = contextWindow>0 ? tokens/window : 0` 恒为 0，**≥0.75 compact / ≥0.9 rotate 的窗口比例判定从未生效**，目前只靠次数（soft 30/hard 45）与字节（2MB/3MB）阈值。这是 dsh-gap-matrix 排第一的 spill（上下文溢写）缺口的具体断点。
- CLI 压缩：`thread.ts clearSessionForCompaction` 的 compaction_summary 为固定文案或用户手输（`api/projects.ts` 手动压缩入口），**无 LLM 自动摘要**；`compactSession` 仅 Codex 实现（`codex-cli-adapter.ts`），Claude 走降级 rotate=裸丢上下文。消费侧 `context.ts` 注入 compaction_summary 的通道现成，零改动。
- 蜂群收口：养蜂人职责要求报告含「结论/分歧点/关键证据/遗留风险」（`system-agents.ts`），蜂端有 ≤500 字格式契约（`swarm.ts`），但汇总任务 done 输出只过通用 agentRunResultSchema——**收口报告结构无校验**，"分歧点"纯靠提示词自觉。
- 仓库工程：**无任何 git hooks**（无 .husky/lefthook）、无 lint/format 配置，门禁全靠 CLAUDE.md 约定+agent 自律；CI 仅单 workflow `ci.yml`（typecheck+test+build），**22 例 e2e 本地绿但不进 CI**、无覆盖率；`docs/superpowers/specs` 30 篇无状态字段（rejected 的设计不留档，只活在"非目标"段和 commit message）；无 postmortem 目录。最近三次大修（发布白名单 a49ac6a / 迁移 FK 规程 company-drop 终审 / 蜂群记忆 c99611d）全是"agent 自检通过但机制有洞"的类型。
- 迁移编号现状：最高 `20260819001300`（project_task_checklist），**新迁移从 `20260819001400` 顺延**。

## 定案速览（不再变更）

**合并治理与蓝图班组（1-9，原定案）：**

1. **任务=合并确认单位**：每个项目任务一个任务级集成分支；其下所有 runtime task 产物自动合并进它（不碰 main）；任务成果 promote 回 main 才是门禁。
2. **项目级合并开关**：`project.settings_json.mergeMode: 'manual'|'auto'`，默认 manual。manual 合并弹确认（框内嵌"本项目以后自动合并"）；auto 全自动。系统派生任务（蜂群/定时/清单/人事）的**中间合并**始终自动（它们只进任务集成区）。
3. **AI 负责合并**：promote 前 premium review（diff 概要→approve/concern；concern 或 LLM 失败→本轮跳过+播报，不阻塞下轮）；review 顺产出**合并摘要**（含哪些任务哪些成果+文件变化概览，写记录+项目群播报）。git 机械操作由系统执行，语义决策在 AI。
4. **冲突裁决**：语义对抗判定为主（裁决法庭，判"哪个版本不破坏其他功能"）+ **意图时间线加权**（冲突各方任务/计划的**开始时间**倒序——不是完成时间；晚开始=更新用户意图，仅加权不独裁）；置信≥阈值自动选边重发布，低于→升级用户（带时间线展示）。
5. **合并按钮**：TaskTopBar「⏫ 合并」任何时刻可点（中途合并合法：用户不做了/换人接手）；任务未完成时仅弹提醒"任务尚未完成，是否现在合并"，可继续；**不做撤回按钮**（revert 能力留底层，撤回影响评估属后续 AI 流程，本计划不含）。
6. **孤儿/用户自建 worktree**：不在 `task_runtime` 登记的 worktree（`git worktree list` 全量 − 登记集）。**永不自动合并、看门狗永不碰**；进待合并看板标注；支持单合并/多选/批量/丢弃（丢弃前检测未合并内容，弹摘要三选：丢弃/合并/取消，防误删）。
7. **蓝图专家组合**：staffing 从单人人设升级为组合（人设+分工）；命中派整组（组内每位优先 `findActiveSpecialistAgent` 池内专家，缺员走人事 staffingPlan 链）；旧单人槽自动包装为单人组合（兼容）；右侧分栏显示"已匹配最优蓝图 N 个"（`matchBlueprints` top-N 现成）。穿戴语义收敛为"派遣"。
8. **personal 全局可见**：用户偏好召回去掉 profile_id 过滤（偏好属于用户不属于员工）。
9. 模式三层（已有映射，仅确认不新建）：任务默认计划模式（只读，调查产物写平台工作区 artifacts/materials 不进用户库——现状即如此）；批准→变更前确认（≈ask-by-rule）；完全访问（≈no-approval，worktree 内**全量自动发布**进任务集成区，不走白名单——消除"计划合并了临时文件没合并"漏洞）。执行者只需保证：完全访问任务的发布范围为全量（发布白名单放宽），管线不变。

**上下文经济学与工程地基（10-15，本日定案）：**

10. **环境信息段**：每次上下文装配注入「# 运行环境」——当前日期星期时间、时区名、OS/架构、执行器类型（cli/api+binary）。
11. **contextWindow 接通**：执行器档案可选 `context_window_tokens`，解析链=档案 > 默认 128k；`recordRun` 传入激活 0.75/0.9 token 比例判定；未配置时行为与现状完全一致（零回归）。不造全局 token 计数器，不引入新的预算概念。
12. **压缩自动摘要（用户拍板）**：economy 档 LLM 自动生成 compaction_summary，覆盖三路径（阈值触发/手动压缩未输摘要/rotate 降级）；LLM 失败降级固定文案绝不阻塞压缩；Codex 原生 compact 不动；Claude 从"裸 rotate 丢上下文"升级为"摘要+rotate"。
13. **蜂群收口结构契约**：汇总任务 summary 必含「结论/分歧/风险」三段标题（无分歧须显式写"无分歧"）；缺失→前缀标注「[收口契约不完整：缺X段]」+事件留痕，**不重派不阻塞**（格式未守≠内容无效，重派成本高）；契约教学段同步明示。
14. **仓库门禁最小集**：lefthook **仅挂 pre-push**（typecheck 必挂+受影响测试尽力）；CI 增 e2e job；**不引 eslint/prettier**（190+ 存量文件=海量噪音，另案探讨）；lefthook 登记 THIRD_PARTY_NOTICES。
15. **文档留痕惯例**：spec/plan 头部加状态行（proposed/implemented/**rejected**+一句话原因，被拒绝的设计同样入库）；`docs/postmortem/NNNN-标题.md` 只记「事实/根因/为什么自检没拦住/补强了什么」，补写前三篇。不建 DSH 式 manifest（git 本身就是 append-only）。

## 执行顺序与批次总览

```
A 运行环境信息（小时级）→ B contextWindow 接通（小时级）→ C 压缩自动摘要（天级）
→ D 蜂群收口契约（小时级）→ E 工程地基（门禁+CI+文档，半天）
→ F personal全局+蓝图右侧栏（原批次A）→ G 任务级集成区+合并开关+合并按钮（原批次B，核心）
→ H 待合并看板（原批次C）→ I 冲突时间线裁决（原批次D）→ J 蓝图专家组合（原批次E）
```

排序理由：A-D 小而独立、动的是 context.ts/engine.ts 的装配与会话判定区，先行落地让核心批次 G（重改 engine 发布链）建立在已稳定的上下文经济学之上；E 的 pre-push 门禁立在 F-J 之前，后续每批交付即过门（自吃狗粮）；一个文件一份计划串行执行，无并行合并冲突。

## 批次 A（小）：运行环境信息注入

1. `context.ts assembleContext`：身份段之后新增「# 运行环境」——当前本地日期+星期+HH:mm、时区名（`Intl.DateTimeFormat().resolvedOptions().timeZone`，换算口径复用 `tz.ts`）、`process.platform + os.arch()`（如 darwin/arm64）、执行器类型与 binary（ctx 已有 executorKind/agentExecutor）。只放平台事实，不含绝对路径（worktree 路径已有专段不重复）。
2. 测试：assembleContext 产物含日期/时区/平台断言（现有 context 相关 spec 扩展）；现有注入段不回归。

## 批次 B（小）：contextWindow 接通，激活 token 比例判定

1. 迁移 `20260819001400`：`executor_profile` 增可选列 `context_window_tokens`（INTEGER 可空）。
2. 窗口解析链 `resolveContextWindow(profile)`：档案列 > 默认 `128_000`。ExecutorCenter 档案表单加可选输入（UI 可后置打磨，域层/API 先行）。
3. `engine.ts` recordRun 调用处（现 :851 一带，可取 ctx.agentExecutor 档案）增传 `contextWindow`；`session-manager.ts` 零改动（判定已支持）。
4. 行为说明：usage 缺失（部分 CLI 路径 `_usage` 为空）时 tokens=0，与现状一致零回归；配置了小窗口的项目会更早触发 compact/rotate——这是预期的 spill 修复，不是回归。
5. 测试：伪 usage 大 token → decision=compact（≥0.75）/rotate（≥0.9）；未配置窗口判定与现状一致；解析链回退序。

## 批次 C：压缩自动摘要（economy 档）

1. 新 `domain/compaction-summary.ts`：`generateCompactionSummary(db, threadId)`——输入=该 thread 最近 handoff+近 N 条任务 summary+recentDiscussion，调 `callLlm({tier:'economy'})` 产 ≤400 字中文摘要；**失败/超时降级现有固定文案**，绝不阻塞压缩链路。
2. 接入三路径：① `thread.ts clearSessionForCompaction`（阈值触发）固定文案→LLM 摘要；② `api/projects.ts` 手动压缩未输 summary 时自动生成；③ engine rotate 降级路径（compactSession 不可用/失败时）rotate 前同样落摘要——Claude 型从"裸丢"变"摘要延续"。Codex 原生 compact 路径不动。
3. 消费侧零改动：`context.ts` 注入 compaction_summary 的通道现成。
4. 测试：FakeLlm 手法（照抄 expert-synthesis.spec 的 MUSTER_HOME 动态隔离+假 LLM 模式）；三路径落库断言；LLM 失败降级不阻塞；Codex compact 不回归。

## 批次 D（小）：蜂群收口结构契约

1. `swarm.ts`：汇总任务（[蜂群汇总]）完成时校验 summary 含「结论」「分歧」「风险」三段标题行（宽松包含匹配；无分歧须显式"无分歧"字样）。
2. 缺失处理：summary 前缀标注「[收口契约不完整：缺X段]」+ `task_event synthesis_contract_violation` 留痕；不重派不阻塞。
3. `context.ts` 蜂群契约段对汇总任务明示三段必需标题（契约教学先行、确定性校验兜底——与 done zod / 验收员 VERDICT 同款模式）。
4. 测试：含三段/缺段/显式无分歧三例。

## 批次 E：仓库工程地基（门禁 + CI + 文档留痕）

1. lefthook（MIT，登记 `THIRD_PARTY_NOTICES.md`）：devDependency + `lefthook.yml` **仅 pre-push**——`npm run typecheck` 必挂；受影响测试（`vitest --changed` 口径，不稳则退化只 typecheck，CI 兜底）；`package.json` 加 `prepare` 脚本。**不挂 pre-commit、不引 eslint/prettier**——重量依据：DSH 三级门禁 15 workflow 换来治理 9/10 可持续 3/10；本仓近三洞全是"agent 自检通过但机制有洞"，pre-push 的 typecheck+CI 全量恰好在拦截层。
2. CI：`ci.yml` 增 e2e job（`npm run test:e2e` + Playwright 装 chromium，超时 15min，单 node 版本）；若出现纯环境失败（无头浏览器依赖类）允许记 known issue 过渡一批（提交信息注明），下批修复。核对 vitest/playwright/lefthook 的 THIRD_PARTY_NOTICES 登记齐全，缺则补。
3. spec/plan 状态行惯例：CLAUDE.md 增一小段——新文档头部加 `状态：proposed|implemented|rejected`（rejected 附一句原因，**同样入库**，替代方案为何不选留在正文）；存量 30 篇不回填；本计划带头（见顶部状态行）。
4. `docs/postmortem/` 建目录补写前三篇：`0001-publish-whitelist-silent-loss.md`（a49ac6a：白名单外改动随分支删除静默丢）、`0002-migration-fk-procedure.md`（company-drop 终审：FK=OFF 官方表重建规程被空库测试掩盖）、`0003-swarm-memory-craft-loss.md`（c99611d：工蜂记忆白写+专家 CRAFT 真丢）。模板四段：事实/根因/为什么自检没拦住/补强了什么。CLAUDE.md 加索引一行。
5. 验收：本地 push 可触发 hook；CI e2e job 上线且绿（或注明 known issue）；三篇 postmortem 成文；新文档带头有状态行。

## 批次 F（原批次 A，小）：personal 全局 + 蓝图匹配右侧栏

1. `src/server/domain/memory.ts loadContextMemories`：personal scope 的召回去掉 profile_id 过滤（两处查询分支；排序/上限不变）。注意 personal 豁免优势分投票（recordInjected 已豁免）保持。
2. `src/client/components/workbench/ProjectContextInspector.tsx`：新增「最优蓝图」卡——`useBlueprintMatches`（现有 hook）top-N（label/评分/班底摘要），当前选中任务上下文命中时显示"已匹配最优蓝图 N 个"。
3. 测试：员工乙能读到员工甲沉淀的用户偏好（context-memory.spec 扩展）；右侧栏组件渲染（project-workbench 测试模式）。

## 批次 G（原批次 B，核心）：任务级集成区 + 项目合并开关 + 智能合并按钮

1. `manager.ts`：`taskStagingBranch(rootDir, projectId, projectTaskId)` = `muster/<pid>/pt-<ptid>`；`ensureTaskStagingWorktree`（照抄 ensureStagingWorktree 的幂等/重挂载模式，路径 `worktrees/pt-<ptid>`）。项目级 staging 保留只读兼容（存量数据迁移期）。
2. `engine.ts` + `staging.ts`：**所有** runtime task 发布 targetRootDir = 其 project_task 的任务集成分支 worktree（`isSwarmLinkedTask` 语义改为任务级；蜂群蜂基线也从所在任务集成分支切出）。发布冲突/裁决谓词同步。
3. `project.ts`：settings_json.mergeMode 读写 + API（PATCH 项目设置已有通道则复用）。
4. 新域 `promoteTaskStaging(db, projectId, projectTaskId, {actor, force?})`：
   a. 取任务集成分支领先 diff 概要（diff --stat + 关键文件 diff，cap）；
   b. `callLlm({tier:'premium'})` → approve/concern + 合并摘要；concern 或 LLM 失败→跳过+播报（不阻塞下轮）；
   c. approve→`promoteStaging` 同款 git merge 回 main（冲突走批次 I，判不了升级用户）；
   d. 摘要写 publish_record（复用或新表 merge_record）+ 项目群播报。
5. `TaskTopBar.tsx`「⏫ 合并」：显示该任务集成分支领先 commit 数（轮询）；点击 `POST /api/projects/:id/project-tasks/:ptid/merge`——mergeMode=auto 直接执行；manual 返回待确认→前端弹窗（内嵌"本项目以后自动合并"=写 mergeMode:'auto'）；该 project_task 有非终态 runtime task 时先弹"任务尚未完成，是否现在合并"提醒，可继续。
6. 看门狗 `sweepStaleStaging` 改造：扫**任务级**集成分支；条件=该 project_task 无在飞子任务+无在办 [验收] 任务+项目 mergeMode='auto'；孤儿（无登记）永不碰。
7. 集成测试：发布目标指向任务集成分支（普通+蜂群任务各一）、开关 manual/auto 双路径、premium concern 拦截、未完成提醒语义（API 层）、看门狗新条件+auto 门槛。

## 批次 H（原批次 C）：待合并看板

1. 扫描域 `merge-board.ts`：(a) 各 project_task 集成分支领先状态（系统侧）(b) `git worktree list` 全量 − `task_runtime` 登记 = 用户自建/孤儿（标注来源）。
2. 页面 `/projects/:id/merges`（项目工具入口加入口链接）：系统待合并列表 + 孤儿区；操作=单合并（走批次 G promote 流程）/多选合并/批量合并全部/丢弃（丢弃前用 `listTaskBranchChanges` 同款检测未合并内容→弹摘要三选：丢弃/合并/取消）。
3. hooks + API：GET merges/board、POST merges/:entry/discard。
4. 集成测试：孤儿识别（造一个未登记 worktree）、丢弃防误删（有未合并内容时拒绝静默删）、批量合并。

## 批次 I（原批次 D）：冲突时间线加权裁决

1. 意图时间线构造：冲突发生时收集——冲突各方 project_task/runtime task 的开始时间倒序摘要 + `conversation_message` 中用户本人消息按时间倒序 top-N（跨任务）。
2. 裁决任务派裁决法庭（role=debate-judge）：输入=base/ours/theirs+时间线；输出=debateVerdict 扩展（语义判定+时间线 tilt 说明）；置信≥阈值（debateMinConfidence 沿用）→自动选边写入并重发布+播报理由；低于→升级用户（时间线展示"任务 X 是你 N 点开始的较新意图，但语义检查发现…"）。
3. 集成测试：时间线按开始时间排序（非完成时间）、加权生效、双低置信升级。

## 批次 J（原批次 E）：蓝图专家组合

1. `blueprint.ts`：staffing 条目扩展 `{personaId, role?}`（分工）；读取兼容旧数据（无人设组合字段=单人组合）。
2. `task.ts` 蓝图命中：派整组——组内每位优先 `findActiveSpecialistAgent`；命中多位于同 project_task 时各自为 runtime task（组内可依赖链/并行由蓝图工作流字段定，缺省并行）；缺员经人事 staffingPlan 链补建（或降级单专家+留痕）。
3. 右侧匹配栏消费组合（班底摘要含分工）；穿戴文案改派遣。
4. 集成测试：组合命中派整组、旧单人蓝图兼容、缺员走人事。

## 每批验证门（不满足不得提交）

- `npm run typecheck` 零错误（注意 `.tsbuildinfo` 是目录，用 `tsc -b`）。
- `npx vitest run` 全量全绿（本计划开工基线：193 文件 1286 例全过；基线随批次滚动，提交信息记录当轮全量数；web-tools 3 例沙箱 DNS 失败属环境基线，单文件复跑确认即可）。
- 新增集成测试覆盖各批「集成测试/测试」条目。
- CLAUDE.md「组织与名词」章回填该批交付状态。
- 一批一提交，提交信息沿用仓库中文详述风格。批次 E 落地后，提交前额外过 pre-push 门。

## 验收清单（验收人逐条核对）

| # | 验收项 | 通过标准 |
|---|---|---|
| 1 | 运行环境段（批次A） | 装配的 systemPrompt 含当前日期/时区/OS/执行器类型（测试断言） |
| 2 | token 比例判定（批次B） | 配置窗口后大 usage 触发 compact/rotate；未配置行为与现状一致 |
| 3 | 压缩摘要（批次C） | 阈值/手动/rotate 三路径 LLM 摘要落库；LLM 失败降级不阻塞；Codex 原生 compact 不回归 |
| 4 | 蜂群收口契约（批次D） | 缺段 summary 有前缀标注+事件留痕；含段与显式"无分歧"无副作用 |
| 5 | 门禁与 CI（批次E） | pre-push typecheck 本地可拦；CI e2e job 上线；THIRD_PARTY_NOTICES 登记齐 |
| 6 | 文档留痕（批次E） | postmortem 三篇成文+CLAUDE.md 索引；新 spec/plan 状态行惯例入 CLAUDE.md |
| 7 | personal 全局可见（批次F） | 乙执行任务上下文包含甲沉淀的用户偏好；personal 仍全量注入 |
| 8 | 右侧最优蓝图栏（批次F） | 命中任务时分栏显示 top-N（含评分/班底），无人设命中不显示 |
| 9 | 任务级集成区（批次G） | 普通+蜂群任务产物均落在任务集成分支（git 验证），main 无中间产物 |
| 10 | 合并开关（批次G） | 默认 manual 弹确认（含"以后自动"）；auto 免确认；仅项目级生效 |
| 11 | premium review（批次G） | concern 时本轮不合并且播报；approve 才 merge；LLM 失败跳过不阻塞 |
| 12 | 合并摘要（批次G） | 每次 promote 产生摘要记录+项目群播报（含任务/成果/文件概览） |
| 13 | 合并按钮（批次G） | 任何时候可点；未完成有提醒不阻止；显示领先 commit 数 |
| 14 | 撤回（批次G） | **无撤回按钮**（任何 UI 不出现） |
| 15 | 看门狗（批次G） | 仅 auto 项目+无在飞+无在办验收才动；只碰系统登记的集成分支 |
| 16 | 孤儿（批次H） | 看板可识别标注；永不自动合并；丢弃有内容检测防误删 |
| 17 | 冲突裁决（批次I） | 语义+时间线（开始时间）加权；高置信自动；低置信升级带时间线 |
| 18 | 蓝图组合（批次J） | 命中派整组（池优先/缺员走人事）；旧蓝图兼容；穿戴文案退役 |
| 19 | 全量验证 | typecheck 0 错 + vitest 全绿 + 一批一提交 + CLAUDE.md 回填 |

## 明确不做（防执行者顺手加戏）

- 撤回/撤销任何 UI 入口（含 ⋯ 菜单深处）。
- 绕过 worktree 直写 main 的任何路径（完全访问也只是放宽发布范围为全量）。
- 项目级 staging 新写入（只读兼容存量）。
- 蓝图进化环与专家池沉淀通道合流（另案探讨）。
- eslint/prettier 或任何全仓 lint/format（存量 190+ 文件是海量噪音；真要引另案探讨 lint-staged 只查改动文件）。
- Claude 原生 compactSession 协议对接（摘要+rotate 已达意图，不追 CLI 私有协议）。
- 向量/embedding 检索（词法召回当前够用；挂观察：召回明显漏——用户搜不到已知旧档——再上本地 embedding，走开源优先+THIRD_PARTY_NOTICES）。
- run_command 真沙盒（安全债另案排期；CLI 侧已有 fail-closed hook 桥，API 侧暴露面已知）。
- 全局 token 计数器 / systemPrompt 整体 token 预算（批次 B 只接通窗口比例判定，不造新预算体系）。
