# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About Muster

Muster is a local multi-agent workbench. Persistent agents collaborate through project-scoped Tasks while fixed CLI or API executors run their work in isolated worktrees. Direction（2026-08-15 定案）：组织 = f(活)——智能体按任务穿戴人设，组织形状存在蓝图里（自动复盘进化），做完的东西进归档。详见下方「Blueprint Org Refactor」章节。

**Agent personas and skills** — 3 local personas plus 200+ domain experts integrated from [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) into `personas/`. 20 skills from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) in `skills/`.

## Product Direction: Local Agent Workbench（项目主导）

Muster is a persistent, project-driven local Agent workbench. The former one-shot Leader → Worker → Verifier model is retained only as historical context.

Authoritative planning documents:

- `docs/PRD-agent-company-workbench.md` — 历史 PRD（公司时代语义，已被 2026-08-15 蓝图定案 + 08-16 公司退场替代；当前语义以本文件「Blueprint Org Refactor」与「UI 重构」章节为权威）
- `docs/superpowers/specs/2026-07-11-platform-workspace-agent-memory-templates-design.md` — confirmed vNext workspace, employee memory, executor, permission, template, and UX design
- `docs/superpowers/plans/2026-07-11-vnext-guided-workspace-foundation.md` — delivered and verified vNext workspace/onboarding foundation
- `docs/superpowers/plans/2026-07-11-vnext-agent-profile-memory.md` — delivered and verified Agent Profile, Agent Home, layered memory, and context recovery
- `docs/superpowers/specs/2026-08-12-settings-overhaul-design.md` — 系统设置四域（网络/外观/生成参数/并发）
- `docs/superpowers/specs/2026-08-14-capability-marketplace-design.md` — 能力商城（预置策展 + 官方源 + 质量回流）
- `docs/superpowers/specs/2026-08-14-command-system-design.md` — 指挥系统（定时自动化 / 蜂群 / 对抗评审庭）
- `docs/agent-company-implementation-checklist.md` — completed historical implementation checklist and acceptance record

Key constraints for all new work:

- Do not preserve or extend the existing "quick task" mode as a product requirement. The current orchestrator and group chat are legacy implementation references, not the target architecture.
- Reuse low-level capabilities where appropriate: Claude Code process execution, streaming events, sandboxing, scheduling, backups, and path validation.
- Evolve the domain model toward Workspace, Agent Profile, Company Employee, Project, Project Agent Thread, Mirror, Task, Trigger, Artifact, Report Cycle, Usage, Executor Profile, Permission Policy, Memory Entry, and Capability Package concepts（Company Template 概念已随模板平台删除）。
- All real work belongs to a Project. Agent Profile is reusable and user-local; company employment, project context, runtime threads, sessions, permissions, and worktrees remain scoped and isolated.
- Employees bind fixed CLI or API executors. Company defaults may be inherited, but an employee does not silently switch executors during a Task.
- A mirror is a project-local temporary parallel execution thread for one employee, not a new formal company employee.
- Task is the single runtime abstraction for queues, collaboration, clarification, feedback, event triggers, scheduled work, and bounded discussions.
- The platform owns deterministic infrastructure; semantic decisions must be assigned to an explicit Agent.
- No concurrent operation may silently overwrite or lose project files.
- 题材域保留小说（novel）预设（题材扩展包/维护角色/章节初始化）；公司模板平台（general/software/content 模板向导）已随 08-16 退场删除。Multi-tenant SaaS, payments, and full PPT/Word/video editing remain outside the local workbench scope.
- Old `.muster` runtime data contains failed test runs, has no migration requirement, and may be removed when the new persistence layer is introduced.

> 当前成品边界是本地单用户多智能体工作台：项目任务、智能体/人设、蓝图、归档、固定执行器/权限、审批、会话健康和实时状态均已形成代码级闭环。服务端 company 域 = 工作台实例的数据载体（company 表/company_employee/状态机/API 仍在用），UI 层已统一为工作台文案、不出现公司语义。旧 Leader→Worker→Verifier 单次编排器不参与当前运行。

## Blueprint Org Refactor（蓝图组织重构，2026-08-15 定案，分批落地）

方向定案：**组织 = f(活)**。不再把"公司/员工"的人类组织隐喻当作一等概念——组织形状存在蓝图里，从真实使用中学出来。定案概念：

- **智能体（agent）**= 有记忆的持久执行者（治理锚点：执行器/权限仍绑任职）；**人设（persona）**= `personas/` 库中按任务穿戴的身份，不产生任职（`task.persona_id`）。变身只是任务上下文的一部分。
- **蓝图（blueprint）**= 任务类型 × 人设组合 × 战绩。反思队列消化后自动进化（`blueprint.ts` evolveBlueprint：Jaccard ≥0.4 聚类合并、胜负记账），新任务按标题词元匹配（≥0.2）自动穿戴（createTask 钩子，结果记 inputProtocol 审计）。用户零手动固化；蓝图库页可见/可锁/可淘汰。
- **记忆归域三分类**：方法论→人设（skill scope + `persona_key`，反思 CRAFT 段产出，置信 ≥0.8 自动批准）、相处→智能体（personal，永远全量注入）、事实→项目（project）。skill 注入按当前任务人设过滤（人设方法论不串门）。
- **归档（archive）= 知识库本体**：项目记忆 + 调研摘要 + 成果元数据共用一套跨项目检索（`archive.ts` searchArchive，公司隔离、排除当前项目）；干活时注入「# 相关旧档」，用户在归档页搜到的是同一套。
- **选择面/控制面分离**：@候选、探讨参与者、单聊对象 = 花名册成员（listAgents 天然排除 hidden），永远排除蜂群工蜂/辩手/镜像；蜂群工蜂只受直属调度控制，用户侧只有聚合播报 + abort。
- **动态通信图**：同项目团队成员（该项目有线程）互可派发，固定 contact_allow 白名单不再是唯一通路（createTask 守卫）；loop 防护不变。
- **用户发起探讨**：`startUserDiscussion`（brainstorm 场景）——机制与智能体发起同构（分身参会/轮转/纪要回写群聊），参与者校验选择面规则。
- **命名原则**：不造词。智能体/人设/蓝图/团队/临时工/转正/复用/复盘/调度中心/归档/工作台/记忆——全部为代码库现有词或行业通用词，中英文天然同对（agent/persona/blueprint/team/temp/convert/reactivate/retrospective/dispatcher/archive/workspace/memory）。

已交付：批次1（人设原语+记忆归域）、批次2（归档检索+归档页）、批次3（蓝图环+动态通信图）、批次4a/4b（选择面规则+用户探讨）、批次4c（项目优先入口：`createQuickProject` 零组织决策 + 首页「我有件事要办」CTA）、批次4d（收件箱项目：公司对话落 `ensureInboxProject`）、批次4e（系统隐形岗懒确保：`ensureDispatcherAgentId`/`ensureJudgeAgentId` 首次使用即创建，与公司上线时机解耦；按工作台实例化而非全局单例——执行体必须同工作台是任务守卫的硬约束）、批次5（B2B 拆件：删外包中心 UI/路由/导航/hooks、删 `findVendorCompany` 与决策树 outsource 路径；dispatch 端点只留内部建议+临时工选拔；契约状态机/交付管线/返工/自动验收保留待改造为跨项目交付协议）、批次6（全量 UI 文案对齐：员工→智能体、公司→工作台，覆盖 src/client 全部用户可见文案与 tests/unit、tests/e2e 断言；服务端中文报错文案保持不动——被大量集成测试断言且属开发面）。Code review 修复：动态通信图排除 hidden 非系统执行体（蜂群工蜂/辩手只受直属调度，系统隐形岗保持可派发）；收件箱不进项目列表/驾驶舱计数并补 project.created 事件；退役蓝图遇同类新证据自动复活（避免 UNIQUE 冲突吞战绩）；归档检索空词元守卫。测试锚点：`tests/integration/task-persona.spec.ts`、`archive-search.spec.ts`、`blueprint.spec.ts`、`user-discussion.spec.ts`、`quick-project.spec.ts`、`conversation.spec.ts`（收件箱语义）、`system-agents-lazy.spec.ts`、`outsourcing-decision.spec.ts`（两路径）。

剩余（收尾项）：外包契约状态机 → 跨项目交付协议的改造（项目对项目，替代公司对公司，需为保留的契约域设计新入口）。

## 公司概念退役 A+B+C+D（2026-08-18，分支 feat/company-drop）

