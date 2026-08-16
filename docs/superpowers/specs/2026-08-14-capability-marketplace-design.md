# 能力商城（Marketplace）发现与安装设计

> 日期：2026-08-14 ｜ 分支：`capability-marketplace`
> 对应 PRD：`docs/PRD-agent-company-workbench.md` line 377（能力商城）、line 352/385（权限边界）

## 背景与现状（file:line 证据）

PRD 377 定义的能力商城 = **发现并引入** Skill 与配套能力（MCP、工具档案）：策展精品可一键安装、第三方来源可手动添加、所有条目带能力标签/安装方式/依赖/质量信号，使用结果回流修正推荐排序。

现状（已做，全部可复用）：

- **插件模型 + 安装骨架**：`plugin` 表（migration `20260726071905_plugin_backbone.sql`，kind 枚举 `skill/mcp-server/tool/bridge-action/ai-generated`），`installPlugin()` 的 source 已预留 `marketplace`（`src/server/domain/plugin-install.ts:48`）；`GET/POST /api/plugins`、`POST /api/plugins/:id/test` 测试连接齐全（`src/server/api/plugins.ts:11-21`）。
- **治理面（已装管理）**：`/capabilities` 能力中心（`src/client/pages/CapabilityCenterPage.tsx`）——分类 tab、公司三态开关矩阵、健康状态；入口 `SettingsPage.tsx:157` 深链。
- **质量回流后端**：`capability-quality.ts`（`recordCapabilityUsage` / `getAllCapabilityQuality`——成功率/耗时/弃用信号）。
- **检索/安装管道（B3b，前端零消费）**：`src/server/domain/marketplace.ts`——`searchLocalSkills`（默认扫 `~/.zcode/skills`）、`searchGithub`（gh CLI，安装仅登记不拉取）、`installMarketplaceEntry`；API `POST /api/plugins/marketplace/search|install`（`plugins.ts:245,267`）。

**缺口 = 发现面 + 一条关键注入链断裂**：

- 无预置策展目录、无商城页、无官方源接入（MCP Registry / anthropics 官方 repo）、github 安装是空壳、质量信号读侧未消费。
- **plugin 表 skill 无消费路径**：`resolveTaskSkills`（`capability-binding.ts:100` `readBundledSkill`）只读仓库内置 `skills/` 目录，不读 plugin 表——现在装的 marketplace skill 永远不会进任务上下文（装了白装）。MCP 是生效的（`assembleTools` → `getEffectivePluginsForCompany`）。**M1 必须打通 plugin skill → resolveTaskSkills 注入链，否则商城 skill 空转。**

## 执行原则：用哪个无所谓（多执行器现实）

muster 无法决定最终使用哪份能力，也不该尝试：

- muster 注入途径 = 把 SKILL.md 正文**拼进系统提示**（`executors/context.ts:145`）——纯文本兜底。
- CLI 执行器（claude-code/codex/opencode）有自己的 skill 目录 + 内置技能，加载什么、分布在哪 muster 看不到也控制不了（system-scan 只能探测一部分）。
- API 执行器（openai/gemini）无任何原生 skill——muster 注入是唯一来源。

**产品立场：用哪个无所谓，任务达成是唯一判据。** CLI 用它自己的 = 白赚；muster 注入 = 兜底保证"能力一定在"。由此三条管理推论：

1. 安装状态文案用「muster 已安装」——只承诺"本系统已装入、可兜底注入"，不承诺"必被使用"。
2. CLI 环境同名能力（system-scan 探测到）**不算冲突、不拦安装**，仅作可折叠旁注："你的 {CLI} 环境也检测到同名能力——CLI 用它自己的不影响目标，muster 副本给其他执行器兜底"。纯信息，不参与任何裁决。
3. 跨环境 MCP 工具重名（muster spawn 的与 CLI 自带的重名）不自动裁决，靠能力中心现成三态开关交给用户手动取舍，安装提示里说明。

## 三项关键决策

