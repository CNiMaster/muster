# 五批次整体实施计划：API 格式 → 任务自动归档 → 供应商卡片+模型列表 → 能力管理 UI → Skill 管线

状态：superseded（2026-08-25 已并入合并定稿版 `docs/superpowers/plans/2026-08-25-network-retry-progress-recovery-plan.md`，以合并版为准开工；本文档保留溯源，发现的勘误已回改本文件并在合并版「勘误记录」节集中列出）
日期：2026-08-25
依据：spec `docs/superpowers/specs/2026-08-25-settings-capability-expansion.md`（方向定稿）；本文件是其细化实施计划，两份配套使用。
推进节奏：**批次 1+2 合并一轮（小件）→ 批次 3 一轮 → 批次 4+5 合并一轮（共享技能存储）**。~~每轮独立 git worktree（软链 node_modules）、autostash 合 main~~ 勘误（08-25 合并时改）：主树已有未提交的工具层安全+能力分级两批，且与本计划重叠 `task.ts`/`tool-loop.ts`/`engine.ts`——worktree 从 HEAD 分叉会丢这层基线，改为**主树叠加实施**（保留两批改动、绝不 add -A、每轮全量验证门）。
前置约束（全批次）：引入任何第三方内容先查 LICENSE（MIT/Apache-2.0/BSD 可用；GPL 类隔离评估；无协议淘汰）并登记 THIRD_PARTY_NOTICES.md；外部网络一律 mock 测试。
验证门（每轮）：vitest 全量核对 Tests 总数 + `tsc -b --force` + smoke 全量（6 模块，`node scripts/smoke/run-all.mjs` 自起隔离服务器；原稿「smoke 77」计数出处不明，以实际输出为准）。

---

## 批次 1：API 格式选择（半天）

**现状事实**
- openai-adapter.ts:99 硬编码 `${baseURL}/chat/completions`；全仓无 apiFormat/responses 痕迹。
- body 构造 buildBody（:75-97）：messages/tools/tool_choice/stream/stream_options/reasoning_effort；流式失败自动回退非流式一次（:110-114）。
- 工具循环契约 CallModelFn（tool-loop.ts:57-61；ChatMessage/ModelCallResult 契约块 :29-66）要求返回 OpenAI chat 形状响应——responses 分支的转换必须收敛在 adapter 内部。apiFormat 仅对 openai-compatible 生效；gemini-api 走 generateContent 原生形状，不参与分派。
- capability-probe.ts:136-141 探测请求同样硬编码 chat/completions 形状（:147-160 function calling 两轮往返、:194-201 structured output）。
- config 是自由 record 无字段校验（api/executors.ts:105 POST /profiles），加键零迁移。

**改法**
1. config 新键 `apiFormat: 'chat-completions' | 'responses'`（缺省 chat-completions）。
2. adapter 按 apiFormat 分派：responses → `${baseURL}/responses`，请求转换（messages→input、tools 扁平化），响应解析把 `output[]` 转回 chat 消息形状；usage 取 input_tokens/output_tokens。runToolLoop 零改动。
3. capability-probe 跟随 apiFormat 分叉（URL 与请求/解析形状）。
4. 接入表单「高级选项」加 SettingsRow Select（Chat Completions(推荐)/Responses），编辑回填同步。

**验收**：单测两格式的请求构造与响应解析往返（mock fetch）；tsc+全量+smoke。

## 批次 2：任务自动归档（半天～一天）

**现状事实（重要：底座已存在，比预估缩水）**
- `project_task.archived_at` 列与 state='archived' CHECK 已在（0022_project_task_session.sql:7-9）。
- `archiveProjectTask` 级联函数已在（project-task.ts:39：取消运行中任务+线程归档+载体标记，事务内完成）。
- **缺口仅三点**：listProjectTasks（project-task.ts:22）不过滤 archived；无自动归档定时器；无保留期设置键。

**改法**
1. `listProjectTasks(db, projectId, opts?: { includeArchived?: boolean })` 默认排除；端点透传 `?includeArchived=`；useProjectTasks 传参；项目任务列表 UI 加「显示已归档」切换（默认隐藏）。
2. coordinator 卫生定时器（memoryHygieneTimer，30 分钟档）追加扫描：设置键 `archiveTaskAfterDays > 0` 时对 completed 且 completed_at 早于 N 天者调 archiveProjectTask，单次上限 50 防长事务。
3. 设置键 `archiveTaskAfterDays`（int optional，默认 30，0=关）；general 页更多行为折叠加 Select（关闭/7 天/30 天(推荐)/90 天）。
4. 还原入口：**勘误——已存在，无需补**。restoreProjectTask（project-task.ts:41，还原到 active 并清 archived_at，语义即「取消归档回到进行中」）+ 端点 `POST /projects/:id/project-tasks/:projectTaskId/restore`（api/projects.ts:611）均已在线；原稿「无则补 UPDATE state='completed'」的断言与建议 SQL 均不成立。

**验收**：单测过滤参数、扫描时间可控触发、开关生效；tsc+全量+smoke。

## 批次 3：供应商卡片 + 模型列表（两天，依赖批次 1 同表单）

**现状事实**
- config.model 消费点全景：引擎 spread 生效（engine.ts:500-513，消息级>自有人才>档案）、适配器 `agentEx?.model ?? default`（openai:55/gemini:44/opencode:208/codex:25）、探针读主模型（connection-probe.ts:32/69，缓存键含 model）、UI 下拉按档案去重（ProjectTaskWorkspace.tsx:84-94）、ExecutorCenterPage hasModel 判断（:582-585）与编辑回填（:610）。
- contextWindowTokens 档案级链路完整（executor-profile.ts:36-43 resolveContextWindow；消费点 engine.ts:656 软预算=assembleContext contextWindowTokens、:938 压缩决策=sessionManager.recordRun contextWindow→compact——原稿 :652/:925 为未提交两批合入前的旧行号），客户端从未暴露输入。
- 「测模型」按钮由 hasModel 控制（ExecutorCenterPage:601-603）。

