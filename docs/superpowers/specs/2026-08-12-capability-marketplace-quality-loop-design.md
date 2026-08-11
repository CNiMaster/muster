# 能力商城与质量反馈闭环 设计

**日期**：2026-08-12
**状态**：设计稿（待实现）
**关联 PRD**：`docs/PRD-agent-company-workbench.md` — Execution and Capability Model / Skills and Templates
**关联设计**：`docs/superpowers/specs/2026-07-26-capability-platform-design.md`（能力平台，子系统 B/C）、`docs/superpowers/specs/2026-08-09-plugin-optout-governance-design.md`（插件治理）
**关联代码**：`src/server/domain/marketplace.ts`、`src/server/domain/plugin-install.ts`、`src/server/domain/tool-recommendation.ts`、`src/server/executors/tool-assembly.ts`、`src/server/executors/tools/mcp/`、`src/shared/plugin.ts`

## 背景

muster 的能力平台已经搭得相当完整：统一的 `Plugin` 模型覆盖 `skill | mcp-server | tool | bridge-action | ai-generated`（`src/shared/plugin.ts:17`），MCP 集成是**最成熟的扩展面**——`McpClientPool` 支持 stdio/sse/http 三传输（`mcp/client-pool.ts:93`），adapter 把每个 MCP 工具注册成 `mcp_<serverId>__<toolName>` 的 RuntimeTool（`mcp/adapter.ts:66`），`tool-assembly.ts:33` 在任务期自动 connect→probe→注册，挂了就标 unhealthy 跳过。

问题在于**"商城"目前只是两个壳**，且缺质量反馈闭环与跨类型推荐。用户要的"推荐安装、手动加源、MCP 接进来能用"——"用"已经通了（MCP 管道），缺的是**"发现哪个能力干什么事、它好不好用、任务缺什么该补哪个"**。本设计在不重写 Plugin 模型的前提下，补上策展注册表、一键安装、质量反馈闭环和跨类型缺口推荐这四层。

## 真实缺口（带代码证据）

1. **没有真正的注册表**
   - `marketplace.ts` 只有两个来源：`searchLocalSkills` 扫 `~/.zcode/skills` 的 `SKILL.md`（`:35`），`searchGithub` 直接 `gh search repos "<q> skill OR mcp"` 按 star 判成熟度（`:105`）。没有版本、签名、依赖图、能力标签、质量信号。所谓"商城"目前是 POC。

2. **GitHub 条目"安装"根本不 clone**
   - `installMarketplaceEntry`（`marketplace.ts:153`）对 GitHub 条目只记一个 ref 标 `experimental` 等人工确认（`:171`）。"推荐安装"无法真正安装。

3. **无质量反馈闭环**
   - `PluginStatus` 只有 `available|enabled|disabled|error`，MCP 有 `healthCheckedAt`/`healthError`，但**没有使用率、成功率、耗时、评分**。"推荐"≠"真好用"。maturity 在安装时钉死，之后只在 GitHub 条目上恒为 `experimental`。

4. **跨类型推荐缺失**
   - `tool-recommendation.ts:35` 的 `resolveToolRecommendations` 只覆盖 `tool_registry` 条目；没有"这个任务该启用 MCP server X"或"你缺 skill Y"的判断。

5. **plugin 与 tool_registry/capability_binding 双模型并存**
   - 设计文档与 `plugin_backbone.sql:3` 明说旧表被包成只读 Plugin 视图、待后续批次决定迁移。`tool-recommendation.ts` 和 `capability-binding.ts` 仍直读旧表。读侧未统一。

## 核心设计

设计原则：**不重写 Plugin 模型，只在其上加层；保留"carrier 不是 provider"哲学，但与之和解**。

### 1. 本地优先的策展注册表（curated registry）

- 一份**随仓库分发、可版本化**的策展 manifest（数据文件 + loader），收录已知优质能力：内建 Skill、常用 MCP server、常用工具档案。每条记录：
  - `kind`（skill/mcp/tool）、`capabilityTags[]`（它满足哪些能力，如 `image-gen`、`speech-to-text`、`pdf-export`、`web-research`）。
  - `installSpec`（MCP：transport/command/args/env/url；CLI：安装命令；Skill：路径/来源）。
  - `dependencies`（如依赖某 CLI、某 API key）、`vetted`（是否人工审核过）、`qualitySeed`（初始质量分）。
- 用户可**手动添加第三方 manifest 源**（本地路径或 URL），合并进注册表。**不做云端 registry**——首版坚持本地优先。

### 2. "审核精品一键装 + 其余仅建议"和解 carrier/provider

- `vetted=true` 的注册表条目支持**一键安装启用**：复用现有 CLI 安装的流式输出模式（`src/server/api/executors.ts` 的 `POST /:manifestId/install` 流式 + 自动探测绑定），MCP 条目走 `POST /api/plugins` 安装 + `POST /api/plugins/:id/test` 探活（`plugins.ts:111`）。
- `vetted=false` / GitHub 搜索结果保持当前行为：**只记 ref、标 `experimental`、人工确认**（即把现有 `marketplace.ts:171` 的"不 clone"正式确立为"未审核条目的预期行为"，而非缺陷）。
- 这样既给"推荐安装"提供了真能装的路径，又不违背"平台不擅自装未授权能力"。

### 3. 质量反馈闭环