1. **来源要精：只接官方**。v1 四源：`anthropics/claude-code`（官方插件 market）、`anthropics/skills`（官方 Skills）、`registry.modelcontextprotocol.io`（官方 MCP Registry，REST API）、`modelcontextprotocol/servers`（官方参考 MCP）。社区聚合站（mcp.so/glama/pulseMCP）**不接**——数据参差、反爬、评分不可信；`claude-plugins-official`（claude.com）有公开不稳定 issue（anthropics/claude-code#22310）不主接。**不做 ~/.zcode 插件缓存扫描**（用户拍板：zcode 是本地特殊软件非主流；预置内容与装没装 zcode 解耦。既有 `searchLocalSkills` 保留为"本地目录"手动源，不扩展）。
2. **分类 = Skill / MCP Server / 工具 / 插件**（对应 plugin.kind 现有枚举）。**智能体包不进商城 v1**：`anthropics/knowledge-work-plugins` 这类"岗位插件包"与员工库/团队模板（TeamPackPicker/role-templates 已于 08-16 删除，语义现对应智能体库/人设库 243 人设）语义重叠，归属员工系统另议（见"不在本轮范围"）。
3. **策展优先于镜像**：商城首页默认展示**预置策展目录（人工精选 ~10 个官方精品，pin commit/tag）**；官方 Registry 是搜索后的"延伸浏览"，不是全量镜像。这同时是安全策略：预置条目 pin 版本防上游劫持；第三方来源手动添加 → 未审核标记 → 权限清单 + 用户确认才可装（沿用 PRD 352/385 边界）。

## 目标体验（验收锚点）

新用户：进「能力中心 → 发现」→ 看到精选条目（质量徽章/权限清单可见）→ 一键安装 → 装完回「管理」tab 启用/按公司开关 → 用过后质量信号回流、条目排序随时间变化。

## 数据模型

### 预置策展目录（静态数据，`src/shared/marketplace-presets.ts`）

前端渲染 + 后端安装校验共用同一份（单一事实源），条目形状：

```ts
interface MarketplacePreset {
  id: string;                    // 稳定 id，如 'mcp-official-filesystem'
  name: string;
  kind: 'skill' | 'mcp-server' | 'tool' | 'bridge-action';
  source: { kind: 'github' | 'mcp-registry'; ref: string; pin: string }; // pin = commit sha / release tag / 版本
  description: string;
  tags: string[];                // 能力标签（搜索/筛选）
  install:                     // 安装定位
    | { type: 'raw-skill'; url: string }            // raw.githubusercontent.com/.../SKILL.md
    | { type: 'plugin-json'; url: string }          // .claude-plugin/plugin.json
    | { type: 'mcp-command'; command: string; args: string[]; env?: Record<string,string> };
  permissions: string[];         // 权限清单（脚本/命令/文件写入/外部连接）——安装前展示
  curatedBy: 'anthropic' | 'modelcontextprotocol';  // 策展方（白名单校验依据）
}
```

首版策展清单（M1 数据，可增删；Claude Code 官方插件目录在 M3 以 marketplace.json 接入——13 个插件可浏览、安装映射为 skill 注入）：

- Skill（来自 `anthropics/skills`，Document Skills 分类）：`docx` / `pdf` / `pptx` / `xlsx`（官方文档技能四件套）
- MCP（来自 `modelcontextprotocol/servers` 官方参考实现）：`filesystem`（@modelcontextprotocol/server-filesystem）、`git`（uvx mcp-server-git）、`github`（@modelcontextprotocol/server-github）、`postgres`（@modelcontextprotocol/server-postgres）
- 插件（来自 `anthropics/claude-code` `.claude-plugin/marketplace.json`）：`commit-commands`（git 提交工作流）、`pr-review-toolkit`（PR 评审）→ 映射为 bridge-action/tool

### 远端来源接入（M3，表 `marketplace_source`）

```
marketplace_source (
  id TEXT PRIMARY KEY,            -- 'mcp-registry' | 'anthropics-skills' | 'claude-code-plugins' | 用户添加的 URL
  kind TEXT NOT NULL,             -- 'official' | 'manual'
  endpoint TEXT NOT NULL,         -- REST API base / git url / registry url
  refreshed_at TEXT,
  created_at TEXT NOT NULL
)
```

- `mcp-registry`：`GET https://registry.modelcontextprotocol.io/v0/servers`（分页、搜索）→ 归一化为 `MarketplaceEntry`（含 namespace 认证名、安装命令、能力列表）。官方建议 aggregator 低频拉取（每小时）——我们做**手动刷新 + 展示来源与更新时间**，不自动定时（不替用户消耗网络）。
- `anthropics-skills` / `claude-code-plugins`：拉 GitHub raw（`marketplace.json` / 目录清单），同样归一化。
- 拉取结果**只作浏览**；安装时按条目 `pin` 取对应版本内容。

