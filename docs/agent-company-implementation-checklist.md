# Agent 公司工作台分阶段实施清单

> 依据：[Muster Agent 公司工作台 PRD](./PRD-agent-company-workbench.md)

## 2026-07-05 本地 MVP 验收记录

当前已完成并验证“本地单用户长篇小说 Agent 公司”纵向闭环。详细阶段清单保留为完整产品范围，不把尚未实现的扩展项误标为完成。

验证证据：

- `npm run typecheck`：通过。
- `npm test`：19 个测试文件、123 项测试通过。
- `npm run build`：server 与 client 生产构建通过。
- `npm run test:e2e`：Chromium 5/5 通过。
- 真实 Claude Code 两轮冒烟通过：跨 Task worktree 复用同一 session，完成文件创建/更新、Artifact 登记和 Token/缓存统计。

本轮已交付的核心范围：

- 公司、部门、员工、项目、独立员工上下班、组织锁与第一负责人。
- 项目隔离线程、个人 Task 队列、@直联权限、依赖/追问/反馈和持续协调器。
- 项目镜像并行领取、监察建议、强制复盘、用户备注与显式继续。
- Git worktree 隔离写、原子发布、三方合并、冲突阻塞、回滚与成果预览。
- 小说公司默认岗位、初始化成果、章节维护事件、滚动规划和定时一致性任务。
- 组织/通信/工作流图、员工配置编辑、AI 设置向导与明确离线模板降级。
- Claude Code 模型设置、桥接测试、跨 worktree session 续接和结构化输出纠正。

## 2026-07-06 v1 缺口推进记录

依据 PRD 核对 Phase 0-8 后，按"由简到繁"分四批补齐 PRD 列为第一版核心但此前缺失/弱化的功能。验证证据：`npm run typecheck` 通过、`npm test` 23 个测试文件 157 项通过、`npm run test:e2e` Chromium 5/5 通过、`npm run build` 通过。

矛盾裁定：PRD 与本清单原存在两处分歧，经用户裁决均纳入 v1 推进——

- **自然语言修改组织图后的差异预览**（PRD:357 列为 Graph Editing 第一版核心）：已实现 `graph-proposal.ts` + `/propose`+`/apply` REST + 前端差异面板（绿增红删 + 接受/拒绝）+ Claude 解析/本地降级/模糊匹配。覆盖 org/communication 两图。
- **其他文件调用系统默认应用打开**（PRD:369 列为 Artifact Workbench 第一版）：已实现 `POST /api/projects/:id/artifacts/open`（macOS `open`/linux `xdg-open`/win `start`，路径校验复用 `isPathAllowed`）+ 前端"用默认应用打开"按钮。

本轮新交付（按 Batch 分组）：

- **Batch 1（小项速收，8 项）**：外部应用打开、回滚 REST+UI、项目健康校验（`assertProjectHealthy`/`checkProjectHealth`）、工作流责任岗位统一校验（`validateWorkflowResponsibility`，启动时硬性校验）、监察器心跳停滞检查（`kind:'stuck'`）、全局/页面级 ErrorBoundary、关键事件聚合 feed（`event-feed.ts` + `/api/companies/:id/events` + CompanyPage 卡片）、关系图归档/恢复（migration 0007，软删除 + 灰色虚线展示）。
- **Batch 2（中等项，4 项）**：项目结束自动释放镜像（`releaseProjectMirrors` + coordinator 级联）、时间·里程碑触发复盘（扩展 `shouldTriggerReport`）、多模型 token 归集 + 公司级聚合（`recordUsageBatch` + `summarizeCompanyUsage` + `GET /api/companies/:id/usage`）、讨论结论→建议 Task（migration 0008 + `claimNextTask` 排除建议 + `acceptSuggestion`）。
- **Batch 3（大项，4 项）**：自然语言图差异预览/确认（见上）、会话压缩/轮换（migration 0009 + `incrementExecCount`/`clearSessionForCompaction`）、二进制独占锁排队（migration 0010 + `artifact_lock` 表 + 基线漂移检测）、授权参考项目目录 Claude 直接访问（`readonlyDirs` + `--add-dir`）。
- **Batch 4（文档收尾）**：本推进记录 + 复选框核对 + PRD 矛盾注释 + CLAUDE.md 更新。

明确留在后续范围：

