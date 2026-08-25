# 合并实施计划（定稿）：网络重试与进度恢复 × 设置与能力扩展五批次

状态：**已实施（2026-08-25 全批落地；主树叠加，未提交）**——R1 网络就地重试 / R2 API 格式+任务自动归档 / R3 checkpoint 快照+失败续跑+任务级退避 / R4 失败卡+任务行进度+蜂群 requester+两份 spec 稿 / R5 模型列表 / R6 双根技能库+Skill 管线。验证门：vitest 全量 **285 文件 1760 例全绿** + `tsc -b --force` 0 错 + smoke 6 模块 12/12。新增测试：network-retry(19)/openai-responses-format(7)/project-task-auto-archive(4)/loop-progress-resume(9)/task-progress-summary(4)/profile-models(5)/skill-library(3)/skill-synthesis-pipeline(8)。
> R6b 交付边界说明：在线检索（skill-search.ts）已实现 domain 层（白名单目录解析+四维评级+≥0.8 自动引入，fixture 测试不出网），**「本地检索低分自动触发在线检索」的自动挂链留待下轮**（当前可被能力管理岗/后续面板直接调用）；ClawHub registry 仍按原计划探测降级。
> 已知语义变化（既有测试已随批适配）：网络类失败任务级重试 ×2→×3（30s→3m→10m）；429/5xx 由 permanent 升为可重试；归档项目任务默认从列表隐藏；timeout 类瞬时错归网络档。

## 代码审查记录（2026-08-25，审查后修复已合入）

审查结论 With fixes → 已全部修复并补 4 例回归用例（26 例相关套件全绿）：
- **Critical（已修）**：`GET /api/skills/:skillId` bundled 分支路径穿越——读取统一改走 `readBundledSkill`（四层防护，已导出为唯一入口）。
- **Important（已修）**：① import 端点 SSRF——新增 `assertImportableUrl`（https + 域名白名单 raw.githubusercontent/gist/cdn.jsdelivr/unpkg）；② `resume?restart=1` 副作用先于校验——先核 paused/blocked/failed（含 publish_conflict）再清快照；③ 快照写入/清除吞错无日志——tool-loop 与归档扫描 catch 补 `log.warn`；④ skill 合成判重跳过不收敛（每 tick 重复烧 LLM）——种子「起草完成即记 attempted 清单」（system_setting `skill_synth_attempted`），LLM 瞬时失败不记留自然重试。
- **Minor（已顺手修）**：description/sourceName 单行化防 frontmatter 注入与 THIRD_PARTY 表格破坏；disable/enable 补 SLUG 校验；DELETE 对不存在技能正确 404。
- **Minor（记录待办，不阻塞）**：ProjectWorkNavigation 双请求可 `enabled: showArchived` 延迟全量拉取；HomePage:568 手写二元 key 与 hook 三元 key 缓存双份（行为一致）；archiveStale 查询 `(state, completed_at)` 无适配索引（库大后补）；Responses 分支可加 `store: false`。
日期：2026-08-25
依据 spec：`2026-08-25-settings-capability-expansion.md`（五批次方向定稿）
基线：main HEAD `de08b6f` + **当日已落地未提交的两批**（执行器工具层安全批次、能力分级 v1，见 `2026-08-23-executor-security-hardening.md`「落地批次」节与 `2026-08-25-tool-tier-capability-roadmap.md`；1701 例全绿）。A/B 批次依赖这两批的 tool-loop/task/engine 改动。
工作方式：**主树叠加实施**（不用 worktree——未提交两批与本计划重叠 `task.ts`/`tool-loop.ts`/`engine.ts`，从 HEAD 分叉会丢基线）；保留其改动、绝不 `add -A`、每批独立验证门。
前置约束（全批次）：引入任何第三方内容先查 LICENSE（MIT/Apache-2.0/BSD 可用；GPL 类隔离评估；无协议淘汰）并登记 THIRD_PARTY_NOTICES.md；外部网络一律 mock 测试。
验证门：每批跑新增用例；每轮（下述 R1/R2/R3/R4/R5/R6 各一轮）收口跑 **vitest 全量核对 Tests 总数 + `tsc -b --force` + smoke 全量（6 模块，`node scripts/smoke/run-all.mjs` 自起隔离服务器）**。已知满载抖动（swarm-W3、pre-merge-checks）单独复跑核对，不计回归。