### 质量信号读侧（M4，无新表）

复用 `getAllCapabilityQuality(db)`（成功率/耗时/弃用）→ 商城条目卡片挂质量徽章（如「稳定 92% 成功率」「被反复弃用」），排序权重 = 策展分（官方精品 > 官方普通 > 未审核）+ 质量分。**排序只影响展示，不自动装、不自动推荐安装**（PRD 352：推荐不越过用户确认）。

## 分类体系与排版规范（条目多，靠结构消化）

商城不按来源平铺，按**能力类型为一级、用途为二级**组织，三级全部落进条目标签（搜索/筛选用）。一级分类 = `plugin.kind` 现有枚举（ai-generated 不进商城，属系统自生成自管理）：

| 一级（tab） | 二级分组 | 例 |
|---|---|---|
| **Skill 技能** | 文档处理 / 开发与测试 / 创意设计 / 企业沟通（沿官方 anthropics/skills 分类） | docx、pdf、pptx、xlsx、webapp-testing |
| **MCP Server 连接器** | 文件与代码仓库 / 数据库与 API | filesystem、git、github、postgres |
| **插件（命令与工作流）** | 开发工作流 | commit-commands、pr-review-toolkit |
| **工具 Tool** | 按用途（v1 若为空则整 tab 隐藏，不摆空壳） | 单工具档案 |

排版规范（商城页统一卡片，保证"多而不乱"）：

- 顶部：一级分类 tab（含数量）+ 全局搜索框 + 来源过滤（官方 / 全部）。
- 卡片固定字段顺序：**名称 + 来源徽章**（Anthropic 官方 / MCP 官方 / 手动·未审核）→ 描述（两行截断）→ 标签 chips → 底栏：质量徽章 + 安装状态。
- **安装状态直接显示在卡片上**（已安装 ✓ → 去管理 / 可安装 / 同名冲突 ⚠）——用户不用点进去才知道重复。
- 每个二级分组标题带来源说明一行（"以下条目来自 Anthropic 官方 skills 仓库"）。
- 详情抽屉：权限清单、安装方式、依赖、来源与更新时间、质量明细。

## 同名去重与冲突解决（用户已装过 ≠ 重复装出两份）

**现状风险**：`plugin` 表对 `name` 无唯一约束；执行时 `getEffectivePluginsForCompany`（`plugin-install.ts:213`）只按 id 去重——muster 内部同名两条都注入 = 上下文重复浪费 + 版本打架。且仓库自带 `skills/` 内置技能目录（只读视图），与商城同名条目天然可能撞名。**v1 规则：muster 内部不允许同名并存**（注意：这是"muster 内部"的去重，不涉及 CLI 环境——后者按「执行原则」旁注处理，不算冲突）。

### 身份键

`(kind, normalize(name))`：skill 取 SKILL.md frontmatter 的 name，MCP 取 server 名，统一 trim + 小写比较。

### 安装时（三层判定）

1. **同名同源**（registry+ref 相同）→ 卡片显示「已安装 ✓」，API 拒绝重复安装（409 + 现有条目 id），前端按钮变「去管理」。
2. **同名异源**（如仓库内置/本地 vs 商城官方，或两个不同商城源）→ 卡片显示「同名冲突 ⚠」；安装弹窗列出两边对比（名称/来源/scope/启用状态），给两个选择：
   - **安装并停用现有同名条目**（推荐，默认）：新条目落库，同时对所选 scope 写 `company_plugin` 禁用旧条目（只读视图条目同样可用此表 opt-out 禁用，复用现机制）。
   - 取消。
3. 无同名 → 正常安装（官方直接装；未审核来源先展示权限清单 + 确认）。

### 执行时兜底（防历史脏数据二义）

`getEffectivePluginsForCompany` 增加**按 (kind, normalize(name)) 去重**的防御层：实体 plugin 行 > 只读视图条目；同为实体行时保留 `updated_at` 最新一条并 `log.warn` 告警。`resolveTaskSkills` 同理：skill 命中先查 plugin 表（该公司生效且启用），再回退 bundled 目录。这样 muster 注入侧永远只有一个 winner，不产生二义上下文；CLI 环境用了哪份不在其内（见「执行原则」）。