- 部门级智能路由。
- PPT/Word/网页公司模板、多租户、积分和支付。
- docx/pptx/xlsx 内置预览（当前走"用默认应用打开"路径，PRD:369 已满足）。
- 多模态（图像/PDF 输入）：当前多 API 执行器只做文本 + 文件工具循环，多模态需图片上传 + base64 处理。

## 2026-07-06 多 API 执行器推进记录（Batch 10-14，post-v1 提前实现）

用户要求"做 4：多 API 执行器"。本轮把清单 307"多 API 执行器"从 `[ ]` 推到 `[x]`（多模态部分注明后续）。验证证据：`npm run typecheck` 通过、`npm test` 30 个测试文件 235 项通过、`npm run build` 通过。

核心设计：Provider 字段 + 工具循环执行器。每个员工可指定 `provider`（claude-cli / openai / gemini），引擎按 provider 分发。OpenAI/Gemini 通过 function calling 返回 tool call（read_file/write_file/edit_file/list_files/done），Muster 在 worktree 内执行，循环直到模型返回 done 并产出 AgentRunResult。模型不直接碰文件系统，Muster 是执行主体。

本轮新交付（按 Batch 分组）：

- **Batch 10（执行器抽象重构）**：`agentRunResultSchema` + `AGENT_RESULT_JSON_SCHEMA` 提取到 `result-schema.ts` 共享；`provider.ts` 定义 Provider 类型（claude-cli/openai/gemini）+ 默认 API key 变量名/模型/baseURL；`AgentExecutorJson` 增加 `provider`/`baseURL` 字段 + `assertExecutorValid` 枚举校验；`TaskEngine` 从单 adapter 改为 adapter registry（`adapters: Map<Provider, ExecutionAdapter>`）+ `selectAdapter` 按 agent provider 分发，向后兼容单 adapter 构造；`SystemSettings` 增加 `defaultProvider`/`openaiBaseURL`/`openaiModel`/`geminiModel`；`server.ts` 装配 adapter map。
- **Batch 11（工具循环框架）**：`tools/file-tools.ts` 定义 5 个文件工具（read_file/write_file/edit_file/list_files/done）的 OpenAI function schema + 执行器（路径校验 `isWithinWorkspace`、只读目录保护、maxReadBytes 截断、edit 唯一匹配）；`tool-loop.ts` 通用驱动器（callModel 注入、多轮 tool call 执行、done 终止、maxToolCalls/timeout 上限、usage 累加）。
- **Batch 12（OpenAI 兼容 Adapter）**：`openai-adapter.ts` `OpenAICompatibleAdapter`（任意 OpenAI 兼容 endpoint：OpenAI 官方 / DeepSeek / 通义 DashScope / 智谱）；agent executor baseURL 覆盖；`model-pricing.ts` 内置 OpenAI/DeepSeek/通义/智谱/Gemini 常见模型定价表 + `estimateCostUSD`（cached tokens 0.5x 折扣）；无 API key / API 错误返回 blocked。
- **Batch 13（Gemini Adapter）**：`gemini-adapter.ts` `GeminiAdapter`（Google AI Studio generateContent + functionDeclarations）；OpenAI↔Gemini 消息格式转换层（system_instruction / functionCall / functionResponse）；usage 解析（promptTokenCount/candidatesTokenCount/cachedContentTokenCount）。
- **Batch 14（手动压缩 + 上下文大小 + 前端 provider 配置）**：`POST /api/projects/:id/threads/:threadId/compact` 手动压缩 + `GET /api/projects/:id/threads/:threadId/context-size` 估算（compaction_summary + 最近 10 个 Task summary，4 字符≈1 token）；ProjectPage 线程卡片显示 `~X tokens · Y 次执行` + "手动压缩"按钮（prompt 输入摘要）；CompanyPage 员工编辑加 provider 下拉 + baseURL（openai 时）；SettingsPage 加"多执行器配置"卡片（默认 provider + 各 provider 默认 baseURL/model）。

## 2026-07-06 Batch 5-8 推进记录（v1 全部缺口清零）

依据"做完"指令，把上一轮剩余的 16 个 `[~]` 与 1 个 `[ ]` 全部推到完成。验证证据：`npm run typecheck` 通过、`npm test` 27 个测试文件 190 项通过、`npm run build` 通过。

本轮新交付（按 Batch 分组）：