## 勘误记录（相对两份原稿，已核验代码）

1. 五批次·批次2「无则补 unarchive 端点」：**已存在**——`restoreProjectTask`（project-task.ts:41，还原到 active、清 archived_at）+ `POST /projects/:id/project-tasks/:projectTaskId/restore`（api/projects.ts:611）。原稿建议 SQL（state='completed'）与现状语义不符，作废。
2. 五批次·批次3 engine 行号漂移（未提交两批 +85 行所致）：软预算 :652→**:656**（assembleContext contextWindowTokens）；压缩阈值 :925→**:938**（sessionManager.recordRun contextWindow→compact）。
3. 本稿 B2「另加显式续跑 API POST /api/tasks/:id/resume」：**路由已存在**（api/tasks.ts:441 → domain resumeTask，用于暂停/等待态恢复）——续跑需扩展该端点语义（fromCheckpoint）或另起路径名，实施时不得重复注册路由。
4. 五批次·批次1：CallModelFn 实际在 tool-loop.ts:57-61（:26-66 是契约块整体）；apiFormat 仅 openai-compatible 分派，gemini-api 走 generateContent 原生形状不参与。
5. 五批次·批次4：笔误 ResololvedTaskSkill→ResolvedTaskSkill；readBundledSkill 在 capability-binding.ts:248（私有函数，双根改造点）。
6. 五批次·批次5：MAX_SIGNALS_PER_TICK :52→:54；writeUserPersonaFile :244-283→**:268**。
7. 五批次·验证门「smoke 77」：计数出处不明，改「smoke 全量 6 模块」以实际输出为准。
8. 五批次·推进节奏 worktree 每轮：与未提交基线冲突，改主树叠加（见上「工作方式」）。

## 已确认的两个产品问题答案（随批落地）

1. **muster 会不会自动切回计划模式**：目前不会（模式=发消息显式选）。本计划不做全自动切换（计划模式是用户拍板权），改为失败卡提供「切计划模式重新规划」入口（R4/B3）。
2. **四阶段路线图状态**：工具三档 ✅ 已落地未提交（1701 例验证）；原生岗模板=已存在（personas 库 15 域 300+，engineering-code-reviewer 在列，专家生成入口已有）；skill 消费路径=已打通（plugin kind=skill → collectEffectivePluginSkills → resolveTaskSkills → systemPrompt 注入，reference 类 CLI 走文件指路）；能力包分发格式=R4-D 出 spec 稿。即四阶段只剩能力包一项待做。

---

## 批次总览与依赖

R1 网络就地重试（止血，最小）→ R2 API 格式+任务自动归档（小件合并轮）→ R3 进度不白费核心+任务级退避 → R4 可见性（失败卡/任务行/蜂群）+能力包 spec 稿 → R5 供应商卡片+模型列表（依赖 R2 的同表单）→ R6 能力管理 UI+Skill 管线（共享技能存储，两批连做）。

---

## R1：网络就地重试（半天）

**现状**：API 型 callModel 网络错误无就地重试（openai-adapter.ts:117 直接 throw）→ 整 run 失败 → 任务级 transient 自动重试 ×2（立即+30s，task.ts:1474 `retryable && nextRetry<=MAX_AUTO_RETRY`）→ 持续中断约 1 分钟即 failed。shared/retry-policy.ts 已有 MAX_AUTO_RETRY=2 / AUTO_RETRY_DELAY_MS=30_000 / classifyFailureCategory / isRecoverableSessionError，**无 isNetworkFailure**。

**改法**
1. shared/retry-policy.ts 新增 `isNetworkFailure(error)`：fetch TypeError / ECONNRESET / ETIMEDOUT / ENOTFOUND / 5xx / 429（含 "Model request timed out" 字样细判）。
2. tool-loop.ts callModel 调用点包装：网络类错误 → 指数退避 1s/5s/25s 共 3 次，messages 原地保留，重试成功继续当前轮——不重启 run、不烧任务重试预算；期间 trace 记「网络中断重试中 n/3」（appendTrace 已引入 tool-loop）；stopSignal 触发立即放弃等待（对齐 H8 停止语义）。
3. 会话保真锁行为：测试断言网络类失败重试后 sessionIdHint 复用（防回归）。

**验收**：mock callModel 前两次抛网络错误第三次成功→run 继续且轮次不重置；非网络类错误不触发就地重试；stopSignal 中断等待。

