# 整改计划：流程闭环 + 自动化中心一期（2026-08-19 第三轮定案）

> 状态：approved（实施中）
>
> 两部分：Part1 闭环类修复（四项，均为已核实缺口/bug）；Part2 平台级自动化中心一期（用户定案：Issue 管理是自动化功能而非使用界面，GitHub Issues 为首个实质功能，对话创建进一期，修完绝不自动合并）。
> 背景锚点见合并治理大计划（2026-08-19-merge-governance-and-blueprint-crews.md）与盲区复审轮（c312e5e）。一批一提交，每批过验证门（tsc 0 错 + vitest 全绿 + 批次新测试，批次 8 收尾跑全量 e2e）。

## Part 1：闭环类修复（批次 1-4）

### 批次 1（bug）：全量发布的删除/重命名文件正确分类
已核实：no-approval 全量发布把任务里删除的文件当 update 发（`git diff --name-only` 不分状态），发布管线发现源文件不存在→记冲突→整批阻塞+触发无意义裁决任务；删除动作永远不生效。
- `manager.ts` 新增 `listTaskBranchChangeStatus`（`git diff --name-status base..branch` 解析，R 重命名拆 old(D)+new(A)）
- `engine.ts` fullPublish 映射：D→`operation:'delete'`，R→delete(old)+update(new)，A/M→update；agent 已声明 artifacts 优先级不变
- publish-queue 的 delete 分支已存在零改动
- 测试：分类函数单测（D/R/A/M 解析含重命名拆分）+ 发布集成（删文件场景：目标消失、无冲突、无裁决任务）

### 批次 2（核心）：promote 前确定性验证
门禁现状全是语义审查（验收员/premium 审查都不真跑检查）——"agent 自检通过但机制有洞"的机器版。
- 配置：`project.settings_json.preMergeChecks: [{name, command}]` 显式优先；未配置时探测项目根 package.json scripts 含 `typecheck` → 默认 `[npm run typecheck]`；都无 → 静默跳过（非 JS 项目不阻塞）
- 执行点：`promoteTaskStaging` 在 premium 审查 approve 后、merge 前插入 `runPreMergeChecks`——异步 spawn（非 spawnSync 不阻塞事件循环）、cwd=任务集成 worktree、timeout 60s 上限 300s、`sanitizeChildEnv`、输出截断 8KB（复用 run_command 成熟口径 registry.ts:275-325）
- node_modules：项目根有且 worktree 无 → 软链过去，检查完删链（防 pre-promote 的 commitAll 卷依赖进集成分支）
- 失败：`task_merge_record` 记 `check_failed`（迷你迁移扩 status CHECK）+ 项目群播报（命令+输出尾部）+ 本轮跳过不阻塞下轮（与 concern 同语义）
- 测试：失败命令（node -e "process.exit(1)"）→ 阻塞+记录+播报；通过 → 正常 merge；无检查 → 直接 merge；探测命中 fixture

### 批次 3：反思教训层级升级 + 拆解由简入繁
- 3a 教训升级（用户拍板：单写平台级）：reflection LESSON 段格式加可选行 `<scope: project|persona>` 与 `<persona_key: xxx>`（改 system prompt 314-325 与格式模板 328-354；解析仿 fingerprint 行提取 516-518）；建议 persona 且 persona_key 非空且 confidence≥0.8 → 单写 CRAFT（scope='skill'+personaKey+人设档案宿主 profileId，不重复写项目 LESSON）；其余照旧。检索链路零新增（persona_key 全局召回现成）
- 3b 拆解由简入繁（用户设计输入）：养蜂人蜂群契约教学加"workers 按 由简入繁 排序——简单子题先跑为复杂子题铺上下文"
- 测试：mock 反思输出含/不含 scope 行两路断言；教学段断言

### 批次 4（小修）：memory CHECK 约束漂移
已核实：TS 枚举已有 'workspace' 但 memory_entry 的 scope CHECK 仍是旧 `('personal','company','project','skill')`（20260819001000 只改数据没改约束）——新插入 workspace 记忆必违约。
- 迷你迁移：CHECK 重建为 `('personal','workspace','project','skill')`
- 测试：`createMemoryCandidate(scope:'workspace')` 成功落库

## Part 2：自动化中心一期（批次 5-8）

> 用户定案：自动化是平台基础功能（定时/循环/心跳，自动触发非人触发），与正常项目工作不同层；自动化岗只在自动化页可见；自动化工作由绑定项目负责人按时领取执行；Issue 特指 GitHub Issues（对话里说的问题"说了就改"不算）。