- **Batch 5（执行器配置 + 凭据引用 + 会话轮换，清单 141/144）**：员工级 `executor_json` 真正生效（model/claudeBin/timeoutMs/maxToolCalls/skipPermissions 覆盖系统默认）；`apiKeyEnv` 用户级凭据引用（只存环境变量名，spawn 时注入 `ANTHROPIC_API_KEY`，严格校验 `/^[A-Z][A-Z0-9_]*$/`）；migration 0011 `last_rotation_at` + `rotateSession` 时间轮换（默认 24h，独立于按次数的压缩）；前端员工编辑表单加执行器配置区（含 API Key 环境变量名 password 输入）。
- **Batch 6（校验自动化 + 看板 + 复盘配置，清单 171/172/196）**：工作流保存自动跑 `validateWorkflow`+`validateWorkflowResponsibility` 返回 errors（不阻断半成品）；`checkProjectHealth` 增加缺失责任岗位检测（管理类成果 owner_agent_id 为 NULL 即报错）；`GET /api/companies/:id/status-board` 部门×员工聚合（availability/threadState/currentTask/queuedCount）；`StatusBoard` 组件 + `useStatusBoard` hook（5s 轮询）；`ReviewSettingsCard` 复盘配置（Task 数/时间/里程碑/讨论每日预算）+ `useUpdateProject`。
- **Batch 7（题材扩展包 + 可选岗位 + 维护事件 + 人物关系图，清单 243/246/251/254）**：`GENRE_EXTENSION_PACKS`（scifi/fantasy/romance/mystery/historical/continuity/style）+ `createNovelCompany({genres})` 动态追加可选岗位（worldview/timeline/foreshadowing/continuity/style/relationship）；`initializeNovelProject` 按是否存在专门岗位动态归属成果 ownerRole；`handleChapterCompleted` 改为扫描 `MAINTENANCE_ROLES` 动态派发维护 Task；`character-graph.ts` 从 characters.md + character-relations.md 解析节点/边 + `GET /api/projects/:id/character-graph` + `CharacterGraphPage`（ReactFlow 只读，nodesDraggable=false）。
- **Batch 8（讨论增强 + onboarding + e2e + soak，清单 275/280/281/282/289）**：`startBrainstorm({autoSelectParticipants:{count}})` 随机选闲置员工 + `isDailyDiscussionBudgetReached`/`getTodayDiscussionSpendUSD` 每日预算（默认 $2）+ `GET /api/projects/:id/brainstorm/budget` + UI"随机选闲置员工"按钮；`EventFeedList` 事件可点击展开 payload 详情；`OnboardingGuide` 首次使用 3 步引导（localStorage 标记，有公司自动隐藏）；`tests/e2e/novel.spec.ts` 小说端到端（建司→项目→人物关系图）；`tests/integration/soak.spec.ts` 完整 soak（50 Task + 3 次压缩 + mirror 扩容 + 复盘，断言无状态泄漏）。

## 实施原则

- 每一阶段必须形成可运行、可验证的纵向闭环。
- 先建立状态和安全不变量，再接真实模型。
- 不在旧 Leader→Worker→Verifier 状态模型上继续叠加。
- 不迁移旧 `.muster` 测试任务数据。
- 所有并发与恢复能力先通过假执行器测试，再接 Claude Code。

## Phase 0：重构基线与安全网

### 目标

建立可测试的工程基线，明确可复用与废弃边界。

### 工作项

- [x] 备份并清理旧 `.muster` 测试运行数据。
- [x] 标记旧编排器、临时群聊和旧 Task 状态为待替换模块。
- [x] 保留 Agent 进程启动、流式事件、沙盒、调度和备份能力。
- [x] 建立正式测试命令、临时数据库和虚拟时钟。
- [x] 建立执行器假实现，可模拟输出、追问、超时、失败和无进展。
- [x] 拆分单文件前端入口，为新工作台建立模块化外壳。
- [x] 定义统一错误码、事件 ID、幂等键和日志关联 ID。

### 验收

- [x] 测试命令可以在干净环境稳定运行。
- [x] 假执行器可以驱动一个最小 Task 完成。
- [x] 旧数据删除不会影响源码和新数据库启动。

## Phase 1：公司、项目和员工基础模型

### 目标

用户可以创建公司、员工和项目，并正确执行上下班与项目隔离。

### 工作项