## R2：API 格式选择 + 任务自动归档（一天，两小件）

### R2a API 格式（原五批次1）

**现状**：openai-adapter.ts:99 硬编码 `${baseURL}/chat/completions`；全仓无 apiFormat/responses 痕迹（已核验）。buildBody（:75-97）构造 messages/tools/tool_choice/stream/stream_options/reasoning_effort；流式失败自动回退非流式一次（:109-114）。capability-probe.ts:136-141 探测 URL 同样硬编码 chat/completions 形状（:147-160 function calling 两轮、:194-201 structured output）。config 是自由 record 无字段校验（api/executors.ts:105 POST /profiles），加键零迁移。

**改法**
1. config 新键 `apiFormat: 'chat-completions' | 'responses'`（缺省 chat-completions；仅 openai-compatible 生效）。
2. adapter 按 apiFormat 分派：responses → `${baseURL}/responses`，请求转换（messages→input、tools 扁平化），响应解析把 `output[]` 转回 chat 消息形状；usage 取 input_tokens/output_tokens。runToolLoop 零改动（转换收敛在 adapter 内）。
3. capability-probe 跟随 apiFormat 分叉（URL 与请求/解析形状）。
4. 接入表单「高级选项」加 SettingsRow Select（Chat Completions(推荐)/Responses），编辑回填同步（回填点 ExecutorCenterPage.tsx:610 一带）。

**验收**：单测两格式请求构造与响应解析往返（mock fetch）；tsc+全量+smoke。

### R2b 任务自动归档（原五批次2）

**现状**：底座已存在——`project_task.archived_at` 列与 state CHECK（0022_project_task_session.sql:7-9）；archiveProjectTask 级联（project-task.ts:39：取消运行中任务+线程归档，事务内）。**缺口仅三点**：listProjectTasks（:22）不过滤 archived；无自动归档定时器；无保留期设置键。还原端点已存在（见勘误 1）。

**改法**
1. `listProjectTasks(db, projectId, opts?: { includeArchived?: boolean })` 默认排除；端点透传 `?includeArchived=`；useProjectTasks 传参；项目任务列表 UI 加「显示已归档」切换（默认隐藏）。
2. coordinator 卫生定时器（coordinator.ts:98/338 memoryHygieneTimer，30 分钟档）追加扫描：设置键 `archiveTaskAfterDays > 0` 时对 completed 且 completed_at 早于 N 天者调 archiveProjectTask，单次上限 50 防长事务。
3. 设置键 `archiveTaskAfterDays`（int optional，默认 30，0=关；落 setting.ts 体系）；general 页「更多行为」折叠加 Select（关闭/7 天/30 天(推荐)/90 天）。

**验收**：单测过滤参数、扫描时间可控触发、开关生效；tsc+全量+smoke。

## R3：半途进度不白费 + 任务级退避（两天，核心）

**痛点实锚**：API 型 run 死 → 内存里几十轮 messages 全丢（buildMessages 每次只重建 system+任务包两条，openai-adapter.ts:304-317）；重试=从零重跑；失败 run 的已完成轮次用户看不到也没法接。CLI 型有 vendor session 保真（081f5cf），API 型没有等价物。

**改法**
1. **轮次进度持久化（checkpoint）**：新 SQLite migration（官方时间戳命名 `YYYYMMDDHHMMSS_description.sql`，不得手写短编号）建 `loop_progress` 表：task_id 主键、run_id、rounds、messages_json（经既有 compactMessagesToDigest（tool-loop.ts:125）压缩控体积）、input_hash、updated_at。runToolLoop 每轮完成写快照；done 成功/任务终态清除。落点：tool-loop.ts + 新 domain/loop-progress.ts。
2. **失败续跑**：openai-adapter.run 开头查快照——存在且 input_hash 匹配（任务输入没变）→ 以快照 messages 为底续跑（API 型获得 session 保真等价物）；输入已变 → 弃快照从头。自动重试天然走此路径；显式续跑**扩展既有** `POST /api/tasks/:id/resume`（api/tasks.ts:441，见勘误 3，加 fromCheckpoint 语义从 checkpoint 重入队，弃快照=整个重跑走既有创建路径）。CLI 型不动。
3. **任务级退避指数化（原 A2）**：纯网络类 transient（isNetworkFailure 口径）的 retry_after_at 从固定 30s 改 30s→3m→10m（其他 transient 维持现状）；auto_retry_scheduled 事件带 category 与下次延迟；耗尽后 failed 上报文案区分「网络中断重试耗尽」。落点：task.ts:1469-1488 区域。

