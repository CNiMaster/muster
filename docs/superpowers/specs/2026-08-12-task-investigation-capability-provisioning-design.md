# 任务级调查与能力供给循环 设计

**日期**：2026-08-12
**状态**：设计稿（待实现）
**关联 PRD**：`docs/PRD-agent-company-workbench.md` — 需求驱动的项目启动与能力发现 / Execution and Capability Model
**关联设计**：`docs/superpowers/specs/2026-07-26-capability-platform-design.md`（子系统 C，equipping 阶段）、`docs/superpowers/specs/2026-07-17-requirement-driven-project-launch-design.md`（需求驱动启动）
**关联代码**：`src/server/task-engine/engine.ts`、`src/server/domain/capability-binding.ts`、`src/server/domain/project-launch.ts`、`src/server/domain/project-onboarding.ts`、`src/server/sandbox.ts`、`src/server/domain/workflow.ts`

## 背景

muster 在**项目级**已经有完整的"调查 → 装备"硬门：onboarding 状态机 `drafting→researching→equipping→staffing→ready→active`（`project-readiness.ts:27`），`researching→equipping` 必须先有调研报告 + 至少 1 个候选 skill/tool 才放行（`project-onboarding.ts:69-73`），`projectResearchSchema = { summary, candidateSkills[], candidateTools[] }`（`src/shared/project-readiness.ts:20`），启动时 `discoverProjectLaunchCapabilities` 还会逐项检查每个必备能力是否齐全（`project-launch.ts:58`）。还有 `Researcher` 角色模板（`role-templates.ts:36`，skills: research/analysis，tools: web）。

问题在于：**这套"调研→装备"只发生一次，在项目立项时**。一旦项目进入运行期，引擎对每个任务是 `claim → worktree → assembleContext → run`（`engine.ts:_pumpThread:169`），**没有任何"我该怎么干、需要什么能力、齐不齐"的预检**。用户担心的"要识图但公司是空的怎么办"在运行期会真实发生：任务被派出去，agent 跑到一半发现缺工具 → `waiting_input` → 人工介入，这正是"无用功"。

本设计把项目级一次性调研升级为**每个生产任务执行前的持续能力供给循环**，并确立"先借再造、除非迫不得已"的执行原则。它依赖 [[2026-08-12-capability-marketplace-quality-loop-design]] 的能力源，并复用 [[2026-08-12-subagent-observability-design]] 的失败分类语义。

## 真实缺口（带代码证据）

1. **没有 per-task 预检门**
   - `_pumpThread`（`engine.ts:169`）claim 任务后，经 `assertSafeToRun`（约 `:195`）直接进入 `assembleContext`（约 `:259`）再 `run`。`discoverProjectLaunchCapabilities` 只在 launch 跑（`project-launch.ts:58`）。缺能力的任务照样被派出去，agent 中途才发现缺口。

2. **skill 是声明式的、不是检索式的**
   - `resolveTaskSkills`（`capability-binding.ts:24`）只读任务**显式声明**的 `requiredSkillIds`/`knowledgeTargets`/`requiredCapabilityIds`。没声明的（常见，如自动 `[规划]` 任务 `task.ts:1178`）只拿到遗留人设 skill——不会按任务内容去 `skills/` 库检索。

3. **缺口没有自愈闭环**
   - 运行期发现能力缺口后，没有"暂停 → 派 Researcher 去网上/商城/记忆里找最优现成方案 → 提议安装 → 批准 → 续跑"的链路。`externalResearchNeeds` 被记录（`project-launch.ts:103`）但**从不满足、从不追踪**。

4. **没有策略/方法选择器**
   - `agent-router.ts:48` 只选"谁"（按 skill 重叠打分），`tool-recommendation.ts` 只注入工具文档。没人选"策略"（这是调试 → 上 systematic-debugging + 测试工程师 + 绿了再评审）。策略全靠 LLM 读人设 + 注入 skill 后自行决定。

5. **没有原生联网**
   - 完全靠底层 CLI：`sandbox.ts:91-99` 的 `SANDBOX_ALLOWED_TOOLS` 白名单了 Claude Code 的 `WebSearch`/`WebFetch`。**API 模式执行器（OpenAI 兼容/Gemini）彻底没网**，除非某 MCP 提供。

6. **工作流不可复用**
   - workflow 是每公司手画的（`workflow.ts`），没有 SOP 模板库/导入导出——不像 skill/tool/persona 都有 template 注册表。