**改法**
1. `config.models: Array<{ model: string; contextWindowTokens?: number; note?: string }>`；兼容规范入口 `profileModels(profile)` 放 shared/executor.ts（无 models 有 model→包装单元素数组），**所有消费方改走此函数取 models[0] 为主模型**。
2. 引擎 spread 语义不变；探针两处、适配器缺省链改走主模型。
3. 接入表单：「模型名」升级为模型列表编辑器（多行增删，每行可标上下文窗口，留空继承档案级）；apiFormat（批次 1）作为卡片属性在同一表单。
4. 「已就绪的工具」API 行展示模型 chips（含窗口标注）；「测模型」支持按 chips 单独触发。
5. 工作台模型下拉从每档案一项变每模型一项（label `${profile.name}：${model}`）。
6. 编辑回填 models 整列表；顺带补暴露档案级 contextWindowTokens 输入（历史上从未有 UI）。
7. resolveContextWindow（executor-profile.ts:36-43）支持行级窗口优先、档案级兜底。

**验收**：单测 profileModels 兼容包装/主模型选取/表单往返；探针缓存键含模型不回归；tsc+全量+smoke。

## 批次 4：能力管理 UI · 技能页签（三天，与批次 5 共享存储）

**现状事实**
- skillsRoot 写死 `process.cwd()/skills`（capability-binding.ts:156）——**没有用户技能根**。
- 启停治理已有 plugin opt-out 表 + getEffectivePluginsForCompany（plugin-install.ts:205-234）。
- loadSkillCatalog（skill-retrieval.ts:66）只出 name/description。

**改法**
1. 新 domain/user-skills.ts：`USER_SKILLS_ROOT = $MUSTER_HOME/skills`（同 USER_PERSONAS_ROOT 模式，persona-library.ts:48）；resolveTaskSkills/loadSkillCatalog/readBundledSkill（capability-binding.ts:248，现为私有）双根扫描——用户根优先于仓库 bundled；ResolvedTaskSkill 加 source: 'bundled'|'user'|'synthesized'|'plugin' 标注。
2. 技能面板（并入 ToolRegistryPanel 分区或相邻新面板）：列表（名称/描述/来源徽章/启停）+ 启停复用 plugin 治理同一机制 + 新建 SKILL.md 表单（frontmatter 自动生成）+ URL 导入（raw 抓取→安全扫描→落用户根→登记 THIRD_PARTY_NOTICES.md）。
3. bundled 只可停不可删不可改；删除仅限用户根。
4. 导入内容强制 LICENSE 检查 + 注入扫描（scanMemoryContent 正则系），命中拒入库。

**验收**：双根扫描回归（用户根覆盖同名 bundled）、新建/导入/停用全链单测、扫描命中拒绝用例。

## 批次 5：Skill 管线本体（三天，依赖批次 4）

**现状事实（可直接同构的样板）**
- expert-synthesis 三环节：collectSignals（expert-synthesis.ts:91-164 三信号纯查询）、economy LLM 起草（:202-214 失败降级模板）、writeUserPersonaFile（:268 写用户根）；每 tick ≤2 候选防刷屏（:54 MAX_SIGNALS_PER_TICK）。
- capability_usage_stat 战绩体系：capability-quality.ts 写入（:35）/聚合（:60,:88）。
- 能力管理岗 prompt：system-agents.ts:73-83（目前只管 [装备请示]，tool-chain.ts:220-262 派发）。

**改法**（spec §三落地）
1. 新 domain/skill-synthesis.ts 同构三环节：
   - 信号三类：taskType 相同 completed 且 rework=0 ≥3 次；同 fingerprint 前缀 CRAFT 记忆 ≥3 条优势分为正；capability_binding 同组工具连续成功 ≥5 次；
   - economy LLM 起草 SKILL.md（AgentSkills frontmatter，source:'synthesized'+origin-tasks 留痕），失败降级模板；
   - 入库 `$MUSTER_HOME/skills/<slug>/`；去重 Jaccard ≥0.4 跳过；进盘点清单供查改删。
2. 新 domain/skill-search.ts 在线检索：本地 skill-retrieval 低分触发；货源白名单首批 awesome-openclaw-skills 分类目录 raw markdown 解析 + ClawHub registry（实施时探测有无公开搜索 API，无则降级只做前者）；候选卡=名称/描述/星标/最近更新/LICENSE。
3. 可信度四维评级：来源权威 + 协议合规（无 LICENSE 淘汰）+ 内容安全扫描 + 战绩回填（引入后 capability_usage_stat 成功率修正）；≥0.8 自动引入并登记 THIRD_PARTY_NOTICES.md，<0.8 列对比卡待点选。
4. 能力管理岗感知：system-agents.ts prompt 追加职责段（synthesized 清单+待审队列）；[装备请示] 流程扩展为先查管线候选。
5. 每信号 tick ≤2 候选。

**验收**：mock callLlm 全链单测（触发→起草→入库→去重跳过）；检索解析用 fixture 不出网；评级边界用例。

---

## 不做清单（延续定稿）
Chrome 硬件加速/内置浏览器系列/更新通道/终端 Profile 暴露/平台层自研索引/遥测。索引库结论：不自研，CodeGraph 类图谱 MCP 走能力中心装备供给（大仓库任务推荐挂载）。