- **批次 A+B+C（语义坍缩与路径收敛）**：/api/companies/* 全部下线；资源组去段扁平，单例组收进 `/api/workbench/*`。`companyIdOf(req)` 统一解析单例工作台。
- **批次 D（物理去列与终局迁移，含终审修复轮）**：
  - **迁移 A（20260819000000_company_drop_org.sql）**：重建 11 张组织/人员/对话表去 `company_id`（`department`, `agent_definition`, `relationship`, `company_employee`, `memory_candidate`, `memory_entry`, `discussion`, `handover_record`, `permission_change_request`, `business_review`, `conversation_message`）；`conversation_message.scope_kind` CHECK 改 `('workbench','project')` 且带 CASE 值转换。列清单按权威库逐列对账。
  - **迁移 B（20260819000100_company_drop_assets.sql）**：去列 11 处——重建 `workflow_node`, `workflow_edge`, `project`, `swarm_run`, `trigger`, `blueprint`, `debate`, `decision_record`，`task_closeout_summary` **形状无关重建**（真实库存在历史漂移旧形状，仅抄两形状共同列），`expert_candidate`/`blueprint_optimization_item` 裸列 DROP。
  - **迁移 C（20260819000200_company_drop_satellites.sql）**：重建 `company_employee`/`task`（解除对 outsourcing_contract 的外键）、`capability_binding` 去列；`company_plugin`→`workbench_plugin`、`company_tool`→`workbench_tool` 改名去列；DROP 死表 `company_credential`/`company_optimization_report`/`promotion_candidate`/`company_template_installation`/`template_health_finding`/`outsourcing_contract`；B2B 契约死流域代码退役，解锁 33 例单测。
  - **迁移 D（20260819000300_company_rename_workbench.sql）**：`company` 瘦身 RENAME `workbench` 单例表（保留 `first_agent_id`, `review_mode`, `shutdown_paused` 活列，删 `archived_at`, `archived_reason`, `executor_tier_*` 死列）。
  - **迁移 E（20260819000400_company_drop_leftovers.sql，终审补）**：`plugin` 表 CHECK 的 'company' 档改 'workbench'（存量值 CASE 映射、scope_id 清空）；补删漏网列 `permission_rule.company_id`/`task_reflection.company_id`。
  - **迁移 runner 外键规程（终审修复）**：`runMigrations` 逐文件事务外 `PRAGMA foreign_keys=OFF`、文件内 `foreign_key_check` 违规即回滚（SQLite 官方表重建规程）——此前 FK=ON 下 DROP 被未重建子表外键拒绝/级联误删，空库测试掩盖。
  - **plugin 契约 workbench 化（终审修复）**：`PluginScope`/`PluginSource` 的 `'company'` 成员改 `'workbench'`（无 id 载荷）；plugins API/marketplace/skill-author/plugin-adapter 全链去 `companyId:''` 空串占位；`setCompanyPluginDecision` 等签名去公司参。
  - **运行时换域与壳删除（终审+微批）**：全部生产代码（engine/context/projects/tasks/report/acceptance-review/conversation/graph-proposal/gap-research 等）改用 `domain/workbench`；`src/server/domain/company.ts` 遗留壳**已删除**——104 个测试文件夹具迁移到 workbench 域原语（`restoreWorkbench` 带名/kind 直插=夹具入口，`ensureWorkbench` 单例解析），多公司语义测试（改名查重/列表过滤/跨公司咨询拒绝）随概念退役删除或单例化改写。上下文注入标签 `# 公司章程`→`# 工作台章程`。
  - **真实库迁移（2026-08-18 执行，脚本 `scripts/company-drop-migrate-real-db.mts` 留档）**：备份至 `~/.muster-backups/` → 清理 103 家冒烟垃圾公司（仅留 `co_default_workspace`，其组织数据完整保留）→ 迁移 A-E → 断言全过（foreign_key_check 空、workbench 单行、漏网列已删）。
- **契约与事件**：`src/shared/types.ts`, `src/shared/lifecycle-events.ts`, `src/client/api/types.ts` 全面剥除 `companyId`；事件类型由 `company.state` 演进为 `workbench.state`。
- **测试基线**：tsc 0 错误；vitest 全量除 web-tools 3 例（本地沙箱 DNS 环境性失败）全过、2 skipped（多公司隔离语义过时）；e2e 与冒烟基线见批次收口记录。

## UI 重构 2026-08-16（批次 A-E，项目主导 + Composer 全功能 + 固定员工收敛）

- **排版体系**：字号刻度全部由 `--app-font-size` 推导（默认 15px，`useAppearance` 只覆写这一个变量，标题随设置缩放）；最小可视字号 12px（数字角标 10-11px 例外）；`.mu-conv` 默认 520px、flex 父容器加 `fill`/`is-fill` 弹性填充。
- **公司概念退场（无兼容）**：删 CompanyPage/CompanyListPage/CompanyWizardPage/`components/company/` 全目录与 `/companies/*` 全部路由；归档/蓝图库/组织图/协作流程改为全局路由 `/archive` `/blueprints` `/graphs/:kind` `/workflows/:workflowId`（公司/API 层退役见上方「公司概念退役 A+B+C」节，`useDefaultCompanyId` 已删除）。新建项目走 `/projects/new`；面包屑项目切换器带「＋ 新建项目」；左栏「＋ 新建任务」直建（URL `projectTask=new` 或 `newTaskSignal` 驱动创建卡）；项目页头部有工作台「上线/下班」生命周期胶囊（⌘K 命令面板同构）。
- **对话空态居中→落底**：ProjectTaskWorkspace 空态（无消息且无执行过程）hero+composer 垂直居中；首条消息或出现执行后过渡为消息流占满+composer 底部常驻（`ptws-body`/`is-empty`/`is-started`）。
- **公司模板平台删除**：TEMPLATE_BASES/template-registry/template-installation/template-architect/template-health(-findings)/company-setup/company-starter/role-templates 全删；`capability_binding` 通用查询并入 `capability-binding.ts`；迁移 drop 四张模板表；cockpit requiredRoles 缺岗告警移除。招募只剩 复用档案/新建档案 两源；`/api/novel/companies` 建司端点删除（题材预设 GENRE_EXTENSION_PACKS/MAINTENANCE_ROLES/initializeNovelProject 保留；`createNovelCompany` 降级为 tests/integration/setup.ts 夹具）。
- **固定员工（组织=f(活) 收口）**：`workspace-staff.ts` `ensureWorkspaceStaff`——工作台默认只有 第一负责人(lead,internalRecruit 豁免懒建,绑经理档权限)+验收员(ensureAcceptanceOfficer)；调度中心/评审中心隐形懒确保不变；createQuickProject 与 postUserMessage（无第一负责人时）幂等调用。旧岗位名单全仓 grep 零残留（题材域/人设库除外）。
- **Composer 全功能**：附件链路 = `POST /api/projects/:id/materials/upload`(octet-stream + x-file-name, 64MB 上限)→素材区 `materials/_uploads/` + commitAll 随仓库进后续任务 worktree；消息 `attachments_json` + 派发 inputProtocol 注入【用户附件】相对路径；`GET /:id/raw` 预览。任务药丸（切换归属）+ 分支药丸（只读 `muster/<project>/<task>`）。消息级选项 `options_json`(mode/model/thinking)：模式=计划(前缀指令+deny 只读沙盒)+三档审批(ask-always 升级审批/ask-by-rule/no-approval 降级放行)+只读；引擎 `readMessageOptions` 覆盖 `effectiveExecutor.model/thinkingDepth` 与审批策略（无员工策略时幂等绑员工档作审批载体）。斜杠命令面板（/plan /ask /rules /auto /readonly /default /model /think /task /new）。模型清单来自执行器档案+系统设置（不再硬编码）。
- **测试基线**：单测/集成 179 文件 1266 过（web-tools 3 例为本地沙箱 DNS 拦截公网域名的环境性失败，非回归）；e2e 18/18；HTTP 冒烟 77/77；product-acceptance 改为零组织路径。

## 蓝图打法包 + 蜂群专家团（2026-08-16 进化环收拢，批次1-6）

- **进化频率 = 每次任务结束**：晨醒每日定时退役（coordinator 调度/开关/设置项全删），任务终态反思队列（10s 排水）成为唯一进化驱动；晋升链（promotion/detectPromotions/候选表/API）与旧运营报告数据面（表/executor/evolution-summary/structure-versioning/entity-lock）整体删除，蓝图成为唯一进化与治理对象。
- **蓝图 = 打法包**（不再是"人设匹配器"）：`blueprint` 扩展 description（用户语言描述）、tools_json（execution_trace 按任务聚合工具记账 cap10）、rework_total/correction_total（多维战绩，综合评分=胜率60%+低返工25%+低纠正15%，样本<3 观察中）；班底 2-4 槽生效（协作成员以"协作班底"提示注入上下文，不另起执行体）；`stages_json` 二期预留（阶段工作流）。
- **版本化**：`blueprint_version` 快照链（仅结构性变更出版——新建/班底/工具集/状态/回滚；纯计数不出版），中文摘要+证据，cap 30/蓝图，回滚恢复结构保战绩另记一版；API versions/rollback/description；任务穿戴审计含 blueprintVersion（标题条与 ExecutionTraceCard 显示"🎭 蓝图label vN"）。
- **蓝图优化对话**（2026-08-17 定案，替代手动深度体检）：`blueprint-optimize-chat.ts` 每蓝图一条 AI 会话线（`blueprint_optimize_chat` 表）——用户围绕单蓝图沟通，LLM（premium 档，失败降级单蓝图确定性规则：高胜率≥80锁/低评分<30淘汰/缺描述润色）产出结构化提案落 `blueprint_optimization_item`（pending/applied/ignored，幂等），采纳落地全走版本化（合并=班底工具战绩并入+源退役）；提案动作限 lock/retire/merge/polish_description 四种。UI `/blueprints/:id/optimize`（BlueprintOptimizePage，对话+提案双栏）；公司级一键体检与 consult 整体检测已退役（前者按钮 URL 与路由错位本就 404）。
- **蜂群专家团 + 派遣分级**：SwarmPlan.worker.personaId → 工蜂穿戴人设（三蜂型：匿名/同种专家/混合专家；显式优先于蓝图自动匹配，缺失优雅降级）；调度中心提示词+蜂群契约教学三种蜂型。派遣分级：第一负责人与调度中心=全额四项限额；其他专家=小额自主（3蜂/单层/$1/并发1群，`swarm_run.requester_agent_id` 落库），超限或并发冲突→「[蜂群请示]」派第一负责人把关（不建群、计划全文派发、负责人自行决定转派调度中心或拒绝，`swarmManaged` 旁路 crewMate 守卫）；控制面（工蜂/辩手）永不自主；蜂群树每蜂人设徽章；`swarm.request-escalated` 事件。
- **断电/意外安全基线（review 修复轮）**：DB=WAL+`synchronous=FULL` 显式（提交即 fsync，断电不丢已提交事务）；关键写链路全事务化——反思四类记忆候选+done 标记同事务（崩溃整体回滚，recoverStuckReflections 复位重做不产生重复候选）、drain 进化挪进行内（反思成功后同迭代记账，消除 done 后崩溃丢记账窗口）、进化记账与版本提交/版本提交与封顶删除/优化采纳与状态/建群全链各自单事务（崩溃不留半群或"已改蓝图但建议仍 pending"）；执行器新契约字段必须同时补 result-schema 的 zod 与 AGENT_RESULT_JSON_SCHEMA（zod strip 曾致 personaId 全链静默丢失）。
- **记忆优势分（注入战绩排序，2026-08-17）**：`loadContextMemories` 排序从 `updated_at DESC` 升级为「收缩平均优势优先、时间序兜底」——解决"刚写的平庸记忆压过老而准记忆"。机制：注入记账（assembleContext 传 taskId → `memory_injection` 关联表 + `hit_count`，`(task,entry)` 唯一幂等，personal 豁免——用户偏好由用户背书不参选）；终态结算（`settleMemoryVotes` 10s 惰性扫描，不挂反思队列——反思在任务首次 waiting_input 就消耗 task_id UNIQUE，半程投票失真）：消耗分=`rework_count×2 + clarification_rounds×1`（追问走 clarification_rounds，原 conversation_message 纠正信号恒为 0 不可用），项目基线=`project_cost_stat` 已结算任务平均消耗（样本≥3 才启用，低于平均越多分越高），completed 记票 / failed 投中性 0 票（失败原因不明不冤枉不奖励且不计入基线）/ cancelled 与未终态不投；`voted_at` 守卫 + 单事务保证恰好一次（断电重扫不重复计票）；排序收缩常数 K=5（`adv_sum/(vote_count+5)`）防两次好运登顶。**扫描即过滤（review 修复）**：终态过滤放扫描 SQL 而非循环 continue——永久 waiting/cancelled 任务注入最早，会占满 LIMIT 窗口让结算静默停摆；验收未闭环推迟结算——验收返工的 `rework_count` 在源任务完成后才落（acceptance-review.ts 先加计数再发 acceptance_rework 事件），`acceptance_dispatched` 存在且未落闭环事件（passed/rework/escalated）且验收任务活着 → 推迟；验收任务死亡=事后门放行语义，此刻 rework_count 已是终值，正常结算。记忆中心面板展示「注入 N 次 · 平均优势 +x.x」。迁移 `20260817090000_memory_advantage.sql`。
- **二期路线**（本轮未做）：stages_json 阶段工作流落地（每阶段=目标/人设/工具/产出）、组合管线生成器（复杂任务匹配多蓝图→顺序阶段编排，阶段内才用蜂群并行）、蓝图拆分/派生。
- 测试基线：单测/集成 174 文件 1227 过（web-tools 偶发本地沙箱 DNS 拦截为环境性非回归）、e2e 18/18。

## 六问收口：专家沉淀 + 模型档位 + 多模态工具化 + 流式（2026-08-17）

- **专家链路修复**：调度中心上下文注入人设库索引（`persona-library.listPersonaIndex`，域分组、仅 role=swarm-dispatcher 任务注入）；personaId 未命中留 `persona_miss` 事件（蜂群 `resolveBeePersona` + 任务穿戴热删除两处）；验收/返工任务 `exemptBlueprintMatch` 豁免蓝图自动穿戴（防验收员穿与产出者同款人设）；蓝图 tools 读侧消费（命中蓝图时 `blueprintTools` 按使用次数 cap10 注入「# 本打法常用工具」）；`resolvedSkillIds` 落 inputProtocol + 任务条/ExecutionTraceCard 🧩 chips（注入去黑盒）。
- **系统自建专家（persona 沉淀管道，组织=f(活) 专家侧，免人工确认）**：反思 drain 末尾 `maybeSynthesizeExpertCandidates` 三信号——persona_miss 同 id ≥2 / 匿名蜂同 swarm goal 完成 ≥3 零失败 / 无专家人设普通任务同类 ≥3 零返工（taskTypeOf 聚类）→ LLM 轻量档起草（失败降级规则引擎）→ **自动入库**写 `~/.muster/personas/{domain}/{slug}.md`（无审批闸；去重双保险=同 signal_key 历史存在不涌现+草稿名与库内精确同名跳过）；`expert_candidate` 表=沉淀历史（status adopted/dismissed，persona_id 溯源）。管理=查/改/删：历史列表 `/api/companies/:id/expert-candidates`；人设编辑/删除单门 `/api/agent-profiles/personas/:id`（PUT 整文件重写/DELETE 删文件并标历史 dismissed，仅 user/ 前缀，预置库只读）；AgentLibraryPage「自建专家」区（编辑表单+删除确认+沉淀历史折叠）。persona-library 双根扫描（repo `personas/` + 用户根，user/ id 前缀防撞、source 标记，mtime 聚合一级子域目录热加载+写后强刷缓存）。二期不做：转正专家合并/淘汰（挂 blueprint-optimizer）、预置 243 人设正文深度激活。
- **模型档位（成本-能力匹配）**：设置键 `modelTierEconomy/Premium`（空=不覆盖零回归；标准档=不覆盖故无第三键）；`domain/model-tier.ts` 判定——轻量=蜂群工蜂(trigger=swarm_bee)/辩手/平台反思（`llm-call` tier 参数，反思/审批/技能起草默认轻量），高级=计划模式/验收/返工/裁决/蜂群请示；引擎合成顺序=消息显式 model > 档位键 > 执行器档案 model；composer 模型下拉三档快捷项。
- **API 流式输出**：openai/gemini adapter 默认 SSE 流式（400/404/422 或「provider 忽略 stream 回整包 JSON」自动回退非流式）；tool_calls 增量按 index 聚合；`ExecutionEvents.onTextDelta` → 引擎 60ms 节流广播 `message.delta`/`message.delta.end`（payload 带 agentId/projectTaskId 归属——单聊面板不串入其他任务的流；前端 realtime 对 delta 不做缓存失效，`onStreamDelta` 订阅）；ConversationPanel 打字机气泡（按归属过滤、markdown 实时渲染、8000 字符截尾、5s 无活动/落库/流结束三路清泡）。
- **对话渲染**：MarkdownPreview 重写为 react-markdown + remark-gfm + rehype-highlight（`.mu-md-*` 类名兼容既有消费方）；MessageBubble assistant 消息走 markdown（`.mu-msg-text.is-md`）+ hljs 主题跟随 data-theme（浅/深两套 GitHub 风调色）。
- **多模态工具化（主模型管思考，多模态走工具）**：`AgentExecutorConfig.capabilities` 能力声明（ExecutorCenter 勾选 vision）；识图双路——图片附件转 data-uri（仅 png/jpeg/webp/gif，≤2MB/张 ×3）随任务下发（conversation `collectImageDataUris` → inputProtocol.userImages），**引擎级门控：仅 capabilities 含 vision 才塞 ctx.imageAttachments 产 image_url/inline_data 原生直读**（未声明连 parts 都不拼——纯文本模型不会被 provider 400，走「# 图像输入提示」引导工具/禁编造；userImages 不进 inputPacket 提示词 JSON）；内置 `image_generate` 工具（OpenAI 兼容 /images/generations，`imageGenModel` 设置键，产物落 worktree、文件名穿越净化，network 权限）；复活死字段——`requires_executor_kind` 进 `findBestAssignee` 过滤（`requiredExecutorKindForCapabilities`）、工具档案 `executor_kind` 进能力缺口检测。
- **Browser 能力（WP6 选型落地，不自研）**：主选 microsoft/playwright-mcp（Apache-2.0，pin `@playwright/mcp@0.0.79`）；商城预置 `mcp-playwright`（新分类 `mcp-browser`，curatedBy 白名单扩 microsoft）+ `tools/browser/playwright-mcp.md` 档案；选型对比见 `docs/superpowers/specs/2026-08-17-browser-tool-selection.md`。
- **研究交付**：`docs/superpowers/specs/2026-08-17-dsh-capability-gap-matrix.md`——deepseek-harness 48 插件包 × muster 对照矩阵；缺口优先级=spill 上下文溢写 > bundle 能力包分发 > 蓝图 stages 阶段化；不引 Cordis 不搬代码。
- 测试锚点：`tests/integration/expert-chain.spec.ts`（豁免/miss留痕/索引/档位判定）、`expert-synthesis.spec.ts`（三信号/采纳/双根，MUSTER_HOME 动态隔离）、`tests/unit/openai-stream.spec.ts`（SSE 解析）、`image-tools.spec.ts`（文生图）。测试基线：单测/集成 178 文件 1250 过（web-tools 3 例为本地沙箱 DNS 拦截公网域名的环境性失败，非回归）+ e2e 18/18 + smoke 77/77。

## 补缺批次 R1-R3（2026-08-16 交付，配枪/验收员/资产库）

- **R1 人设配枪**：persona frontmatter `tools` 键解析（persona-library.ts）；穿戴人设时上下文含「# 人设工具」文本段 + 注册表归一化命中的工具进「# 能力中心」推荐卡（tool-recommendation.ts `normalizeToolId`）；**一次性执行体权限缺口修复**——临时工/系统隐形岗创建即绑「临时工」deny 档（permission-templates.ts `bindDefaultDenyPolicy`，API 执行器上不再零拦截，CLI 侧 fail-closed 不变；已有显式策略不覆盖，greyed 复用补绑）。
- **R2 验收员（收尾环节）**：`acceptance-officer.ts` `ensureAcceptanceOfficer`——**可见正式员工**（is_inspector 不可删、花名册可见、可对话、可 @、经理权限档、三级默认执行器）；`acceptance-review.ts` 泛化外包自动验收——任务 completed 且有验收标准、工作台 contractJson.autoReview 未关（默认开）、产出者非验收员 → 派「[验收]」Task；验收员按 `VERDICT=PASS|FAIL|CHANGES` + `CONFIDENCE` 判定：PASS 交付留痕 / FAIL|CHANGES 派「[返工]」（继承验收标准 + feedback + rework_count++）/ 低置信或解析失败升级用户（对话播报 + 事件）。验收是事后门：失败兜底走通用失败播报，不阻塞主任务。
- **R3 资产库 + git 正确性**：upsert 登记时记录 props（size/mime，排序/预览的数据基础；按大小排序 UI 待接）；`deleteArtifact`（文件+登记+git 提交删除+审计，历史可回滚）；`POST /artifacts/reveal` 资源管理器定位（buildRevealCommand：open -R / explorer /select / xdg-open；防护同 /open：项目内 + 允许根）；前端 ArtifactsPage 列表与归档画廊显示「来源任务」链接（created_task_id 首次 UI 消费）+ 画廊类型筛选；**git 两修**——`writeArtifactContent` 保存即提交（"muster: user edit"，兑现 PRD 注释）+ 发布前主干未提交改动先提交为独立提交（"muster: user edits"，不再卷进 agent 发布提交）；context 注入「# 工作区与发布」教学段（勿自行 merge/push）。
- **Review 修复（R1-R3 评审后）**：C1 验收员创建走 `internalRecruit` 豁免（org-lock 豁免但不 hidden——online 态可懒确保，此前真实运行态永远建不出）；I2 验收→返工轮回上限（`MAX_ACCEPTANCE_REWORK_ROUNDS=3`，超限升级用户）；I3 外包验收任务（reason=outsourcing_review）不再叠加验收员；I4 临时工转正时 deny 档自动重绑为员工档；I5 reveal/delete 补允许根校验；派发+留痕同事务；返工 assignee 预检；验收任务带显式 instruction。

测试锚点：`tests/integration/r1-persona-tools.spec.ts`、`acceptance-review.spec.ts`、`r3-assets-git.spec.ts`（已合入 main，随 2026-08-16 补缺批次交付）。

## 人才市场双区、蓝图连线画布与标准化收尾（2026-08-17 交付落地）

- **人才市场双区管理与自动上岗单开关**：
  - **双区展示**：专区 A「系统预置与沉淀专区」（官方 211+ 领域专家，由系统自主进化，只读展示，支持一键复制为我的人才）；专区 B「我的人才管理区」（用户完全掌控调优，支持专属提示词/模型/思考深度配置，配置永久保持，系统绝不擅改）。
  - **自动上岗单开关（🟢 自动上岗 / ⏸️ 休息中）**：自有人才开启自动上岗时，任务自动顶替官方人设并注入定制提示词与专属模型；休息中时自动切回官方基准。
- **蓝图全貌展示、AI 优化对话与正向吸收升级**：
  - **全貌只读展示**（`/blueprints/:id`）：标签、多维评分（胜率/返工率/纠正率/战力分）、人设班底（官方基准 vs 自有人才顶替标记）、常用工具战绩、版本时间线（可回滚至任一历史快照）。
  - **AI 优化对话**（`/blueprints/:id/optimize`，`POST /api/companies/:id/blueprints/:bid/optimize-chat`）：每蓝图独立会话，用户把优化想法告诉 AI，AI 回复并产出结构化提案（同页采纳/忽略，版本化落地）。原「AI 顾问体检诊断」（consult 整体检测）已退役——不够精准，全局侧由任务终态自动进化覆盖。
  - **正向吸收升级与负向隔离保护**：自有人才上岗零返工成功交付时，反思管线正向吸收其有效实践，自动升级官方蓝图基准配置（出版版本提交）；自有人才失败或返工时启动负向隔离保护，绝不劣化官方基准。
  - **独立调试任务机制**：支持将蓝图单开独立任务调试演练，满意后原子回写（`debug-adopt`）。
- **React Flow 12 蓝图工作流与资源连线画布**（参考 `ahamoment-101/Open-DeepSeek-Harness-Desktop`）：
  - 路由 `/companies/:companyId/blueprints/:blueprintId/canvas`，支持 StageNode（阶段步骤）、StaffingNode（班底专家与顶替标记）、ToolNode（工具/技能）拓扑连线。
  - **Sidecar 排布持久化**：读写 `canvas_layout` 表，视觉坐标与领域模型彻底解耦。
  - **DAG 防环拦截**：客户端与服务端严格执行环路检测（`hasCycleInEdges`），杜绝循环依赖。
- **标准化任务收尾归档（Codex Closeout Archive）**（参考 `ChenJinCloud/codex-closeout-archive`）：
  - 任务完成时自动提取 8 节高密度结构化简报与速读 Markdown：目标背景、蓝图与班底（顶替标记）、核心交付物、关键决策、验收自评达标报告、工具调用审计、反思与打法进化、后续跟进与关联打法。
  - 任务详情页渲染 `TaskCloseoutCard`，提供卡片与 Markdown 双模速读。

测试锚点：`tests/unit/talent-market-dispatch.spec.ts`、`tests/unit/blueprint-detail-consult.spec.ts`、`tests/unit/canvas-layout-and-closeout.spec.ts`（全部通过）。

## staging 集成审查（2026-08-17 一期交付：蜂群产物先入集成现场，验收后合并回主干）

- **动机**：蜂群并行产物的「逐个审太慢、合并后再审有风险」；计划等待期间他人改动最多到 staging、主干纹丝不动。
- **形态（不重写发布模型）**：保留文件级三方合并管线（锁/冲突裁决/publish_record 原样），仅把**蜂群系任务**（蜂/汇总，`task.swarmId`）的发布目标目录换成项目持久 staging worktree 检出目录（`ensureStagingWorktree`，分支 `muster/<project>/staging`）；`PublishQueue.publish` 增 `targetRootDir`（缺省=项目根，非蜂群零回归）。
- **审查现场**：验收任务/返工任务创建时随 `sourceSwarmId` 标记，worktree 从 staging 头切出——验收员看到的是一**个集成后的整体**而非孤立产出；`publish-queue` 冲突链路原样工作于 staging。
- **promote 三触发**：①验收 PASS（源任务属蜂群系，`acceptance-review.ts`）自动合并回主干；②蜂群收口且根任务无验收标准（`maybePromoteSwarmStaging`）自动合并；③手动 `POST /api/projects/:id/staging/promote`（项目页顶部「🟡蜂群集成现场在审 · 合并回主干」状态条，15s 轮询 `stageStatus`）。冲突不自动吞：`promoteStaging` abort 并返回文件清单，用户在主干手改后重试。
- **计划同意并执行闭环（A5）**：`POST /api/tasks/:id/approve-plan`——计划模式任务 completed 后取其 `summary` 计划文本派发执行任务（`trigger=plan_execution`，mode 剥离=正常读写，refPlanTaskId/parentTaskId 关联）；任务详情页「✅ 同意计划并执行」按钮。
- **回滚**：promote 后不满意 → 主干 `git revert -m 1 <mergeCommit>`（一期手动；spec 注明回滚按段）。
- 测试锚点：`tests/unit/staging-worktree.spec.ts`（建/幂等/基线切出/promote 快进+冲突）、`tests/integration/publish-staging.spec.ts`（双蜂并发发布/冲突阻塞/promote 前主干不可见）、`tests/integration/staging-promote.spec.ts`（三触发）、`tests/unit/approve-plan.spec.ts`。
- 设计文档：`docs/superpowers/specs/2026-08-17-staging-integration-review.md`、`docs/superpowers/plans/2026-08-17-staging-integration-review-plan.md`。

## 执行器池统一（2026-08-17 交付：档位=档案 · 能力自动选脑）

- **两套档位合一**：旧执行器三级（primary/secondary/tertiary）与模型档位（modelTierEconomy/Premium 模型字符串）退役为**档位=执行器档案**（CLI/API 一个选择框）。新键 `executor_tier_high/standard/low_id`（旧键兼容读取一版：high←primary、standard←secondary、low←tertiary）。设置页「执行器档位」三个档案下拉（顺带修掉 secondary/tertiary 无 UI 缺陷）；WP9 composer 档位快捷项退役。
- **档位判定与选档**（`model-tier.ts`）：`taskExecutorTier` 合并两套分类器——蜂群工蜂/辩手/轻量咨询→low，计划/验收/裁决/请示/返工→high，其余 standard；`resolveProfileForTier`（不健康/已删回落）；`selectProfileForTask` 需 CLI 技能时沿 高→标准→低 选 CLI 档案（binding 钉死不参与路由，能力缺口走既有告警）。
- **引擎模型链简化**：消息显式 > 自有人才 customModel > 执行器档案 config.model（档位已选档案，删除档位模型覆盖）。
- **能力标签**（shared `EXECUTOR_CAPABILITIES`：vision/image-gen/video-gen/voice/long-context/code）：manifest `defaultCapabilities` 预填 + 模型名启发式 `suggestDefaultCapabilities` + 执行器中心全词表 chips（用户纠偏）；vision 软降级（既有 imageAttachments 门控），多模态生成类标签走工具层非脑池。
- **展示与绑定**：执行器中心列表按档位分组（▲高/●标准/▼低/—未分配）+ 组内健康度>能力数>名称 + 能力 chips 筛选；修复员工↔执行器绑定 UI 断链（AgentProfilePage 任职卡「固定执行器」下拉）。
- **凭据**：`profile.credentialRef`(env) 接入解析链 **员工>档案>工作台>平台**（engine 任务链路 + 能力探针均注入档案 ref）；`providerForManifest` 双实现去重收敛 manif客es.ts。
- 测试锚点：`tests/unit/executor-capability.spec.ts`、`tests/unit/credential-chain.spec.ts`、`tests/integration/expert-chain.spec.ts`（新档位判定/档案解析/旧键兼容/不健康回落）。
- 设计文档：`docs/superpowers/specs/2026-08-17-executor-pool-unification.md`、`docs/superpowers/plans/2026-08-17-executor-pool-plan.md`。

## Commands

```bash
npm install              # 安装依赖（express, ws, better-sqlite3, react, react-flow, vitest, playwright 等）
npm run dev              # 开发模式：tsx watch src/server/server.ts，Express 挂 Vite middleware
npm start                # 生产模式：node dist/server/server.js（需先 build）
npm run typecheck        # TypeScript 项目引用全量检查
npm test                 # Vitest 单测 + 集成（需 git 可用）
npm run test:watch       # vitest watch 模式
npm run test:product-acceptance # 无真实模型请求的成品领域验收（零组织路径）
npm run test:e2e         # Playwright 端到端
npm run test:claude-smoke # 真实 Claude 两轮 Task/session/artifact/usage 冒烟
npm run build            # build:server(tsup) + build:migrations(迁移文件拷贝) + build:client(vite) → dist/
npm run smoke            # node scripts/smoke/run-all.mjs（需先 npm run dev，77 项 HTTP 冒烟全家桶）
```

> **冒烟测试约定**：改 capability/plugin/project-readiness/mcp/素材/权限/外包/交接相关代码后，启动 `npm run dev` 跑一次 `npm run smoke`（run-all.mjs，77 项），确认核心→素材/成果→执行器/权限→插件→B2B/临时工→委托/交接→能力平台端到端可用。单测覆盖代码逻辑，冒烟覆盖真实 HTTP 链路。

> **开源资源约定**：有现成开源/MCP 方案不自研；凡引入或借鉴开源资源（依赖、代码、设计）必须在根 `THIRD_PARTY_NOTICES.md` 登记（名称/仓库/许可/用途/引入日期/方式）——后期商业化/协议合规追溯用。

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MUSTER_PORT` | `3456` | 服务端口 |
| `MUSTER_HOST` | `127.0.0.1` | 绑定地址（本地单用户） |
| `MUSTER_HOME` | `~/.muster` | 数据目录（muster.db、worktrees/） |
| `CLAUDE_BIN` | `claude` | Claude Code CLI 路径 |
| `MUSTER_MODEL` | 留空 | 显式模型标识；留空使用 Claude Code 默认模型 |
| `MUSTER_SKIP_PERMISSIONS` | `false` | `true` 时给 Agent 传 `--dangerously-skip-permissions` |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | 项目目录允许的根列表（冒号分隔） |
| `MUSTER_TRIGGER_POLL_INTERVAL_MS` | `1000` | 持久化定时触发器的轮询间隔 |
| `NODE_ENV` | — | `production` 时 Express 服务 dist/client；否则挂 Vite middleware |

无构建无测试的旧时代已结束。SQLite 是公司配置、项目、Task、事件、用量的唯一权威源；文件成果保存在用户项目目录，由 Git worktree 隔离写、串行发布队列合并。

**Language**: UI 和 prompts 中文优先。Task 标题、日志、用户消息默认中文；代码标识符英文+中文混合。

## Architecture（当前实现）

### 顶层布局

```
src/
  shared/    # 类型、Zod schema、错误码、事件契约、常量（前后端共享）
  server/
    db/          # better-sqlite3 client + migrations/*.sql（含持久化 workspace）
    domain/      # company / agent / project / thread / graph / task /
                 # task-event / task-message / artifact / usage / report /
                 # inspector / brainstorm / triggers / novel-template / workflow /
                 # event-feed（关键事件聚合）/ graph-proposal（自然语言改图）/
                 # character-graph（只读人物关系图解析）/ speech-queue（loop protection + dedup）/
                 # swarm（蜂群）/ debate（评审庭）/ system-agents（隐形岗）/
                 # temp-worker（临时工）/ setting（系统设置模型）/ tz（时区换算）
                 # 另有：playbooks / strategy-recommender / structure-versioning /
                 # optimization-report / evolution-summary / promotion / recruitment /
                 # task-suspension / thinking-params / cli-assistant / setup-assistant /
                 # system-scan / muster-directories / capability-quality / capability-probe /
                 # connection-probe / backup-export / entity-lock / agent-router /
                 # company-cockpit / project-launch / business-review /
                 # acceptance-officer / acceptance-review（subagent-health 仅测试引用，死代码）
    task-engine/ # ExecutionAdapter 接口 + FakeExecutor + TaskEngine + RunWatchdog + agentExecutor 覆盖
    trigger-scheduler.ts # 轮询持久化 schedule trigger，原子推进并派发巡检 Task
    executors/   # Claude/Codex/Gemini CLI + OpenAICompatible/Gemini API adapters +
                 # 上下文装配 + 安全检查 + 会话压缩 + 时间轮换 + apiKeyEnv 凭据注入 +
                 # tool-loop（function calling 工具循环）+ file-tools（worktree 文件工具 + notify_host）+
                 # CLI 权限桥（Codex app-server JSON-RPC / Claude PreToolUse fail-closed Hook）+
                 # model-pricing（成本估算）+ provider（多执行器分发）+ result-schema（共享 schema）
    worktree/    # Git worktree 管理 + 串行发布队列 + artifact 独占锁
    bridge.ts    # Agent Bridge：loopback HTTP（/bridge/:action），Agent 可主动通知宿主进度
    api/         # Express 路由（companies(status-board/usage)/agents/projects(character-graph)/
                 # graphs(propose/apply)/artifacts(open/rollback)/events/usage/workflows/brainstorm/...）
    realtime.ts  # WebSocket 广播 RealtimeEvent
    server.ts    # 入口：单端口 3456，dev 挂 Vite，prod 服务 dist/client
  client/      # React 19 + Router 7 + React Flow 12 + TanStack Query 5
    pages/       # Home / Project / Tasks / TaskDetail / Materials / Artifacts / Reports / Usage /
                 # Dashboard / Graph / WorkflowGraph / CharacterGraph / Settings / Archive /
                 # BlueprintLibrary / AgentLibrary / AgentProfile / ExecutorCenter /
                 # PermissionCenter / CapabilityCenter / Marketplace / BusinessReview /
                 # ProjectPlans / ProjectSettings / NotFound
    components/  # StatusBoard / EventFeedList / ActivityPanel / ConversationPanel / OnboardingGuide /
                 # ErrorBoundary / NaturalLanguageGraphPanel / BlockingIssues / MemoryReviewPanel /
                 # StateExplanation（NextActionCard.tsx 为死代码，勿复用）+ 子目录 workbench/
                 # （WorkbenchShell/PromptComposer/ExecutionTraceCard/ProjectWorkNavigation/
                 # ProjectContextInspector/DiscussionPanel/...）、project/、review/、settings/、agents/
    hooks/       # React Query hooks
    realtime.ts  # WebSocket 断线重连 + 精确失效 React Query 缓存
    api/         # fetch client + DTO
tests/
  unit/ integration/ e2e/   # Vitest + Playwright regression/product flows
legacy/        # 旧 Leader/Worker/Verifier 代码（不参与构建，仅历史参考）
```

### 核心运行模型

- **公司状态机（服务端工作台实例载体）** `off | online | draining | review_paused | archived`：上班锁定正式组织配置；镜像扩缩容例外。UI 层已无公司语义——company 行是工作台实例的数据归组锚点，用户看到的只有「工作台上线/下班」胶囊。
- **项目状态机（准备流程）** `idle(兼容) | drafting | researching | equipping | staffing | ready | active | paused | completed | archived`：新建项目默认进 `drafting`，经六阶段准备流程（构思→调研→装备→员工→就绪）到 `active` 才能派工。`transitionProjectPhase` + `assertCanTransition` 做状态转换校验（向前需按序，回流任意允许），`validatePhaseExit` 校验向前跃迁的阶段产物（drafting 需 goal、researching 需摘要+候选能力、equipping 需启用 plugin、staffing 需分配员工）。readiness 存 `project.settings.onboarding`。任务连续失败 3 次（`failure_count >= TASK_CIRCUIT_BREAKER_THRESHOLD`）且项目 active 时自动熔断回流到 `researching`。`createProject` 接受可选 `initialState` 跳过准备流程（测试/模板用）。
- **Task 是唯一运行单元**：10 态状态机 `queued|claimed|running|waiting_input|waiting_dependency|paused|blocked|completed|failed|cancelled`。
- **项目任务边界由用户控制**：后台自动规划只能进入已有的 active `project_task`；没有用户项目任务时不得暗中创建新的上下文边界。
- **原子领取**：`BEGIN IMMEDIATE` + `UPDATE ... WHERE state='queued' ... RETURNING`，租约 + 心跳 + 过期恢复。
- **追问 3 轮上限**：超限自动给项目第一负责人派发上报 Task。
- **执行器抽象**：统一 Manifest/Profile 已落地；认证执行器包含 Codex CLI、Claude Code、Antigravity CLI 与 Muster API，自定义 CLI 以受限非交互模式运行。员工任职固定绑定执行器，基础探测使用 CLI 默认模型。
- **执行生命周期**：`RunWatchdog` 统一限制启动、空闲与总运行时长；`SessionManager` 独立处理上下文软阈值压缩、硬阈值换代和有限恢复链。
- **引擎驱动**：`ProjectRuntimeCoordinator` 在 server 启动时定时轮询 online 公司，补线程、处理中断/排空/复盘并调用 `TaskEngine.pumpThread()` 完成领取→worktree→执行→发布；也提供 `POST /api/projects/:id/pump` 手动触发。
- **定时触发**：`TriggerScheduler` 轮询 `trigger.next_run_at`；小说项目自动注册遗漏、连续性、长期一致性检查。下班期间不派发，上班后补派发；下一执行时间与 Task 创建在同一事务推进，避免重复。**定时自动化补齐（指挥系统 B1）**：`trigger` 表已重建（`project_id` 可空 + `company_id` 公司级 + `schedule_kind('interval'|'daily')`/`time_of_day`/`timezone` 时刻语义 + `last_task_id` 防叠跑）；daily 的下一执行时间由 `tz.ts` 用 Intl 无依赖换算（DST 边界回程校验）；上次派发的 Task 仍 active 时本轮跳过（`trigger_skipped_overlap` 留痕）；公司级 trigger 派给第一负责人（载体=公司最早项目，无项目不消费本轮）；晨醒受 `morningReportEnabled` 设置键门控（默认开）。
- **实时状态**：服务端通过 `/ws` 发布 Task、项目任务、审批、会话压缩/换代/恢复和 Watchdog 事件；前端精确失效项目任务、员工运行态、审批和公司驾驶舱缓存，轮询仅作断线兜底。
- **通信边界**：带 `dispatcherAgentId` 的 Task 创建必须满足同公司和 `contact_allow`，不能绕过通信图直接派发。
- **安全成果工作区**：每 Task 一个隐藏 Git worktree + 专用分支；串行发布队列做文本三方合并和二进制独占锁。冲突时保留原 worktree，自动给项目第一负责人派发带 base/ours/theirs 快照的交互式裁决 Task；临时快照不会进入 Git 提交，裁决失败或取消会升级并允许原 Task 重试。裁决发布前必须同步预检任务链，Git 发布后若数据库收口失败则自动回滚；连续两轮仍冲突时整条发布链统一升级人工。仅真正落盘且尚未回滚的发布可人工回滚。
- **总工作区**：`workspace` 表持久化多个本地根目录并保证唯一激活；未显式指定路径的新项目写入 `{workspace}/companies/{公司}/projects/{项目-ID}`，Task 仍在项目专属 worktree 内执行。
- **员工档案、任职与运行态**：`agent_profile` 是全局稳定身份，`company_employee` 是公司任职，`project_task_thread` 是项目任务中的运行会话；员工页将三者分栏展示，同一档案可被多家公司引用。
- **Agent Home 与分层记忆**：每个档案在 `{MUSTER_HOME}/agents/{profileId}` 拥有隔离个人空间；个人、技能、公司、项目记忆先进入候选审核，再写入版本化 SQLite/FTS 索引，并将已批准内容原子同步为人可读 Markdown。待审内容、凭据、会话与本地路径不会进入能力导出。
- **可重建上下文**：上下文按身份原则→公司任职→项目→已批准分层记忆→Task 装配；自动/手动压缩先持久化记忆并保留前一 session 引用，失败时不清空旧 session。
- **小说题材域**：题材预设/维护角色/章节初始化保留（GENRE_EXTENSION_PACKS/MAINTENANCE_ROLES/initializeNovelProject）；`createNovelCompany` 已降级为 tests/integration/setup.ts 测试夹具（ui-E 起无生产建司端点）；章节完成事件触发人物/情节维护；定时一致性检查；强制复盘按根员工聚合；闲置头脑风暴受限。
- **镜像**：项目内临时并行线程，共享根员工职责/上下文/Task 池，不重复领取；成果归入根员工。
- **能力中心（工具档案库）**：平台是"搬运工不是提供者"。`tools/` 目录是"能力→可用实现"的备选目录（不是安装清单），每个档案含 frontmatter（capability/implementation local|api/executor_kind/credential_keys/install/check/maturity）+ 正文。启动时 `syncToolRegistry()` 扫描入库到 `tool_registry` 表；后台设默认项，创建公司时 `dispatchDefaultToolsToCompany()` 派发到 `company_tool`。`assembleContext` 按"员工名下所有 capabilityBindings 的 recommendedToolIds"注入 `# 能力中心` system prompt 段，员工已具备相似工具时优先用自己的，缺少时参考推荐。是否安装/调用由员工自行决定，平台不做强制门禁，只做软诊断（`capability_tool_unavailable`/`capability_executor_mismatch` finding）。`capabilityBindingDefinitionSchema` 已扩展 `recommendedToolIds` 和 `requiresExecutorKind` 两字段。
- **Plugin 体系（能力接入/下载/自定义 + opt-out 治理）**：统一 Plugin 模型（kind: skill/mcp-server/tool/bridge-action/ai-generated；source: builtin/executor-native/company/project/marketplace/ai-generated；scope: platform/company/project/employee）。现有 skill/tool/bridge 通过 `plugin-adapter.ts` 包装为只读 Plugin 视图，零迁移。`plugin` 表 + `company_plugin` 决策表（启停需 `company.state==='off'`）。**opt-out 治理**（迁移 `20260809100000`）：平台插件默认对所有公司启用，公司可显式禁用（`company_plugin.decision='disabled'`）；公司独占插件（scope=company）仅目标公司可见。`getEffectivePluginsForCompany` 计算 effective = 平台插件 MINUS 禁用集 ∪ 公司独占插件。**接入**：`POST /api/plugins` 存任意 MCP 配置，`assembleTools` 在 pumpThread 时按 effective 列表连接 MCP server、探测工具、注册进 RuntimeToolRegistry。**管理页**：`/capabilities`（CapabilityCenterPage）按 kind 分 Tab，每插件展开后是公司开关矩阵（三态：default/enabled/disabled/exclusive）。**下载**：`marketplace.ts` 检索本地 `~/.zcode/skills` + GitHub(`gh search`)，`installMarketplaceEntry` 落库。**自定义**：`skill-author.ts` 调 LLM（`llm-call.ts`，OpenAI 兼容，三层凭据解析）起草 SKILL.md 作为兜底。RuntimeToolRegistry 替代原 FILE_TOOLS 硬编码 switch，内置 7 工具变注册项，第三方/MCP 工具同接口注册。
- **MCP 接入（三种 transport）**：`McpClientPool` 支持 stdio（本地子进程 command/args/env）、sse（SSEClientTransport，url/headers）、http（StreamableHTTPClientTransport，url/headers）。按 `McpServerConfig.transport` 分发到对应 SDK transport。MCP 工具经 `mcp/adapter.ts` 适配成 RuntimeTool 注册，命名 `mcp_<serverId>__<toolName>`，默认走 `network` 权限动作。连接失败的单个 server 不致命，记 health 错误后跳过。
- **项目准备流程编排（PlanVersion + 阶段历史）**：`project_plan` 表记录每次 spec/plan 版本（回流时开新版本，created_reason: initial/rollback-3x/scope-change/manual），`project_phase_history` 记录阶段进出（含 rollbackFrom/reason）。lifecycle 事件 `project.phase-entered/exited/readiness-passed/rollback` 驱动前端 wizard stepper 自动刷新（`realtime.ts` 的 `project.*` 事件 invalidate `['project', id]`）。
- **B2B 跨组织任务委派（外包）**：「公司」是软件内本地组织概念。`outsourcing_contract` 契约表（迁移 `20260810100000`）记录甲方 source → 乙方 target 的委派全生命周期：pending→accepted→in_progress→delivered→reviewing→completed/changes_requested/rejected。task 表增 `outsourcing_contract_id` 列标记承接任务。**决策入口**（`outsourcing-decision.ts`，批次5 起外包路径退役）：内部能力建议（`capability_binding` 有 employee_id 命中）+ 临时工选拔。**跨公司守卫旁路**：createTask 的同公司检查通过 `outsourcingContext` 显式参数绕过（默认不传=零回归），唯一跨公司入口是 `createOutsourcedTask`。承接任务在乙方项目里（assignee/project 同属乙方，thread 守卫自然通过）。**文件交付**：engine.ts 检测 `outsourcing_contract_id`，承接任务 worktree 基于**甲方 source project 的 git repo** 切出（`createWorktree(sourceProject.rootDir,...)`），publish 目标指向甲方 rootDir，readonlyDirs 追加甲方资料路径（复用全部三方合并管线，baseCommit 在甲方 repo 有效）。**跨公司依赖恢复**：`resumeDependents`（task.ts）扫描 `task_dependency` 全表唤醒等待方（补齐 parentTaskId 单链之外的跨公司依赖），在 completeTask completed 分支调用。验收返工（changes_requested）复用 business-review 模式：继承 acceptanceCriteria 另起返工任务。API：`POST /api/companies/:id/outsource/dispatch`（内部建议+选拔链）/ `contracts/:id/accept|review|cancel`（外包中心 UI 已退役，契约域保留）。
- **临时工模型 + 员工评级（批次 A）**：`company_employee` 增 `employment_type`('permanent'|'temp')/`temp_status`('active'|'greyed'|'dismissed')/`source_contract_id`（迁移 `20260811000000`）；`agent_profile` 增 `is_temp_only`(0|1)/`rating`(1-5)。临时工是 B2B 决策树 recruit 路径落地。**选拔优先级链**（`selectTempForNeed`）：公司内部→复用 greyed 临时工（`reactivateGreyedTemp`，高星优先）→人才库（`is_temp_only=0`）→创建新临时工（`is_temp_only=1`）。**临时工小范围关系**：`contactAllow` 仅含发起者（对其他人隐形）。**招聘豁免**：temp 招聘允许 online 态（`assertUnlocked` 的 `tempRecruit` 参数），**绝不导致公司离线**。**两种开除**：`is_temp_only=0`（人才市场来的）开除保留 profile+Home、只清公司记忆分区；`is_temp_only=1`（临时新建未转正）开除连 profile+Agent Home 一起删、不进人才市场。**完成→greyed**：承接任务完成后（`onOutsourcedTaskCompleted`）temp+active 自动 greyed，不参与派工（`claimNextTask` 排除非 active temp）。**评级**（`employee-rating.ts`）：多维度自动计算（任务完成+记忆+任职+外包验收加权）→ 1-5 星，任务完成时 `applyRating` 异步重算；用户可 `adjustRating` 手动调；影响人才市场推荐排序与外包优先。API：`POST /companies/:id/employees/temp|:id/convert|:id/dismiss|:id/reactivate`、`POST /agent-profiles/:id/rating`。
- **权限委托链 + 审计（批次 B）**：`permission_change_request` 表（迁移 `20260812000000`）记录下级申请权限变更（临时/项目/永久+原因），上级审批后生成 `permission_rule`。**委托链路由**（`permission-delegation.ts`）：员工超权→`findDirectManager`（org 边上溯 source_id）→公司第一负责人→用户，不让人逐个批。**审计日志**（`artifact_change_log`）：`upsertPublishedArtifact` 自动记 create/update；`transferArtifactOwnership`/`transferAllArtifactsOfOwner` 记 transfer（含接手人），交接时 owner 单一指针更新（不叠加）。**按角色模板**（`permission-templates.ts`）：经理(project/no-approval)/员工(task/ask-by-rule)/临时工(task/deny)三档幂等种子。API：`/permission-changes` CRUD、`/projects/:id/audit-log`、`/permission-templates/seed`。
- **离职交接工作流（批次 C）**：`handover_record` 表（迁移 `20260812010000`），按人整体交接（跨所有项目）。**四阶段**（`handover.ts`）：drafting（系统自动汇总产物清单+审计）→awaiting（用户选接手人）→receiving（逐项目 `transferArtifactsInHandover` 转移 owner）→completed（删任职+归档记忆分区）。`completeHandover` 处理 first_agent 转移（防 FK 冲突）。**连环交接**：previous_handover_id 链表追溯，但 owner 始终单一指针（A→B→C 最终 owner=C）。`offboardEmployee` 创建交接入口。产物留项目原路径（检索不遗漏），owner 指针指向接手人。Agent Home 记忆分区归档到 archive/{companyId}-{date}/。API：`/handover` CRUD + assign/receive/transfer/complete、`/companies/:id/employees/:id/offboard`。
- **凭据库（平台级基本能力）**：所有 API/CLI 接入的凭据凌驾于公司之上，统一管理。启动时 `seedDefaultCredentialDefinitions()` 幂等注入 LLM 默认凭据定义（Anthropic/OpenAI/Google 三家，`credential_definition` 表）；后台可设默认派发项；创建公司时 `dispatchDefaultCredentialsToCompany()` 派发到 `company_credential`。执行时三层解析环境变量名：① 员工级覆盖（Agent Home `profile/credentials.json`，只存变量名不存明文）→ ② 公司级覆盖（`company_credential.override_key`）→ ③ 平台默认（`credential_definition.credential_key`）→ ④ 系统回退（`PROVIDER_DEFAULT_API_KEY_ENV` 或 legacy `agent.executor.apiKeyEnv`）。`engine.ts` 的 `resolveExecutorCredentialForTask()` 统一装配，三个 adapter（Claude/OpenAI/Gemini）无需改动——它们已消费 `ctx.apiKeyEnv`。明文值始终由系统环境变量提供，不进 DB、不进日志、不进迁移。
- **素材区（项目级）**：每个项目有素材库（原料/需求/源文件），三选一导入：link（存路径/URL 引用，不复制文件，源不动）→ moved（copy+unlink 移入，源删除）→ copied（copyFile 复制，源保留）。素材存储在 `{project.rootDir}/materials/_copied/`，路径校验防目录穿越（对照 `resolveArtifactPath`）。`assembleContext` 注入 `# 项目素材` 摘要清单让员工知道可用素材。素材健康检查（link 型本地源文件是否存在）。
- **成品区泛化 + 多媒体**：`ArtifactKind` 从小说专用 12 种枚举泛化为 `NovelArtifactKind | GenericArtifactKind | string`（通用公司可用 video/audio/image/markdown/binary 等）。`artifactTypeDefinitionSchema.format` 扩展 `video|audio`。`publish-queue` 的 `isBinaryPath` 扩展音视频扩展名，video/audio/binary kind 走 `exclusive_lock`（整文件替换，不走三方合并）。ArtifactsPage 前端按格式渲染：image(`<img>`)、video(`<video controls>`)、audio(`<audio controls>`)、pdf(`<iframe>`)。成品画廊聚合查询（`artifactGallery` 按 time/type 分组，`companyArtifactGallery` 跨项目聚合）。
- **系统设置四域（settings overhaul，spec 2026-08-12）**：`setting.ts` 的 `SystemSettings` 是唯一设置模型（snake_case 存 `system_setting` 表）。**网络**：proxyUrl/proxyBypass/caCertPath/egressTimeoutMs，`runtime/egress.ts` undici 全局 dispatcher（启动时 setGlobalDispatcher，修改后重启生效）。**外观**：theme/fontFamily/fontSize/locale/codeTheme（useAppearance 实时应用）。**生成参数**：思考深度归一化(off/low/med/high)→各家参数翻译 + 上下文缓存 + thinkingSupported 探针。**并发**：executor_profile 的 max_concurrency（用户硬上限）/concurrency_locked/effective_concurrency（自适应：失败降/健康升），领取门在 engine pump 的 `canRunMore`。新增设置键六步链：setting.ts 接口+读默认+写分支 → api/settings.ts zod → queries.ts 类型 → SettingsPage 表单段 → 消费方读 getSystemSettings → 集成测试。
- **能力商城（marketplace，spec 2026-08-14-capability-marketplace）**：预置策展 10 条官方精品（`marketplace-presets.ts`，pin 不可变 commit sha/npm 版本）+ 官方源搜索（MCP Registry API + anthropics/skills + Claude Code 官方插件包 marketplace.json，插件安装映射为 skill 注入）+ `marketplace_source` 表（手动来源未审核只登记、**绝不抓取防 SSRF**）。**注入链**：`resolveTaskSkills` 先查 plugin 表再 fallback 内置 skills/（否则商城 skill 装了白装）；(kind,normalize(name)) 三层去重（同源 409/异源替换/否则冲突）；runtime 按 (kind,name) 去重实体>只读视图且过滤 disabled。质量信号回流 `capability_usage_stat` 排序。安装走事务内二次检查 + endpoint 唯一索引防并发双装。

### 多 Agent 协作增强（平台级能力）

以下能力均为通用机制，不绑定特定模板（写作模板可以不用，编码模板可以按需配置）：

- **立场锁定（stance）**：AgentDefinition 有 `stance` 字段，在 `assembleContext` 中注入 `# 你的立场` 到 system prompt，指示 Agent 在讨论/辩论中坚持预设立场。写作场景用于角色一致性，编码场景可用于 code review 立场。
- **活动流面板（ActivityPanel）**：Agent 间的 outboundTasks 派发（`spawned_child` 事件）和交接活动显式化，在项目页/工作台的独立面板展示 `@A → @B` 协作摘要。WebSocket 实时刷新（`project-events`/`company-events` key）。
- **执行过程展示（ExecutionTraceCard）**：任务执行明细落 `execution_trace` 表（kind=thinking/text/tool_call/tool_result/file_edit/progress/preview/notice/error，区别于 task_event 状态机事件）。接入点：API 执行器在 tool-loop 循环内落 trace（含 OpenAI reasoning/Gemini thoughts 思考提取）；CLI 执行器从 stream-json 事件流实时解析（`claude-stream-events.ts` 纯函数，thinking/tool_use/tool_result 块），engine 回调仅 executorKind='cli' 落库防重复；bridge/notify_host 的 progress/notify/preview 在 `processBridgeAction` 落 trace（原死通道接活）。保留策略：payload 深度截断 8KB + 每任务上限 500 条（先裁最老 tool_result）。TaskDetailPage 主列时间线（倒序、思考块默认折叠、「展开/收起同类」按 kind 批量操作 + localStorage `mu-trace-expand:<kind>` 全局记忆、preview 缩略图 + 灯箱）；`GET /api/tasks/:id/trace?kind=&limit=`；`trace.append` realtime 精确失效。
- **Loop Protection**：`speech-queue.ts` 的 `isDispatchLoop()` 追踪 Agent→Agent 派发链，检测 A→B→A 回环和连续调用超限（阈值 3），在 `task.ts` 的 outboundTasks 派发处阻断并记录 `dispatch_loop_blocked` 事件。
- **去重（dedup）**：`speech-queue.ts` 的 `isDuplicateContent()` 用 Jaccard 关键词相似度检查 assistant 回复是否与近期消息重复（>80% 抑制），在 `engine.ts` 回复写入前调用。
- **Agent Bridge**：`bridge.ts` 提供 loopback HTTP 通道（`/bridge/:action`，action=progress/notify/preview），让 Agent 执行中主动通知宿主进度。OpenAI/Gemini 通过 `notify_host` 工具调用，Claude-cli 通过 systemPrompt 中的 curl 指令。taskId 格式校验防注入。
- **工作流条件边 + 受控回环**：`WorkflowEdge` 有 `condition`（5 种：always/auto_review/outcome_equals/manual_approval/agent_label）和 `maxTraversals`（回环保护）。`advanceWorkflowTask` 按条件优先级求值而非仅靠 LLM label 匹配；`auto_review` 解析 `REVIEW_STATUS: PASS/FAIL` 标记（借鉴 FreeBuddy）。`assembleContext` 注入 `workflowBranches` 让 Agent 看到可选出边。

### 指挥系统（定时自动化 / 蜂群 / 对抗评审庭，spec 2026-08-14-command-system-design）

三件事共享同一底座（N 个干净上下文的一次性子智能体并行 + 结构化回收 + 一个收口人）：

- **系统隐形岗（W0）**：`agent_definition.is_system` + `company_employee.hidden`。coordinator tick 对 online 公司幂等创建「调度中心」（role=`swarm-dispatcher`，放蜂）与「评审中心」（role=`debate-judge`，裁决）。`listAgents` 默认过滤 hidden（花名册/能力路由/组织图一处生效，内部传 `includeHidden`），`claimNextTask` 不受影响（隐藏 ≠ 不可领取）。**隐岗不在 `ensureProjectThreads`（按可见花名册）覆盖内——创建隐岗任务前必须显式 `ensurePrimaryThread`**。
- **蜂群（swarm）**：结构=树管控制面（`task.swarm_id/swarm_depth` + `swarm_run` 记账），依赖管执行面（`task_dependency` 收口）。调度中心经 done 结构化输出返回 `swarmPlan {goal, workers[]}`（全执行器通用契约，引擎仅在 assignee 是调度中心时兑现，engine.ts materializeSwarm 钩子）；系统建群（限额快照）+ 一次性工蜂（`createTempEmployment` + hidden，role=`swarm-worker`，干净上下文+结构化摘要纪律）+ **独立汇总任务**（依赖全蜂，避免父任务上下文已满）；蜂可经 outboundTasks 再下探。**四项限额**（设置键 swarmMaxDepth=3/MaxWidth=5/MaxNodes=30/BudgetUSD=5，上限非目标）：插入点在 `task.ts` completeTask 的 outbound 消费（超限 `swarm_limit_blocked` 留痕+continue）与 `spawn_tasks` handler；预算=usage_record 按 swarm_id 聚合。**失败可观测**（单一记账咽喉）：蜂终态统一过 `recordSwarmNodeOutcome`（completeTask/failTask/cancelTask 调用，根任务与告警任务不计数）；失败率 ≥30%（≥3 收口）→ 去重「蜂群告警」给调度中心（可返回新 swarmPlan 补蜂到原群）；失败 >50% → 自动熔断（取消剩余+status=failed+保留根任务产终局报告）；蜂失败视为已收口（`resumeSwarmDependentsAfterFailure` 解除依赖，汇总带着失败走）；蜂群内失败不走 [兜底] 改道调度中心。**失败自动修复**：不可恢复失败的蜂（非替补、无替补、群未熔断、未超全群上限 `swarmRepairMax`）由 `maybeAutoRepairBee` 自动生成替补蜂（`[替补]` 标题，inputProtocol.repair 注入失败摘要+反思教训作换思路依据，原蜂标 `superseded_by`，根任务留 `swarm_bee_repair_dispatched` 事件 + notice trace）。**管控**：`GET /api/tasks/:id/swarm`（树数据）+ `POST /api/tasks/:id/swarm/abort`（一键停群）；TaskDetailPage 右栏 SwarmTreeCard 树视图（状态着色/当前高亮/停群按钮/失败蜂「已重发 → 替补」链接）。
- **结构化选项 + 对话可见（B3）**：`AgentRunResult.questionOptions`（id/label/detail/pros/cons）+ `task.question_options_json`；`answerClarification(db, taskId, {answer?|optionId?})`（**签名已改**，optionId 落「【选项】label」消息）；引擎回帖条件含 waiting_input（对话窗能看到追问+选项，追问不去重）；MessageBubble/ClarifyCard 一键选择（useTaskOnce 无轮询，靠 task.* realtime 失效）。两难契约教学在 context.ts 输出契约段。
- **对抗评审庭（debate）**：**无配额，两难即辩**。引擎门控：waiting_input 且 ≥2 选项（且非辩论/裁决任务自身）→ `startDebate` 拦截组庭，对话先收启动播报不发裸问题。编排零引擎改动、全确定性：R1 立论（≤3 辩手各防御一选项，隐藏临时 agent role=`debater`，stance 注入立场，干净上下文防锚定）→ R2 互攻（依赖全部 R1，上下文经 `relayOutputToDependents` 把上游 summary 落下游任务消息）→ 裁决任务给评审中心（依赖全部 R2，返回 `debateVerdict {recommendedOptionId?/confidence/rationale/flaws[]}`，同样走 done 契约）。两轮封顶（外部研究：3 轮后从众塌缩/跑题漂移）。裁决分流：置信 ≥ `debateMinConfidence`(0.6) → 自动采纳（answerClarification 继续执行 + decision_record source=auto + 对话播报）；低于 → 升级用户（选项 cons 补致命伤 + 任务消息差评清单 + 对话差评消息一键选择）；用户已抢先回答则不再打扰。**偏好记忆**：用户每次选项回答 → decision_record(source=user, 关联 debate) → `recentDecisions` 注入后续辩手/裁决上下文（userDecisions）→ 升级次数随使用下降。评审记录：`GET /api/companies/:id/debates` + 进化与报告页卡片。

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/server/server.ts` | Express + WebSocket 入口，挂载所有 REST 路由 + Vite middleware + bridge |
| `src/server/db/migrations/0001_init.sql` | 14 张表 schema |
| `src/server/domain/task.ts` | Task 状态机、原子领取、租约、依赖、追问、自动规划、loop protection |
| `src/server/domain/speech-queue.ts` | isDispatchLoop（循环检测）+ isDuplicateContent（去重） |
| `src/server/domain/workflow.ts` | 工作流图 + 条件边求值 + 受控回环（maxTraversals） |
| `src/server/bridge.ts` | Agent Bridge loopback HTTP（/bridge/:action） |
| `src/server/task-engine/engine.ts` | pumpThread 驱动领取→执行→完成 |
| `src/server/trigger-scheduler.ts` | 持久化定时触发器轮询与生命周期 |
| `src/client/realtime.ts` | WebSocket 实时查询同步 + bridge.notify toast |
| `src/server/executors/context.ts` | 上下文装配（stance 注入 + workflowBranches + bridge prompt） |
| `src/server/executors/claude-code-adapter.ts` | Claude CLI 适配器 + AgentRunResult Zod 校验 |
| `src/server/executors/tools/file-tools.ts` | worktree 文件工具 + notify_host（Agent Bridge） |
| `src/server/worktree/publish-queue.ts` | 串行发布 + 三方合并 + 冲突阻塞 |
| `src/server/domain/novel-template.ts` | 小说题材域：题材预设/维护角色/章节初始化（createNovelCompany 已降级为测试夹具） |
| `src/server/domain/report.ts` | 强制复盘周期（review_paused → 看板 → 备注转修正） |
| `tools/` | 能力中心工具档案库（能力→实现备选目录，启动扫描入 `tool_registry` 表） |
| `src/server/domain/tool-registry.ts` | 工具档案扫描/CRUD/默认派发（`syncToolRegistry`/`listTools`/`dispatchDefaultToolsToCompany`） |
| `src/server/domain/tool-recommendation.ts` | Task 执行时工具推荐解析 + `# 能力中心` system prompt 段构建 |
| `src/server/api/tools.ts` | 工具档案管理 REST 路由 |
| `src/server/executors/tools/registry.ts` | **RuntimeToolRegistry** — 运行时工具注册表（替代 FILE_TOOLS 硬编码），register/resolve/definitions + 7 内置工具 handler |
| `src/server/executors/tools/mcp/client-pool.ts` | **McpClientPool** — stdio/sse/http 三种 transport 的 MCP 连接池（懒连接/复用/探测/超时/关闭） |
| `src/server/executors/tools/mcp/adapter.ts` | MCP 工具 → RuntimeTool 适配（注册进 registry） |
| `src/server/executors/tool-assembly.ts` | 装配函数：内置工具 + 已启用 MCP 工具 → 合并 RuntimeToolRegistry（pumpThread 调用） |
| `src/shared/plugin.ts` | **Plugin 统一模型**（kind/source/scope/manifest 判别联合） |
| `src/server/domain/plugin-adapter.ts` | Plugin 读侧：skill/tool/bridge 三源包装为 Plugin 只读视图 + parsePluginRow |
| `src/server/domain/plugin-install.ts` | Plugin 写侧：install/remove/upsert + 公司启停 + 健康检查 |
| `src/server/domain/marketplace.ts` | 能力市场检索（local ~/.zcode/skills + github gh search）+ installMarketplaceEntry |
| `src/server/domain/skill-author.ts` | AI 兜底起草 SKILL.md（调 llm-call） |
| `src/server/domain/llm-call.ts` | 平台级 LLM 调用（OpenAI 兼容 fetch，三层凭据解析） |
| `src/server/domain/outsourcing-contract.ts` | **B2B 外包契约**：状态机 CRUD + accept/review/deliver + createOutsourcedTask（跨公司任务唯一入口） |
| `src/server/domain/outsourcing-decision.ts` | **外包决策入口**：hasInternalCapability + 临时工选拔（外包路径已退役） |
| `src/server/domain/outsourcing-delivery.ts` | **B2B 交付协调**：onOutsourcedTaskCompleted（承接任务完成→契约 delivered + 临时工 greyed，幂等） |
| `src/server/domain/temp-worker.ts` | **临时工生命周期**：createTempEmployment/convertTempToPermanent/markTempGreyed/reactivateGreyedTemp/dismissTempWorker/findGreyedTempForReuse |
| `src/server/domain/employee-rating.ts` | **员工评级**：calculateRating（多维度加权）/applyRating/adjustRating/recalculateAllRatings |
| `src/server/api/outsourcing.ts` | B2B REST 路由：dispatch（内部建议+选拔链）/ contracts / accept / review / cancel |
| `src/server/api/temp-worker.ts` | 临时工 + 评级 REST 路由：temp/convert/dismiss/reactivate/rating |
| `src/server/domain/permission-delegation.ts` | **权限委托链**：findDirectManager（org 上溯）/createPermissionChangeRequest/approveChangeRequest |
| `src/server/domain/artifact-audit.ts` | **产物审计**：logArtifactChange/listArtifactHistory/listProjectAuditLog |
| `src/server/domain/permission-templates.ts` | **按角色权限模板**：经理/员工/临时工三档幂等种子 |
| `src/server/domain/handover.ts` | **离职交接四阶段**：createHandover/assignReceiver/startReceiving/transferArtifacts/completeHandover |
| `src/server/api/permission-delegation.ts` | 权限委托 + 审计 REST 路由：permission-changes/audit-log/permission-templates |
| `src/server/api/handover.ts` | 离职交接 REST 路由：handover CRUD + assign/receive/transfer/complete |
| `src/server/domain/project-readiness.ts` | **HARD-GATE**：assertCanTransition + transitionProjectPhase + assertProjectActive（派工闸门） |
| `src/server/domain/project-onboarding.ts` | readiness 读写（存 settings.onboarding）+ validatePhaseExit 阶段产物校验 |
| `src/server/domain/project-plan.ts` | PlanVersion CRUD（版本自增+supersede）+ phase history 记录 |
| `src/server/api/plugins.ts` | Plugin CRUD + MCP 连接测试 + 公司启停 + marketplace 检索/安装 + AI 起草路由 |
| `src/client/components/workbench/WorkbenchShell.tsx` | 三栏工作台唯一壳层：顶栏（品牌菜单+栏位开关+面包屑+⌘K 命令面板+主操作）、三栏 grid、抽屉遮罩、WorkbenchGuide |
| `src/client/components/workbench/useWorkbenchPreferences.ts` | 栏位偏好：桌面持久化（localStorage `muster:workbench:{scopeKey}`）+ 移动 ephemeral 抽屉状态解耦；`normalizeWorkbenchPreferencesForWidth` 只在 ≥1180px 收起被挤压栏 |
| `src/client/components/workbench/ProjectWorkNavigation.tsx` | 项目左栏：项目任务/协作与沟通/工具与资产/系统设置四组（按工作状态组织；work-nav-more 收「历史任务」） |
| `src/client/components/workbench/ProjectContextInspector.tsx` | 项目右栏：当前对象摘要（联系人/任务/运行/待处理 + 折叠协作设置） |
| `src/client/components/workbench/WorkbenchContextSwitcher.tsx` | 面包屑切换器：项目/当前对象（不承载完整功能目录） |
| `src/client/components/workbench/ProjectToolPageShell.tsx` | 项目工具页（tasks/plans/dashboard/artifacts/...）复用同一三栏壳，不重新出现全局顶栏（另导出 TaskDetailProjectShell） |
| `src/client/components/workbench/WorkbenchGuide.tsx` | 一次性三步引导（选择工作/完成工作/查看现场） |
| `src/client/components/project/ProjectOnboardingWizard.tsx` | 六阶段准备流程 wizard（drafting→researching→equipping→staffing→ready→active，允许回流） |
| `src/client/components/project/phases/` | 5 个阶段表单组件（DraftingPhase/ResearchingPhase/EquippingPhase/StaffingPhase/ReadyPhase） |
| `scripts/smoke/run-all.mjs` | HTTP 冒烟全家桶（77 项：1-core/2-materials-artifacts/3-executors-perms/4-plugins/5-b2b-temp/6-delegation-handover/capability-platform，需先 npm run dev） |
| `docs/superpowers/specs/2026-07-26-capability-platform-design.md` | 能力与流程平台总架构 spec（4 子系统 A/B/C/D + 6 批次 B1-B6） |
| `src/server/domain/credential-store.ts` | 凭据库（平台级）：三层解析 + CRUD + seed + 公司派发 |
| `src/server/api/credentials.ts` | 凭据库管理 REST 路由（平台级 + 公司级） |
| `src/server/db/migrations/0003_settings.sql` | 系统设置表 |
| `src/server/db/migrations/0004_trigger_schedule_state.sql` | 定时触发器执行游标 |
| `src/server/db/migrations/0012_agent_stance.sql` | Agent stance 字段 |
| `src/server/db/migrations/0014_workflow_edge_condition.sql` | 工作流边条件 + 回环上限 |
| `src/server/db/migrations/0015_workspace.sql` | 总工作区根目录与唯一激活状态 |
| `src/server/db/migrations/0016_agent_profile.sql` | 全局 Agent Profile 与公司任职兼容迁移 |
| `src/server/db/migrations/0017_agent_memory.sql` | 分层记忆候选、条目、版本与 FTS 索引 |
| `src/server/db/migrations/0018_session_memory_flush.sql` | 压缩前记忆持久化与上一 session 引用 |
| `src/server/db/migrations/0019_agent_profile_base.sql` | 可恢复的员工基础能力快照 |
| `src/server/domain/agent-home.ts` | 隔离 Agent Home、身份/能力导出和记忆文件同步 |
| `src/server/domain/memory.ts` | 记忆审核、作用域、版本、检索与安全扫描 |
| `src/server/domain/swarm.ts` | **蜂群**：swarm_run 记账/四项限额/工蜂创建/materializeSwarm/失败处置（告警·熔断·停群·回收） |
| `src/server/domain/debate.ts` | **对抗评审庭**：startDebate 确定性编排（R1→R2→裁决）/finalizeDebate 分流（自动采纳/升级）/decision_record 偏好 |
| `src/server/domain/system-agents.ts` | **系统隐形岗**：ensureSystemAgents（调度中心/评审中心）幂等创建 |
| `src/server/domain/tz.ts` | 时区墙上时刻↔UTC 换算（Intl 无依赖，DST 回程校验）——daily 触发器用 |
| `src/server/domain/setting.ts` | SystemSettings 唯一设置模型（网络/外观/生成参数/并发/蜂群/评审阈值）+ 六步链示例 |
| `src/server/runtime/egress.ts` | undici 全局出口（代理分流 + CA 注入，修改后重启生效） |
| `src/server/domain/executor-concurrency.ts` | 按执行器并发领取门（硬上限/锁定/自适应） |
| `src/server/domain/marketplace-presets.ts` | 商城预置策展（10 条官方精品，pin 不可变版本）+ 安装状态判定 |
| `src/server/domain/marketplace-search.ts` | 商城检索（官方源：MCP Registry/anthropics skills/Claude Code 插件包） |

### WebSocket 事件

统一 `RealtimeEvent<T>` 格式（id/type/companyId?/projectId?/taskId?/occurredAt/payload），`/ws` 路径广播。React Query 管 REST 状态，WS 事件负责精确失效相关 Task、线程和用量缓存。

### 沙盒与安全

`src/server/sandbox.ts` 维护 22 条危险命令黑名单 + 工具白名单。Claude Code 默认只能访问当前 Task worktree + 用户授权只读参考项目。

### 测试

- Vitest 单元与集成测试覆盖运行闭环、workspace 引导、全局智能体档案、跨工作台任职、Agent Home、分层记忆、项目任务会话、CLI 探测、审批桥、上下文恢复、复用与安全重置；准确数量以 `npm test` 当前输出为准（当前 179 文件 / 1269 测试，1266 过；web-tools 3 例为本地沙箱 DNS 拦截公网域名的环境性失败非回归；含能力平台 B1-B5、三栏工作台、定时自动化（tz 时区/schedule-automation）、蜂群 swarm.spec、结构化选项 question-options.spec、评审庭 debate.spec、蓝图组织重构 task-persona/archive-search/blueprint/user-discussion/quick-project/system-agents-lazy、对话附件 message-attachments 等）。
  - 测试环境需要真实 git 仓库作为 `project.rootDir`（`createWorktree` 需要 `git rev-parse HEAD` 成功）。`tests/integration/setup.ts` 的 `makeTempGitRepo()` 创建临时 git 仓库（含初始 commit）供测试使用。
  - `project.rootDir` 与 `firstAgentId` 均为可选：建项目时留空，`createProject` 自动使用当前激活总工作区，并生成 `{workspace}/companies/{公司名}/projects/{项目名}-{项目ID}`；项目 ID 后缀保证同名项目不会共享目录。`ensureGitRepo()` 会在首个 worktree 创建时自动 `mkdir + git init`。
- Playwright 覆盖项目主导流程（新建项目→首 Task）、在线建项目、最近项目恢复、工作台信息架构与项目导航、智能体库、执行器中心（折叠式安装引导）、权限中心、窄屏工作台抽屉以及窄屏设置页；准确数量以 `npm run test:e2e` 当前输出为准（当前 18 测试：smoke 11 + marketplace 2 + novel 2 + product-completion 2 + regression 1）。
- `npm run test:claude-smoke` 已使用真实 Claude Code 连续完成两个 Task，验证跨 worktree 的 `--session-id`/`--resume`、文件发布、Artifact 登记和 Token/缓存用量。

`publish_record` 由 `0002_conversation.sql` 创建，记录 Task 发布提交、合并文件、冲突与阻塞状态，供成果修改历史页读取。

### 已知工程取舍
- **系统岗的结构化输出契约模式**：给系统隐形岗（调度中心/评审中心）扩展能力走 `AgentRunResult` 的可选字段（swarmPlan/debateVerdict）+ result-schema 同步，而不是注册工具——CLI 执行器没有工具循环，done 契约是全执行器唯一同构通道。引擎兑现前必须校验 assignee 的 isSystem+role（普通 agent 返回一律忽略）。
- **隐岗与一次性 agent 的线程陷阱**：hidden 任职（系统岗/工蜂/辩手）不在 `ensureProjectThreads` 覆盖内；创建其任务前必须显式 `ensurePrimaryThread`，否则任务永远无人领取。蜂任务终态把蜂 grey（`markTempGreyed`），群/辩论关闭统一 `dismissTempWorker`（is_temp_only 硬删，审计留 task 行与事件）。
- **better-sqlite3 嵌套事务安全但别滥用**：domain 钩子（swarm 记账/辩论收口）可能在 completeTask 事务内再开事务（自动 savepoint）；dismissTempWorker 内含 rmSync 文件 IO，事务内可用但慢，注意别在热路径。
- **工具注册表优先于硬编码**：新增可执行工具（MCP/自定义/AI 生成）一律走 `RuntimeToolRegistry.register()`，不要再扩展 `file-tools.ts` 的 FILE_TOOLS 或 `executeFileTool` switch。`file-tools.ts` 已瘦身为"类型定义 + 工具定义数据"，运行时分发在 `registry.ts` 的 `executeTool`。
- **Plugin 体系是新能力的统一入口**：接入 MCP/skill/tool 都经 `POST /api/plugins` 落库 + `company_plugin` 启停 + `assembleTools` 装配。不要再为单个能力写硬编码 adapter。
- **项目状态机改动需同步三处**：`server/domain/project.ts`（ProjectState 类型）+ `server/db/migrations`（CHECK 约束）+ `client/api/types.ts`（前端字面量）+ `shared/lifecycle-events.ts`（ProjectPhase 内联类型）。漏一处会 typecheck 或运行时失败。
- `noUncheckedIndexedAccess` 关闭（为绕过 express `req.params` 类型摩擦）。代价：数组下标访问不强制 undefined 检查。如需更严格，重开后主要修 `src/shared/utils.ts` 和 domain 的 row 映射。
- Claude Code 的模型可用性由用户本机或代理服务决定。先在“系统设置”填写实际支持的模型标识并运行桥接测试；错误模型会直接返回诊断，不会用 FakeExecutor 冒充成功。
- 当前认证接入包含 Codex CLI、Claude Code、Antigravity CLI、OpenAI-compatible API 和 Gemini API，并完成统一 Manifest/Profile、项目任务会话、审批/Turbo 权限、分层记忆和平台化公司入口。
- OpenCode/Pi 等更多 CLI 需通过同一兼容性门禁后再加入；完整多模态和多租户 SaaS 不属于当前本地成品边界。

### UI 分层约定
- **低门槛优先**：项目优先开工——首页自然语言输入（createQuickProject 零组织决策）或表单新建 /projects/new；零组织对话经 workspace-staff 固定员工（第一负责人 + 验收员）即开工；rootDir/firstAgentId 后端自动。
- **看板纯前端增强**：DashboardPage 用 `useProjectEvents`/`useStatusBoard`/`useTasks` reduce/`useProjectUsage.byModel` 在客户端做状态分布条、负载柱状图、事件时间线、模型用量拆分；不引入图表库，用 CSS（`.dashboard-*` 类）可视化。新增聚合趋势（吞吐/费用时序）需后端补端点，不属于前端职责。
- **低频配置收口**：项目目录、说明、复盘阈值和讨论预算集中到“项目设置”；项目页仅将线程扩容和脑暴收进协作工具折叠区。员工编辑折叠立场/技能/权限/执行器；系统设置首屏只显示默认执行器、连接测试与保存。
- **三栏工作台信息架构（项目页）**：`WorkbenchShell` 是唯一壳层，三栏语义固定——左栏"选择工作"、中栏"完成工作"、右栏"查看当前对象状态"。设计规格见 `docs/superpowers/specs/2026-07-13-three-pane-workbench-design.md`。重构后的入口纪律：
  - **左栏按工作状态组织，不按系统模块组织**。项目左栏四组：项目任务（活跃项目任务 + 任务领取清单 + 新建入口）/ 协作与沟通（项目群聊 + 第一负责人 + 部门员工树）/ 工具与资产（成果与文件·自动化·蓝图库·归档·智能体人才库）/ 系统设置。历史任务收进单层**更多**（`work-nav-more`，内联展开列表，**不**做 popover——左栏 `overflow:auto` 会裁剪绝对定位弹出层）。
  - **右栏是对象摘要不是运营仪表盘**。`ProjectContextInspector`：当前对象 + 状态 + 1~3 关键指标 + 一个主行动 + 紧急待处理直显 + 折叠的协作/设置/团队现场。空状态不显示空告警卡。
  - **中栏只突出一条主线**：项目任务工作面 = 任务标题+状态+目标 → 制作前提 → 工作单 Composer → 高级协作折叠。有活跃任务时"新建项目任务"默认收起。员工工作面统计卡收敛为 3 项。
  - **顶部工具栏唯一**：品牌入口是全局菜单（首页·新建项目·蓝图库·归档·智能体库·执行器·权限·审批·设置），`WorkbenchContextSwitcher` 只切项目/当前对象，不再承载完整功能目录。`⌘K` 是可搜索命令面板（`WorkbenchShell` 接 `commandOptions` prop，按 group 分组，项目页/工具页各传入上下文相关选项）。
  - **响应式分层**：`useWorkbenchPreferences` 区分**桌面栏位**（持久化到 localStorage `muster:workbench:{scopeKey}`，`normalizeWorkbenchPreferencesForWidth` 只在 ≥1180px 收起被挤压的栏）和**移动抽屉**（<1180px 的 ephemeral `drawers` 状态，不持久化、互斥单开、遮罩+Escape 关闭）。两者解耦是为了：窄屏 toggle 抽屉不被 normalize 立即覆盖，回到桌面时桌面偏好完整恢复。
- **工作流与计划边界**：员工上下级、引用许可、步骤条件与任务交接格式属于公司级配置，项目暂不覆盖公司工作流；项目只配置计划任务、任务领取清单和运行状态。所有项目工具页复用同一个三栏外壳，子工具页不得重新出现全局顶栏。
- **内联 style**：历史代码大量 `style={{...}}`，新增复杂区块优先抽 `.details-collapse` 等语义类进 `global.css`；简单 grid/gap 保留内联可接受。
- **工作台改动约束**：
  - 改三栏布局/栏宽/折叠阈值，同步三处：`global.css` 的 `--work-left`/`--work-right`/`--work-surface-min` + `useWorkbenchPreferences.ts` 的 `normalizeWorkbenchPreferencesForWidth`/`MIN_WORKBENCH_SURFACE_WIDTH` + 响应式断点（1179px/819px）。桌面栏位收起只由 normalize 决定，移动抽屉开关只由 ephemeral `drawers` 状态决定——两者不可交叉干预，否则窄屏 toggle 会被立即覆盖。
  - 左栏"更多"用内联展开列表（`work-nav-more-list`），**不要**用 `position:absolute` popover——左栏 `overflow:auto` 会裁剪。
  - `⌘K` 命令面板选项经 `WorkbenchShell` 的 `commandOptions` prop 注入，按 `group` 分组渲染；项目页/`ProjectToolPageShell` 各自传入上下文相关选项，全局选项（首页/新建项目/蓝图库/归档/智能体库/执行器/权限/审批/设置）由 shell 自动追加。
  - 工作台相关测试：`workbench-shell.spec.tsx`（壳层/抽屉/命令面板）、`workbench-preferences.spec.ts`（偏好 normalize/toggle 语义）、`project-workbench.spec.tsx`（左栏导航）、`project-context-layout.spec.tsx`（任务工作面+右栏）。改左栏分组/文案/视图时同步这些测试。
  - 改产品流程（如项目创建后是否直接进工作台 vs onboarding wizard）会连锁影响 E2E：`smoke.spec.ts`、`regression.spec.ts`、`product-completion.spec.ts` 假设了特定入口路径，流程变更后需同步断言。

旧 Leader/Worker/Verifier、临时群聊、`.muster/config.json` 文件持久化等已全部废弃，不再参与运行。

## Related Projects

| Project | Description | Relevance |
|---------|-------------|-----------|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Agent personas & skills source | Current `agents/` + `skills/` derived from this |
| [jnMetaCode/superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) | 20 AI work methodology skills (Chinese) | Expand skills library |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | 211 AI expert personas (46 Chinese originals) | `personas/` imported from this |
| [jnMetaCode/agency-orchestrator](https://github.com/jnMetaCode/agency-orchestrator) | Multi-agent orchestration engine | DAG parallel execution patterns |
| [jnMetaCode/shellward](https://github.com/jnMetaCode/shellward) | 8-layer security middleware | Sandbox blacklist patterns inspired by this |
| [jnMetaCode/ai-coding-guide](https://github.com/jnMetaCode/ai-coding-guide) | 66 Claude Code tips & best practices | Optimize prompts & workflows |

## iHome API 接入规则

- iHome API 以 `/Users/master/Project/iHome/docs/Api规范/` 为唯一规范源。
- 收到 iHome API 变更通知时，先读 `变更通知/INDEX.md` 筛选出 `must_check` 项，再只读对应通知文件，不要整包加载全部规范。
- 本项目维护一份"实际使用的 iHome API 清单"，每次变更先搜索这些端点。
- STT WebSocket 必须发送 16kHz / 16bit / mono PCM 分片；浏览器 MediaRecorder 的 webm/opus 不能直接按 PCM 发。

## 指令入口约定（不可随意修改）

- `CLAUDE.md` 是本项目唯一主指令文件。
- `AGENTS.md`、`GEMINI.md` 只能保留 `@CLAUDE.md` 引用和本约定说明，不得复制、分叉或新增独立规则。
- 执行 /init、刷新项目记忆或更新 agent 规则时，只更新 `CLAUDE.md`。
- 如果其他入口文件已有更具体内容，必须先合并回 `CLAUDE.md`，再把入口文件恢复为 `@CLAUDE.md`。


## Supabase 数据库迁移约定（不可随意修改）

本节是项目数据库操作契约。任何 AI、脚本或协作者不得删除、弱化或绕过本节规则，除非用户在当前任务中明确要求修改该约定。

- 不默认使用 `supabase db push`。只有在确认本地 `supabase/migrations` 与远端 `supabase_migrations.schema_migrations` 历史完全一致时，才允许使用。
- 新增 Supabase migration 必须使用官方时间戳命名：`YYYYMMDDHHMMSS_description.sql`。优先通过 `supabase migration new <name>` 生成文件；不得再手写 `067_xxx.sql` 这类连续数字新迁移。
- 已有短编号历史 migration 保留不动，不为整理账本而重命名旧文件；从本约定生效后，所有新迁移一律使用官方时间戳形式。
- 远端执行优先使用 Supabase MCP `apply_migration`，并使用与本地 migration 文件一致的 migration name；没有 MCP 时使用 `supabase db query --linked --file supabase/migrations/<file>.sql`。
- 如果项目使用共享 Supabase 或双数据库，必须同时遵守项目级数据库路径和部署说明，并在所有目标数据库执行对应 SQL。
- 每次远端迁移后必须执行验证 SQL，确认关键列、函数、约束、RLS/policy、数据修复结果已经落库。
- 不主动执行 `supabase migration repair`、不手动改 `supabase_migrations.schema_migrations`，除非用户明确发起“迁移历史整理/修复”专项任务。
- 不把 Supabase access token、数据库连接串、service role key、数据库密码写入代码、文档、migration 或日志输出。