## 核心设计

把项目级 onboarding 的"research → equip"压缩为**每个任务执行前的预检循环**。主循环：

```
任务 claim
  → 预检门 (approach-check): claim 后、assembleContext 前插入
      1. 这个任务需要哪些能力/skill/策略？现在齐不齐？(确定性检查优先)
      2. 有缺口?
         → 派 Researcher 子任务: 联网 + 商城注册表 + 记忆 找现成方案 (先借再造)
         → 提议安装 (vetted 一键 / 未审核人工批) → 装好后续跑
      3. 齐了?
         → 按内容检索 skill (不只声明) + 选策略 + 派合适角色
  → 执行 (带 Spec 1 的健康监测)
  → 终态反思 → 反哺记忆 + 商城质量分 (Spec 2)
```

### 1. per-task 能力预检门（approach-check）

- 插入点：`_pumpThread` 在 `assertSafeToRun` 之后、`assembleContext` 之前。
- **两层**：
  - **确定性层**（便宜、必跑）：任务的 `requiredCapabilityIds` 是否每个都有可用绑定/工具？执行器是否具备所需 kind（参考 capability probe `capability-probe.ts:38` 的 `hasCommandCapability`）？结果落 `task_precheck`。
  - **语义层**（贵、按需）：仅当确定性层判断为"模糊/疑似缺口"时，才调一次轻量 LLM 判定任务所需能力与策略。避免每个任务都烧一次 LLM。
- 预检不阻塞已明确可执行的任务（快速放行），只对"有缺口"或"声明不全"的任务进入下一步。

### 2. 内容检索 skill（取代纯声明式）

- 给 `resolveTaskSkills`（`capability-binding.ts:24`）增加**内容检索路径**：当任务未显式声明 skill 时，用 FTS（复用 `memory.ts:259` 的 FTS5 模式）在 `skills/` 库 + 已注册 MCP 工具描述里按任务标题/摘要检索，取 Top-K 注入。
- 与现有声明式路径合并（声明优先，检索补全），保持"命中才进上下文"的既有约束。

### 3. 缺口自愈闭环

- 预检判定有缺口时，派一个 **Researcher 子任务**（复用 `Researcher` 角色模板；走 `parentTaskId` + `inputProtocol` 携带缺口描述）：
  - 通过原生联网（见下）+ [[2026-08-12-capability-marketplace-quality-loop-design]] 的注册表/跨类型缺口推荐 + 记忆检索，找最优现成方案。
  - 输出：候选能力 + 安装方式 + 质量/成本提示。
- 提议安装：`vetted` 条目走一键装、未审核走人工审批（沿用 Spec 2 的和解边界）。父任务进入 `waiting_dependency`，装好后续跑。
- **原则落地**："先借再造"——Researcher 的职责是找现成方案，只有现成方案都不行时才建议自造，并标注理由。

### 4. 策略/方法选择器

- 新增一个轻量策略映射：任务形态 → 推荐 skill + 推荐角色原型 + 推荐 playbook/workflow。例如：
  - 调试类 → `systematic-debugging` skill + 测试工程师 + "绿了再评审"。
  - 视觉/图像类 → `image-gen` skill + Designer + `image-campaign` playbook（`playbooks.ts:30`）。
- 策略库以可扩展数据形式存在（skill/playbook/角色模板已经具备），不硬编码 if-else。结果作为建议注入上下文，路由仍走现有 `findBestAssignee`。

### 5. 原生联网（解 API 执行器的盲）

- 提供一个 **builtin web 工具**（search + fetch），让 API 模式执行器也有联网能力；CLI 模式继续白名单其原生 `WebSearch`/`WebFetch`（`sandbox.ts:96-97`）。
- 满足 `externalResearchNeeds`：不再是"记而不满足"，而是预检/Researcher 可消费它来触发联网调研，并追踪其完成状态。
- 联网工具同样受权限/审批治理（与 run_command 一致）。

### 6. SOP/工作流模板库

- 让 workflow 成为可复用资产：新增 workflow 模板注册表 + 导入/导出，与 skill/tool/persona 的 template 注册表对齐。
- 公司模板可自带推荐 workflow 模板；新公司可一键导入。策略选择器（第 4 点）可引用模板。

## 数据模型