- [x] 实现公司、部门、员工、项目和项目员工线程数据模型。
- [x] 实现公司下班、上班、排空和强制复盘状态。
- [x] 上班期间锁定正式组织配置。
- [x] 实现项目独立 Task 命名空间。
- [x] 实现跨项目只读引用。
- [x] 实现公司第一负责人和项目第一负责人。
- [x] 实现不可删除的运营监察基础角色。
- [x] 实现公司与项目健康校验。
- [x] 提供基础公司、员工和项目管理 API。

### 验收

- [x] 同一员工可同时进入两个项目。
- [x] 两个项目的上下文、Task 和文件引用不会串线。
- [x] 上班时不能修改员工职责和组织关系。
- [x] 项目可以只读引用另一项目成果，但不能写入来源项目。

## Phase 2：持久 Task 引擎

### 目标

以 Task 统一表达派发、队列、等待、反馈、追问、定时和恢复。

### 工作项

- [x] 实现 Task 状态机和追加事件记录。
- [x] 实现项目内序号与内部全局 ID。
- [x] 实现父子、根、依赖和延伸关系。
- [x] 实现原子领取、租约、心跳和过期恢复。
- [x] 实现优先级、入队顺序和跳过未就绪任务。
- [x] 实现结构化输入/输出协议。
- [x] 实现 Task 内补充对话和最大追问轮次。
- [x] 实现结果反馈后恢复原等待 Task。
- [x] 实现安全暂停、检查点和终止。
- [x] 实现事件触发和定时触发的统一入队接口。

### 验收

- [x] 两个执行线程不能领取同一个 Task。
- [x] 接收者追问后，派发者补充资料可恢复原 Task。
- [x] 依赖未完成时不会误执行，但不阻塞其他可运行 Task。
- [x] 进程异常后租约过期，Task 可安全恢复且不会重复提交。

## Phase 3：执行器、上下文与用量

### 目标

在不绑定员工身份的前提下接入本地 Claude Code，并记录真实运行成本。

### 工作项

- [x] 定义执行器适配接口。
- [x] 将现有 Claude Code 进程能力封装为首个适配器。
- [x] 实现员工执行器配置和用户级凭据引用。
- [x] 限制 Claude Code 默认只能访问当前项目和授权参考项目。
- [x] 实现项目级上下文组装和引用记录。
- [x] 实现模型会话复用、压缩和轮换策略。
- [x] 实现公司、项目、员工、Task 和模型级 Token 统计。
- [x] 实现可选预算软限制。
- [x] 实现单次运行绝对安全限制和无进展检测。

### 验收

- [x] 员工切换执行器不改变其公司身份和项目 Task。
- [x] 不同项目不会复用彼此业务上下文。
- [x] Token、缓存和工具调用可准确归集。（多模型归集已支持；公司级聚合已加）
- [x] 无进展 Task 被保存并终止，不会无限运行。

## Phase 4：组织、通信与流程图编辑器

### 目标

用户可以通过图形界面创建和修改 Agent 公司。

### 工作项

- [x] 实现统一节点/边画布基础设施。
- [x] 实现组织图编辑。
- [x] 实现通信权限图编辑。
- [x] 实现工作流图编辑。
- [x] 实现拖动、连线、属性面板和删除/归档操作。
- [x] 实现自然语言修改后的图差异预览。
- [x] 实现上班只读、下班可编辑。
- [x] 实现断裂流程、非法通信、缺失责任岗位和不可达节点校验。
- [x] 实现部门与员工状态看板。

### 验收

- [x] 用户可以不编辑配置文件完成公司结构调整。
- [x] 非法关系无法保存，并提供明确原因。
- [x] 三种图共享交互体验但不会混淆语义。
- [x] 图编辑后重新上班，项目线程使用新配置。

## Phase 5：项目镜像、监察与持续运行

### 目标

项目能够持续运转、临时扩容并可靠处理异常。

### 工作项

- [x] 实现项目级员工镜像。
- [x] 镜像共享根员工 Task 池并独立领取。
- [x] 镜像结果和成本聚合到根员工。
- [x] 实现镜像排空和项目结束自动释放。
- [x] 实现监察员状态、拥堵、缺席、心跳和循环检查。
- [x] 实现项目优化建议，不允许自动扩容。
- [x] 实现普通非阻塞进度汇报。
- [x] 实现按 Task 数、时间或里程碑触发强制复盘。
- [x] 实现按根员工汇总的轮次看板。
- [x] 实现用户摘要编号备注和“继续工作”按钮。

