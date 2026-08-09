# Plugin Opt-out 治理设计（Skill / MCP 多层级管控）

**日期**：2026-08-09
**状态**：已实现
**关联迁移**：`20260809100000_plugin_optout_scope.sql`

## 背景

Muster 的 Skill / MCP Server / 工具统一为 `Plugin` 模型（`src/shared/plugin.ts`），通过 `plugin` 表 + `company_plugin` 关联表管理。迁移前是 **opt-in 语义**：平台插件需逐公司手动启用才生效（`company_plugin.enabled=1`），新公司默认无任何能力——这与用户期望相反。

**用户需求**：
1. Skill / MCP 默认对所有公司可用，可单独关闭某公司
2. 公司专属 skill 可独立指定给某公司（"公司独占绑定"）
3. 独立管理页，每个插件后有各公司开关；公司多时用列表管理

## 核心设计：opt-out「行存在即决策」语义

### 数据模型

`company_plugin` 表增加 `decision` 列（`'enabled' | 'disabled'`，迁移 `20260809100000`）：

| 行状态 | 含义 |
|--------|------|
| 无行 | 公司对该插件**未做显式决策** → 平台插件走默认（全开） |
| `decision='disabled'` | 公司**显式禁用**该插件 → 不生效 |
| `decision='enabled'` | 公司曾显式确认启用（审计痕迹，与无行效果相同） |

历史 `enabled` 列保留，迁移时回填：`enabled=0 → disabled`，`enabled=1 → enabled`。

### Effective 计算公式

```
effective(companyId, plugin) =
  case plugin.scope.level:
    'platform' → NOT EXISTS(companyId 的 decision='disabled' 行)
    'company'  → plugin.scope.companyId === companyId
                 AND NOT EXISTS(companyId 的 decision='disabled' 行)
    _          → false（project/employee scope 本轮不处理）
```

实现：`getEffectivePluginsForCompany(db, companyId)`（`plugin-install.ts`）—— 平台插件 MINUS 禁用集 ∪ 公司独占插件 MINUS 禁用集。

### 三态标注（UI 用）

`CompanyPluginDecision = 'default' | 'enabled' | 'disabled' | 'exclusive'`：
- **default**：平台插件，无覆盖行（默认全开）
- **enabled**：平台插件，有显式启用痕迹
- **disabled**：被该公司显式禁用
- **exclusive**：公司独占插件（scope=company）

## 变更点

### 后端
- **迁移** `20260809100000_plugin_optout_scope.sql`：`company_plugin` 增 `decision` 列 + 部分索引
- **`plugin-install.ts`**：
  - `setCompanyPluginDecision(db, companyId, pluginId, 'enabled'|'disabled')`（新，替代 `setCompanyPluginEnabled`）
  - `listDisabledCompanyPlugins(db, companyId): Set<string>`（opt-out 热路径）
  - `getCompanyPluginDecisions(db, companyId): Map`（三态查询）
  - `getEffectivePluginsForCompany(db, companyId): Plugin[]`（核心计算）
  - `listEnabledCompanyPlugins` 保留但内部转 effective（向后兼容）
- **`plugin-adapter.ts`**：`listPlugins` 增 `scopeLevel` / `scopeCompanyId` 过滤
- **`tool-assembly.ts`**：`assembleTools` 改用 `getEffectivePluginsForCompany`（行为变化：未配置公司现在默认加载所有平台级 MCP）
- **`api/plugins.ts`**：
  - `GET /api/companies/:companyId/plugins/effective`（三态标注列表）
  - `GET /api/plugins/company-scoped/:companyId`（公司独占插件）
  - `POST /api/companies/:companyId/plugins/exclusive`（安装公司独占插件，强制 scope=company）
  - enable/disable 路由改写 decision（enable=撤销禁用，disable=写 disabled）

### 前端
- **`api/types.ts`**：`CompanyPluginDecision`、`EffectivePlugin` 类型
- **`hooks/queries.ts`**：`useEffectiveCompanyPlugins`、`useCompanyScopedPlugins`、`useInstallExclusivePlugin`
- **`pages/CapabilityCenterPage.tsx`**（新）：能力中心管理页
  - Tab 按 kind 分类（Skill / MCP / 工具 / Bridge）
  - 每插件行展开后是公司开关矩阵（≤6 家横排，>6 家折叠+搜索）
  - 三态视觉 + 组织配置锁提示
- **路由** `/capabilities` + 导航入口「能力中心」

## 行为变化（需注意）

**迁移前**：新公司默认不加载任何 MCP server（opt-in）。
**迁移后**：新公司默认加载所有平台级 MCP server（opt-out），除非显式禁用。

这是用户期望的行为，但对已存在的「未配置 MCP」公司会突然开始尝试连接所有平台 MCP。若平台 MCP 配置不全（如缺 command），`tool-assembly` 会非致命地跳过（`markPluginHealth` + log），不影响任务执行。

## 与下一轮（B2B 跨公司外包）的衔接

本轮建立的「公司级能力可见性」是 B2B 的前置条件：
- B2B 的"接受方公司"需要能加载其 effective 插件来执行外包任务（`assembleTools(companyId)` 已支持）
- B2B 决策树（内部能做吗→外包→招聘）的"内部能做吗"判断可复用 `capability_binding`（已存在但无人查询）
- 公司独占插件（如 `legal-contract-v2`）让"专业公司"具备专属能力，为 B2B"系统内有没有更适合的公司能外包"提供数据基础

## 不在本轮范围

- B2B 跨公司任务委派（contract 实体、共享工作目录、产物回传）—— 下一轮
- project/employee 级 scope 的运行时过滤（框架已存在，本轮只做 platform/company 两级）
- 批量预取优化（公司极多 >50 时，effective 查询应改为单次 SQL JOIN 而非 N 次查询）