- `task_precheck`：`task_id, required_capabilities_json, gaps_json, status (ok|gap|researching|resolved), strategy_hint_json, research_task_id, decided_at`。
- 缺口→研究子任务：复用 `parentTaskId` + `inputProtocol`，无需新关系表；`task_precheck.research_task_id` 做回指。
- skill 内容检索索引：复用 FTS5 基础设施（与 memory 共用或独立 `skill_fts`），覆盖 `skills/` 与 MCP 工具描述。
- `workflow_template`：可复用 workflow 定义（与 `workflow` 表结构对齐 + `template_id`/`source`/`origin` 字段）。

迁移按 CLAUDE.md 约定 `YYYYMMDDHHMMSS_<slug>.sql`，纯新增。

## 变更点（带 file:line）

**后端**
- `src/server/task-engine/engine.ts:169-259` — `_pumpThread` 在 `assertSafeToRun` 后、`assembleContext` 前插入预检门调用。
- `src/server/domain/capability-binding.ts:24` — `resolveTaskSkills` 增加内容检索路径。
- 新增：`src/server/domain/task-precheck.ts`（预检门）、`src/server/domain/strategy-recommender.ts`（策略选择器）、`src/server/domain/capability-gap-resolver.ts`（缺口自愈派 Researcher + 提议安装 + 续跑）。
- `src/server/domain/project-launch.ts:103` — `externalResearchNeeds` 由"记录"改为"可满足 + 可追踪"。
- `src/server/sandbox.ts:91-99` / 新增 builtin web 工具（`src/server/executors/tools/`）— 为 API 执行器提供联网。
- `src/server/domain/workflow.ts` + 新增 `workflow-template` 注册表 — 可复用 workflow。
- `src/server/executors/tools/context.ts:142,210` — 注入预检结论 + 策略建议 + 检索到的 skill。

**数据**
- 新增迁移：`task_precheck`、`skill_fts`（或复用）、`workflow_template`。

## 实现批次

- **B1（能预检）**：per-task 预检门（确定性层）+ skill 内容检索。先让"任务执行前知道自己缺什么、相关 skill 自动命中"。
- **B2（能自愈）**：缺口自愈闭环（Researcher 子任务 + 商城注册表 + 提议安装 + 续跑）+ 原生联网（解 API 盲）+ `externalResearchNeeds` 可满足。
- **B3（更智能）**：策略/方法选择器 + SOP/workflow 模板库（可复用、可导入）。

## 验收标准

1. 任务 claim 后、`assembleContext` 前存在预检记录（`task_precheck`），明确可执行的任务快速放行（不无谓烧 LLM）。
2. 未显式声明 `requiredSkillIds` 的任务，能按内容从 `skills/` 检索到相关 skill 并注入。
3. 能力缺口的任务触发 Researcher 子任务；Researcher 借助联网 + 商城注册表 + 记忆给出候选；批准安装后续跑。
4. API 模式执行器具备联网能力（builtin web 工具或默认 MCP 可用）；`externalResearchNeeds` 状态可被追踪到"已满足"。
5. 给定任务形态，策略选择器给出 skill + 角色 + playbook/workflow 的推荐组合并注入上下文。
6. workflow 可保存为模板，并在新公司导入复用。
7. 不违背 PRD 边界：不擅自安装未授权能力、不自动执行头脑风暴建议、不替代项目级 onboarding。

## 不在本轮范围

- 不强制安装任何能力（保留权限/审批边界）。
- 不替代项目级 onboarding（预检是 onboarding 在运行期的延续，不是替代）。
- 不自动执行调研结论/建议（仍走提议 + 审批，与 PRD "讨论结论只形成建议"一致）。
- 不重写 `_pumpThread`，只在其内增加预检插点。

## 与其他 spec 的衔接

- **依赖 [[2026-08-12-capability-marketplace-quality-loop-design]]**：缺口自愈里"去哪找现成方案"的能力源来自该 spec 的策展注册表 + 跨类型缺口推荐；安装走其一键装/审批边界。
- **复用 [[2026-08-12-subagent-observability-design]]**：预检与执行期复用其 `FailureCategory`——执行期判为 `capability_gap` 的失败触发"补能力"而非"重试"；Researcher 子任务的健康也受其临时工观测覆盖。
- 三份 spec 共同构成"能力供给智能 + 可观测性"系统：**装备前会查（本 spec）、装备来源可信（商城 spec）、执行中可监控（观测 spec）**。