### 验收

- [x] 新增镜像后积压 Task 可以并行完成且不重复。
- [x] 减少镜像不会丢失当前 Task。
- [x] 达到复盘点后不再领取新 Task。
- [x] 用户未点击继续前项目不会自行恢复。
- [x] 监察建议不会直接改变项目容量或方向。

## Phase 6：安全成果工作区

### 目标

所有成果可追踪，并保证并发写入不会静默覆盖。

### 工作项

- [x] 实现成果注册表和成果处理器接口。
- [x] 实现 Task 隔离写层和共享只读视图。
- [x] 实现文本三方合并。
- [x] 实现重叠冲突检测和阻塞。
- [x] 实现二进制资源独占锁。
- [x] 实现发布前快照和回滚。
- [x] 实现成果责任岗位和修改权限。
- [x] 实现权威成果、管理成果和派生只读视图。
- [x] 实现 Markdown/纯文本编辑器。
- [x] 实现图片与 PDF 预览及外部应用打开。

### 验收

- [x] 并行修改同一文本的不同区域可安全合并。
- [x] 重叠修改不会覆盖任一方成果。
- [x] 二进制文件无法被两个 Task 同时写入。
- [x] 任意正式提交都可定位来源 Task 并回滚。

## Phase 7：长篇小说公司模板

### 目标

跑通首个真实行业模板，而不是停留在通用编排演示。

### 工作项

- [x] 实现长篇小说公司创建 Skill。
- [x] 实现题材扩展包和默认岗位推荐。
- [x] 强制分离项目第一负责人和主写手。
- [x] 实现人物、情节和监察基础岗位。
- [x] 实现可选世界观、时间线、伏笔、连续性和文风岗位。
- [x] 实现对话式项目初始化和结构化小说设定册。
- [x] 实现参考样文与风格档案。
- [x] 实现计划大纲编辑器。
- [x] 实现实际剧情进度视图。
- [x] 实现只读人物关系图。
- [x] 实现章节编辑器。
- [x] 实现章节完成后的变更摘要协议。
- [x] 实现人物、情节、时间线和伏笔维护事件 Task。
- [x] 实现小说项目滚动规划和阶段复盘。

### 验收

- [x] 用户可以从一句想法创建小说公司和项目。
- [x] 用户确认初始 Task 后，第一负责人开始当前阶段规划。
- [x] 主写手需要新人物时能向人物设计派发完整工作包。
- [x] 信息不足时双方在原 Task 中补充并恢复。
- [x] 章节完成后项目资料和派生视图得到更新。
- [x] 达到复盘点后用户可查看员工级成果摘要并纠正方向。

## Phase 8：受限讨论与体验完善

### 目标

增加可控的创意协作，并完成本地 MVP 体验。

### 工作项

- [x] 实现受 Task 约束的临时讨论。
- [x] 实现空闲员工选择、随机轮次和每日成本限制。
- [x] 正式 Task 到达时让参与者安全退出讨论。
- [x] 实现讨论结论汇总和建议 Task。
- [x] 确保建议不能自动执行。
- [x] 完善公司、项目和 Task 对话界面。
- [x] 完善关键事件摘要与完整讨论展开。
- [x] 完善首次使用引导、空状态和错误恢复。
- [x] 完成端到端浏览器测试和长时间运行测试。

### 验收

- [x] 讨论不会无限运行或抢占正式工作。
- [x] 讨论结论可追踪，但不会自动修改项目。
- [x] 本地应用重启后公司、项目、Task 和检查点完整恢复。
- [x] 长篇小说端到端验收场景连续运行通过。

## 后续阶段（不属于本 PRD 首版）

- [ ] 通用文档、PPT、网页制作公司模板。
- [x] 更多成果预览和编辑处理器。（Markdown/图片/PDF + 外部应用打开已支持；docx/pptx/xlsx 未实现）
- [ ] 部门级智能路由。
- [x] 多 API 执行器（Claude CLI / OpenAI 兼容含 DeepSeek·通义·智谱 / Gemini 均已支持，含 function calling 工具循环、手动压缩、上下文大小显示、model→price 成本估算）。多模态（图像/PDF 输入）留后续。
- [ ] 网站、多租户和云端沙盒。
- [ ] 积分、支付和订阅。
- [ ] 公司模板市场与 Skill 市场。