## 安装流（复用 + 扩展 installMarketplaceEntry）

```
发现（预置/搜索）→ 详情（描述/标签/依赖/权限清单/质量徽章/已装状态）
  → 一键安装（来源白名单校验：官方直接装；未审核条目弹权限确认）
  → 拉取 manifest（raw-skill 读 SKILL.md；plugin-json 解析；mcp-command 写 McpServerManifest）
  → installPlugin(source={kind:'marketplace', registry, ref}) 落库
  → toast + 跳「能力中心-管理」继续配置（MCP 可跑 /:id/test 测连接）
```

现有 `installMarketplaceEntry` 的 local 分支保留；github 空壳分支替换为上述真实拉取。**所有条目安装前展示权限清单**（PRD 385：脚本/命令/文件写入/外部连接必须可见并批准）。

## 前端（M2）

- 新页 `/marketplace`（路由 `src/client/main.tsx`）：三块——① 策展精品区（预设条目卡片，质量徽章 + 已装状态）② 搜索（本地目录 + MCP Registry + 官方 repo，来源分组显示）③ 已装管理入口（去 `/capabilities`）。
- `CapabilityCenterPage` 顶部加「管理 | 发现」双入口互链（不新增顶栏入口，改版后顶栏已收敛）。
- 条目详情展开：权限清单、安装方式、依赖、来源 + 更新时间。
- 已装条目显示"已安装 ✓ → 去管理"，防重复安装。

## 实现批次

- **M1 预置策展目录 + 注入链 + 去重**：`shared/marketplace-presets.ts` 数据（含分类/来源/权限清单/pin）+ **打通 plugin skill → `resolveTaskSkills` 注入链**（先查 plugin 表生效 skill，回退 bundled 目录——否则商城 skill 装了白装）+ 后端 `listMarketplacePresets(db)`（返回每条的「muster 已安装」状态与 muster 内部同名冲突标记）+ 安装路径（raw 拉取 SKILL.md / plugin.json / mcp-command，安装前三层判定 + 停用旧条目）+ `getEffectivePluginsForCompany` 同 (kind,name) 去重兜底 + 测试（白名单校验、pin 拉取、同源拒装、异源冲突停旧装新、**安装的 skill 在任务执行时真实进入上下文**、执行侧 winner 唯一）。
- **M2 商城页**：`/marketplace` 页（分类 tab + 二级分组 + 统一卡片 + 状态徽章 + 搜索/来源过滤 + 详情抽屉 + 冲突弹窗）+ hooks + 能力中心「管理 | 发现」双入口 + e2e（浏览 → 详情 → 安装 → 管理页出现；重复安装被拒；冲突弹窗停旧装新）。
- **M3 官方源接入**：`marketplace_source` 表 + MCP Registry API 客户端（含超时/错误降级）+ 官方 repo 拉取 + 搜索归一化（同样带已装/冲突标记）+ 测试（mock registry 响应）。
- **M4 质量信号读侧**：quality 聚合进条目卡片/排序权重 + 测试（质量变化 → 排序变化）。

## 验收标准

1. 预置条目 ≥10 个全部可一键安装；同源重复安装返回 409 且卡片显示「muster 已安装」。
2. muster 内部同名异源安装触发冲突弹窗，「安装并停用旧条目」后：新条目生效、旧条目禁用、注入侧 (kind,name) winner 唯一。
3. **商城安装的 skill 在真实任务执行时进入上下文**（resolveTaskSkills 命中 plugin 表）；MCP 安装后 spawn 生效。
4. 商城搜索能返回 MCP Registry + 官方 repo 结果并正确分组、可浏览详情；已装/冲突状态在卡片上直接可见。
5. 安装后的条目出现在能力中心管理页、可启用/禁用/测连接。
6. quality 数据变化后商城条目排序随之变化。
7. typecheck + 全量测试 + e2e 全绿。

## 不在本轮范围

- **智能体包 / 岗位插件包**（与员工系统重叠，员工库另议导入）。
- ~/.zcode 插件缓存扫描（已拍板不做）。
- 社区聚合站全量镜像（只留 M4 展示字段的可能，不作数据源）。
- 插件更新/卸载 UI（已装治理后续轮次）、用户评分系统（社区信号，后续轮次）。