### 批次 5：自动化岗 + 自动化页骨架
- **自动化岗**（暂定名「自动化管家」，用户可改名）：系统固定岗 role=`automation-steward`；**仅在自动化页可见**——agent_definition 加 `visible_in`（TEXT，缺省 NULL=全局花名册；'automation'=仅自动化页），listAgents 按上下文过滤；幂等懒确保（照验收员 ensureOne 先例）
- **自动化页** `/automations`（平台级全局页，进侧栏）：左侧与管家对话（ConversationPanel 复用，工作台级专用线程），右侧自动化列表（类型/节奏/绑定项目/启停/最近运行）
- 管家 done 契约：`automationPlan {kind, config, schedule, projectId}`（照 swarmPlan/materializeSwarm 先例，引擎按 assignee=管家时兑现）
- 新表 `automation`（id, kind, config_json, schedule_kind/schedule_interval_ms/time_of_day, project_id, enabled, created_via('chat'|'form'), last_run_at, created_at, updated_at）+ 迁移
- 测试：岗懒确保+可见性过滤；automationPlan 兑现落库

### 批次 6：GitHub Issues 自动化执行链（首个实质功能）
- kind='github-issues'，config={repo, labelFilter?}；节奏沿 interval/daily 语义；coordinator 独立 timer 扫描 automation 表（照看门狗先例不占 tick）
- 拉取：`gh issue list --repo <r> --json number,title,body,labels,state --state open`（gh CLI 复用+用户 gh 登录认证；失败记 health 跳过本轮不轰炸）
- 幂等记账：新表 `github_issue_sync`（repo, number, project_id, task_id, status, synced_at）——已同步不重复
- 派发：**绑定项目第一负责人按时领取**——到点建任务 assignee=项目 firstAgent，inputProtocol.githubIssues={items}；负责人教学扩展：分诊（真 bug/功能/疑问/无法复现——自由文本分类非固定枚举）→ 真伪验证（先复现才开工）→ 需修的建子任务（专家/蜂群复用现有管线）→ 子任务产物落任务级集成区
- **绝不自动 promote**：走现有 manual 合并门等用户审批
- 测试：gh mock 拉取→记账→派负责人任务；重复 issue 不重派；分诊→建子任务链路

### 批次 7：看板 Issue 标签页 + 快速配置表单
- 待合并看板加「Issue 处理」tab：github_issue_sync 视图（issue 号/标题→任务状态→集成区领先数→待审批标识）——自动化结果的独立标签页
- 自动化页「新建自动化」表单：类型 GitHub Issues → 填 repo → 绑定项目 → 节奏 → 创建（与对话创建同落 automation 表）
- 测试：tab 数据聚合；表单创建端到端

### 批次 8：对话创建打通（一期收口）
- 自动化页对话中管家产 automationPlan → 引擎 materialize 落 automation 表 + 对话播报确认（"已创建：每 1 小时拉取 xx 仓库 issues，派给项目 A 负责人"）
- 快速配置与对话创建共用同一兑现链路
- 测试：FakeLlm 对话产出 plan → automation 落库断言；表单/对话两入口等价；自动化页 e2e 1 条（页可达+对话面板渲染）

## 不做与挂观察（留档防再提）

**明确不做（含理由）**：
- 管理三件套（P0-P3/用户手选类型/管理看板）——用户裁定：任务按顺序+拖动排序已有；分类是 agent 的职责（自由判断非固定枚举，负责人分清才知道派谁）；看板繁琐。Issue 管理已按"自动化功能"重新落位（Part2）
- Issue 修完自动合并——用户明令：全完工后等用户审批 promote
- postmortem 自动化（agent 写自己复盘=自辩，本仓库三篇自辩式复盘亲证）；冲突裁决全自动（"两侧都对"无机器解，升级用户是设计边界）；精确全局 token 计数（provider usage 口径不透明，窗口比例判定够用）
- GitHub 之外的外部源导入——挂二期

**挂观察（写触发条件进 CLAUDE.md）**：
- 语义检索：记忆/归档召回明显漏（搜不到已知旧档）→ 本地 embedding（开源优先+THIRD_PARTY 登记）
- spawnSync 链路异步化：超大仓库出现可感知卡顿 → 重构

## 验证门与收尾
- 每批 `npm run typecheck` 0 错 + `npx vitest run` 全绿 + 批次新测试；批次 8 完成跑全量 e2e
- 状态行收口 implemented；CLAUDE.md 回填（自动化岗进「组织与名词」章+自动化页架构条目+挂观察触发条件）；THIRD_PARTY_NOTICES 无新增（gh 为系统已有 CLI 非依赖）