**验收**：快照读写往返/续跑含历史轮次/input 变化弃快照/退避梯度与事件字段；tsc+全量+smoke。

## R4：可见性 + 能力包 spec 稿（一天）

1. **失败卡（B3）**：失败任务卡显示「已完成 N 轮 · 产出摘要（trace 聚合）· 失败原因」+ 三动作：[从断点续跑]（resume fromCheckpoint）/ [整个重跑]（弃快照）/ [切计划模式重新规划]（composer 预填，用户确认发送）。trace 已持久化（execution_trace 表），主要是消费端呈现。**注意**：PromptComposer.tsx 有未提交 WIP，动前先 diff 核对避免冲突。
2. **任务行轮次进度（B4）**：任务行补轮次级进度——进行中=「第 N 轮 · 最近动作摘要」，失败=「已完成 X 项产出」；数据源=loop_progress/trace 聚合，任务列表 API 带该字段。任务级分组现状已有，只补粒度。
3. **蜂群可见性（C）**：现状规则正确不改（任何非控制面智能体可发 swarmPlan 直接落地 engine.ts:825-828；派遣分级 :842-859；汇总 assignee=发起树根派发者 swarm.ts:802）。只做：蜂群任务/汇总/事件补「发起者名」标识（requester_agent_id 已存库：20260816160000_swarm_requester.sql，界面上不可见）；蜂群相关 API 返回 requester 字段；spec 一页定调养蜂人职责边界防偏航。
4. **能力包分发格式 spec 稿（D，拍板件不实现）**：docs/superpowers/specs/ 新稿：能力包=人设+工具档+审批档+技能+MCP 引用的打包声明格式；开源商用边界（不捆绑第三方内容、THIRD_PARTY_NOTICES 登记制、复用 plugin kind 体系）；安装/升级路径；与现有 personas/plugin 表的关系。

**验收**：requester 字段用例 + 失败卡/任务行字段用例；spec 稿落盘；tsc+全量+smoke。

## R5：供应商卡片 + 模型列表（两天，依赖 R2a 同表单）

**现状**（已核验）：config.model 消费点全景——引擎 spread 生效（engine.ts:500-513，消息级>自有人才>档案）、适配器 `agentEx?.model ?? default`（openai:55/gemini:44/opencode:208/codex:25）、探针读主模型（connection-probe.ts:32/69，缓存键含 model）、UI 下拉按档案去重（ProjectTaskWorkspace.tsx:84-94）、ExecutorCenterPage hasModel（:583）与编辑回填（:610）。contextWindowTokens 档案级链路完整（executor-profile.ts:36-43；消费 engine.ts:656 软预算、:938 压缩决策），客户端从未暴露输入。「测模型」按钮由 hasModel 控制（:602）。

**改法**
1. `config.models: Array<{ model: string; contextWindowTokens?: number; note?: string }>`；兼容规范入口 `profileModels(profile)` 放 shared/executor.ts（无 models 有 model→包装单元素数组），**所有消费方改走此函数取 models[0] 为主模型**。
2. 引擎 spread 语义不变；探针两处、适配器缺省链改走主模型。
3. 接入表单：「模型名」升级为模型列表编辑器（多行增删，每行可标上下文窗口，留空继承档案级）；apiFormat（R2a）作为卡片属性在同一表单。
4. 「已就绪的工具」API 行展示模型 chips（含窗口标注）；「测模型」支持按 chips 单独触发。
5. 工作台模型下拉从每档案一项变每模型一项（label `${profile.name}：${model}`）。
6. 编辑回填 models 整列表；顺带补暴露档案级 contextWindowTokens 输入（历史上从未有 UI）。
7. resolveContextWindow（executor-profile.ts:38-43）支持行级窗口优先、档案级兜底。

**验收**：单测 profileModels 兼容包装/主模型选取/表单往返；探针缓存键含模型不回归；tsc+全量+smoke。

## R6：能力管理 UI + Skill 管线（三天+三天，两批连做共享存储）

### R6a 技能页签（原五批次4）