- 在 `RuntimeToolRegistry.executeTool`（`registry.ts:1273`）对 MCP 工具调用（及可观测的 skill 启用）埋点：记录 `outcome`（success/fail）、`duration_ms`、关联 `task_id`、`capability_id`。
- 聚合成质量分（成功率、平均耗时、使用次数、最近是否被反复弃用），物化为 `capability_quality` 视图。
- `resolveToolRecommendations` 排序时**用质量分加权**，使推荐反映真实可用性，而非仅凭"已安装/已声明"。
- 质量分极低的能力，inspector 可提示"该能力多次失败，建议更换"（与 [[2026-08-12-subagent-observability-design]] 的失败可见性共享事件来源）。

### 4. 跨类型缺口推荐

- 把推荐从"只覆盖 tool_registry"扩展到 skill/MCP/tool 三类，统一走注册表的 `capabilityTags`。
- 给定任务的 `requiredCapabilityIds`，若公司未启用任何满足该 tag 的能力，**识别为缺口**并推荐注册表中的候选条目（带质量分排序）。这一缺口信号是 [[2026-08-12-task-investigation-capability-provisioning-design]] 任务级缺口自愈的输入。

### 5. 读侧逐步统一（非破坏性）

- 新增的质量/注册表层建在 `Plugin` 模型上。`tool-recommendation.ts` 与 `capability-binding.ts` 仍可直读旧表，但新代码优先走 Plugin + 注册表读侧；旧表的彻底退役留待后续批次，不在本轮强制迁移。

## 数据模型

复用 `plugin` / `company_plugin`，新增轻量层：

- `capability_registry_entry`：策展 manifest 落地表（或首版直接从数据文件加载、不入库）。字段：`id, kind, capability_tags_json, install_spec_json, dependencies_json, vetted, quality_seed, source`。
- `capability_usage_stat`：`capability_id, task_id, outcome, duration_ms, ts`。追加写，用于聚合。
- `capability_quality`（view/物化）：`capability_id, success_rate, avg_duration_ms, usage_count, derived_score, updated_at`。
- 第三方源登记：可复用 `plugin.source='marketplace'` + 一个 `registry_source` 配置表（或首版用配置文件）。

迁移按 CLAUDE.md 约定命名 `YYYYMMDDHHMMSS_<slug>.sql`，纯新增表/列，不动旧数据。

## 变更点（带 file:line）

**后端**
- `src/server/domain/marketplace.ts:153` — `installMarketplaceEntry` 区分 `vetted`（真装）与未审核（记 ref），接入注册表。
- 新增：策展 manifest 数据文件 + loader（如 `src/server/domain/capability-registry.ts`）。
- `src/server/domain/plugin-install.ts:84` — 复用并扩展一键安装路径，支持 vetted MCP/CLI 条目的流式安装。
- `src/server/executors/tools/registry.ts:1273` — `executeTool` 埋点记录 MCP 工具调用结果到 `capability_usage_stat`。
- `src/server/domain/tool-recommendation.ts:35` — 扩展到 skill/MCP/tool 三类，排序消费 `capability_quality`。
- `src/server/api/plugins.ts:244` — marketplace 端点返回注册表条目 + 质量分；新增"手动添加源"端点。
- 新增聚合/物化 `capability_quality` 的刷新逻辑（coordinator 周期触发或写入时增量更新）。

**数据**
- 新增迁移：`capability_registry_entry`、`capability_usage_stat`、`capability_quality`（view）。

## 实现批次

- **B1（能用）**：策展注册表 + vetted 一键装 + 手动添加第三方源。先让"发现 → 装 → 用"的真能装路径打通。
- **B2（好用）**：质量采集（executeTool 埋点）+ `capability_quality` 聚合 + 推荐排序消费质量分。
- **B3（智能）**：跨类型缺口推荐（任务所需能力 → 未启用 → 推荐候选），为 Spec 3 提供缺口信号。

## 验收标准

1. 策展 manifest 加载成功；`vetted=true` 条目可一键安装启用（MCP 能 connect 探活通过、CLI 流式安装并自动绑定）。
2. `vetted=false` / GitHub 条目仍只记 ref、标 `experimental`、待人工确认（行为不退化）。
3. 每次符合条件的 MCP 工具调用产出一条 `capability_usage_stat`；`capability_quality` 正确计算成功率/耗时。
4. `resolveToolRecommendations` 排序受质量分影响：质量差的能力排名下降、质量好的上升。
5. 给定一个公司未启用任何实现的任务能力，系统能从注册表推荐候选 skill/MCP/tool（带质量分）。
6. 手动添加一个第三方 manifest 源后，其条目出现在搜索/推荐中。
7. 治理不变：平台级 vetted 能力默认开启可被公司 disable（沿用 opt-out 治理），未审核条目不擅自启用。

## 不在本轮范围

- 不做云端 registry、代码签名、复杂依赖图求解（首版 `dependencies` 只做提示性展示与缺失告警）。
- 不强制安装（保留"carrier 不是 provider"；一键装仅限 vetted 且仍走权限/审批）。
- 不强制迁移 `tool_registry`/`capability_binding` 到 Plugin 读侧（新旧并存，新代码优先 Plugin）。
- 不做商城的付费/计费（PRD 明确不在首版范围）。

## 与其他 spec 的衔接

- 本 spec 的注册表 + 跨类型缺口推荐，是 [[2026-08-12-task-investigation-capability-provisioning-design]] 缺口自愈闭环里"去哪找现成方案"的能力源。
- 本 spec 的质量采集与 [[2026-08-12-subagent-observability-design]] 的"失败必上报"共享事件来源：能力调用失败既是质量分的负输入，也是可观测失败的一部分。