**现状**：skillsRoot 写死 `process.cwd()/skills`（capability-binding.ts:156）——没有用户技能根。启停治理已有 plugin opt-out 表 + getEffectivePluginsForCompany（plugin-install.ts:205-234）。loadSkillCatalog（skill-retrieval.ts:66）只出 name/description。

**改法**
1. 新 domain/user-skills.ts：`USER_SKILLS_ROOT = $MUSTER_HOME/skills`（同 USER_PERSONAS_ROOT 模式 persona-library.ts:48）；resolveTaskSkills/loadSkillCatalog/readBundledSkill（capability-binding.ts:248）双根扫描——用户根优先于仓库 bundled；ResolvedTaskSkill 加 source: 'bundled'|'user'|'synthesized'|'plugin' 标注。
2. 技能面板（并入 ToolRegistryPanel 分区或相邻新面板）：列表（名称/描述/来源徽章/启停）+ 启停复用 plugin 治理同一机制 + 新建 SKILL.md 表单（frontmatter 自动生成）+ URL 导入（raw 抓取→安全扫描→落用户根→登记 THIRD_PARTY_NOTICES.md）。
3. bundled 只可停不可删不可改；删除仅限用户根。
4. 导入内容强制 LICENSE 检查 + 注入扫描（scanMemoryContent 正则系，memory.ts），命中拒入库。

**验收**：双根扫描回归（用户根覆盖同名 bundled）、新建/导入/停用全链单测、扫描命中拒绝用例。

### R6b Skill 管线本体（原五批次5）

**现状（可直接同构的样板，已核验）**：expert-synthesis 三环节——collectSignals（expert-synthesis.ts:91-164 三信号纯查询）、economy LLM 起草（:202-214 失败降级模板）、writeUserPersonaFile（:268 写用户根）；每 tick ≤2 候选（:54 MAX_SIGNALS_PER_TICK）。capability_usage_stat 战绩体系：capability-quality.ts 写入（:33-35）/单聚合（:58-62）/批聚合（:80-88）。能力管理岗 prompt：system-agents.ts:73-83（目前只管 [装备请示]，tool-chain.ts:220-262 派发）。

**改法**（spec §三落地）
1. 新 domain/skill-synthesis.ts 同构三环节：信号三类（taskType 相同 completed 且 rework=0 ≥3 次；同 fingerprint 前缀 CRAFT 记忆 ≥3 条优势分为正；capability_binding 同组工具连续成功 ≥5 次）→ economy LLM 起草 SKILL.md（AgentSkills frontmatter，source:'synthesized'+origin-tasks 留痕，失败降级模板）→ 入库 `$MUSTER_HOME/skills/<slug>/`；去重 Jaccard ≥0.4 跳过；进盘点清单供查改删。
2. 新 domain/skill-search.ts 在线检索：本地 skill-retrieval 低分触发；货源白名单首批 awesome-openclaw-skills 分类目录 raw markdown 解析 + ClawHub registry（实施时探测有无公开搜索 API，无则降级只做前者）；候选卡=名称/描述/星标/最近更新/LICENSE。
3. 可信度四维评级：来源权威 + 协议合规（无 LICENSE 淘汰）+ 内容安全扫描 + 战绩回填（引入后 capability_usage_stat 成功率修正）；≥0.8 自动引入并登记 THIRD_PARTY_NOTICES.md，<0.8 列对比卡待点选。
4. 能力管理岗感知：system-agents.ts prompt 追加职责段（synthesized 清单+待审队列）；[装备请示] 流程扩展为先查管线候选。
5. 每信号 tick ≤2 候选。

**验收**：mock callLlm 全链单测（触发→起草→入库→去重跳过）；检索解析用 fixture 不出网；评级边界用例；tsc+全量+smoke。

---

## 不做清单（两稿合并）

Chrome 硬件加速/内置浏览器系列/更新通道/终端 Profile 暴露/平台层自研索引/遥测。索引库结论：不自研，CodeGraph 类图谱 MCP 走能力中心装备供给（大仓库任务推荐挂载）。

## 边界（网络重试部分，延续原稿）

- 不加新任务状态（复用 queued/failed+事件，状态机不动）
- 不做网络健康探针（重试即探针）
- CLI 型网络/续跑维持现状（session 保真已覆盖）
- 不改蜂群判定规则与限额（只加可见性）
- 不做全自动计划模式切换
- UI 改动限于失败卡与任务行；动客户端文件前核对并行会话 WIP 避冲突
- 能力包只出 spec 不实现
