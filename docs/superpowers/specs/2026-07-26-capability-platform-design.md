# 能力与流程平台：插件骨干 + 项目准备流程

> 日期：2026-07-26
> 状态：总架构已批准，B1 骨干批次进行中
> 关联：`2026-07-17-requirement-driven-project-launch-design.md`（任务级 launch gate，本设计的下层正交）

## 真实缺口

muster 已经有「任务执行器」(员工领 Task → 工具循环 → 产物)，也已经在任务级补上了「需求确认 + 能力发现」闸门(`ProjectLaunchGate`)。但三件事卡住了下一阶段的演进：

1. **能力接入无法真正运行**。现存三套机制（Skill / Tool Registry / Bridge action）都是「只读档案」注入 prompt，Agent 读了自行安装使用。没有运行时工具注册，没有 MCP，没有 AI 生成能力的落地路径。`file-tools.ts` 的 7 个工具是硬编码 switch，是接入外部能力的总闸，但写死。
2. **项目级准备阶段缺失**。Project 自身的 `ProjectState`(`idle/active/paused/completed/archived`) 几乎闲置，没有「立项 → 调研 → 装备 → 员工就位 → 确认 → 开工」的阶段概念。现有的准备流程做在 ProjectTask 层，每个工作单都走一遍，重复且与项目级调研脱节。
3. **流程无法回流**。superpowers 靠人工改 plan 文件 + 3 次失败熔断回流，muster 没有显式的「PlanVersion」和「阶段回流」建模，任务卡住就是卡住。

## 用户路径

```
项目立项 → drafting(构思) → researching(调研/资料源)
        → equipping(装备能力) → staffing(员工就位) → ready(确认)
        → active(开工，进入任务级 launch gate + 执行)
        ↑_________________________↓
                任意阶段可回流（手动 / 3次失败自动 / scope 变更）
```

能力消费贯穿全程：drafting 可能需要「头脑风暴」skill，researching 需要「网页检索/browser」plugin，equipping 显式启用/生成能力，active 阶段员工消费已装备能力执行任务。

## 四子系统与接口契约

```
        ┌─────────────────────────────────────────────┐
        │  C. 项目准备流程 (Project Onboarding Flow)    │
        │  drafting → researching → equipping →        │
        │  staffing → ready → active                   │
        │  产出：spec / research / equipment /         │
        │  staffing / readiness                        │
        └──────────┬──────────────────────┬────────────┘
                   │ 调用 B 装备            │ 产出 readiness 给 D
                   ▼                      ▼
   ┌──────────────────────┐     ┌──────────────────────────┐
   │ B. 能力发现与采购      │     │ D. 编排与状态机           │
   │ 来源：系统预制/执行器   │     │ - HARD-GATE 闸门          │
   │  自带/公司项目专属/    │     │ - lifecycle 事件驱动       │
   │  AI 生成               │     │ - 回流(revise-plan)       │
   │ 产出：Plugin 引用       │     │ - 3 次失败熔断              │
   └──────────┬─────────────┘     └──────────────────────────┘
              │ 装入
              ▼
   ┌──────────────────────────────────────────┐
   │ A. 能力骨干 (Plugin Backbone)              │
   │ - Plugin 统一模型                          │
   │ - 运行时工具注册表（替换 FILE_TOOLS 写死）  │
   │ - MCP Client 层（B3 批次）                  │
   │ - ExecutionContext 注入点                  │
   └──────────────────────────────────────────┘
```

子系统间**只通过 3 个契约对象通信**：
- `Plugin` — 能力的统一形态（B → A 的载荷）
- `ProjectReadiness` — 准备就绪证明（C → D 的载荷）
- `Plan` + `PlanVersion` — 计划与修订（D 内部 + C ↔ 执行）

## 子系统 A：能力骨干（Plugin Backbone）

### A.1 Plugin 统一模型

新增 `src/shared/plugin.ts`。把现存 Skill / Tool Registry / Bridge action 都视为 Plugin 的特例，零迁移；新 MCP / AI 生成走统一模型。

```ts
interface Plugin {
  id: string;
  name: string;
  kind: 'skill' | 'mcp-server' | 'tool' | 'bridge-action' | 'ai-generated';
  source: PluginSource;
  scope: PluginScope;
  manifest: SkillManifest | McpServerManifest | ToolManifest | BridgeActionManifest;
  permissions?: string[];
  credentialKeys?: string[];       // 复用 tool-registry 的 credential_keys 模式
  status: 'available' | 'enabled' | 'disabled' | 'error';
  healthCheckedAt?: string;
  healthError?: string;
  maturity?: 'experimental' | 'stable' | 'deprecated';
}

type PluginSource =
  | { kind: 'builtin' }
  | { kind: 'executor-native'; provider: string }
  | { kind: 'company'; companyId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'marketplace'; registry: string; ref: string }
  | { kind: 'ai-generated'; generatedAt: string; prompt: string };

type PluginScope =
  | { level: 'platform' }
  | { level: 'company'; companyId: string }
  | { level: 'project'; projectId: string }
  | { level: 'employee'; agentId: string };   // 替换现有 agent.tools / agent.skills 字符串数组
```

### A.2 RuntimeToolRegistry（B1 核心）

现状：`file-tools.ts:51` 写死 7 个工具，`executeFileTool`(`file-tools.ts:234`) 用 switch 分发，default 分支直接返回「未知工具」。改造为注册表，借鉴 `bridge.ts:37` 的「单一事实来源注册表」模式。

```ts
// src/server/executors/tools/registry.ts
interface RuntimeTool {
  definition: ToolDefinition;     // 复用现有 OpenAI function calling 格式
  handler: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  permissionAction?: 'read-file' | 'write-file' | 'execute-command' | 'network';
  source: { pluginId: string; toolName: string };
}

interface ToolContext {
  workingDir: string;
  readonlyDirs: string[];
  loopback?: { baseUrl: string; taskId: string };
  reviewContext?: ReviewContext;
  permissionGuard?: PermissionGuard;
  toolRegistry: RuntimeToolRegistry;   // 自引用，handler 可调用其他工具
}

class RuntimeToolRegistry {
  register(tool: RuntimeTool): void;
  resolve(name: string): RuntimeTool | undefined;
  definitions(): ToolDefinition[];     // 给 adapter 注入模型
}
```

7 个内置工具变成注册表里的 7 个 RuntimeTool；MCP 工具、自定义工具、AI 生成工具都按同一接口注册。`executeFileTool` 改为查表分发，沿用现有 permissionGuard(`file-tools.ts:255-261`) + `isWithinWorkspace` 路径校验。`runToolLoop` 的 `const tools = FILE_TOOLS`(`tool-loop.ts:79`) 改为 `ctx.toolRegistry.definitions()`。

### A.3 MCP Client（B3 批次）

新增 `src/server/executors/tools/mcp/`。第一版仅 stdio 本地 server（覆盖 browser-use / 小红书场景），HTTP/SSE 后续。MCP server 的 tools 适配成 RuntimeTool 注册进 `ctx.toolRegistry`。生命周期跟随 task：`pumpThread` 时按 project/agent 拉起所需 server，对齐 watchdog idle timeout(`engine.ts:349`)，超时由 watchdog 兜底。凭据沿用三层解析(`engine.ts:993-1010`)。

### A.4 plugin 表

新增 migration（遵循 CLAUDE.md 官方时间戳命名）。建 `plugin` 表（id / name / kind / source_kind / source_ref / scope_level / scope_id / manifest_json / permissions_json / credential_keys_json / status / health_checked_at / health_error / maturity / timestamps）+ 索引。**现有 `tool_registry`(0029) 和 `capability_binding`(0027) 数据不动**，通过适配器视图暴露为 Plugin。遵循「上班期间组织配置锁」：插件启停需 `company.state === 'off'`(`company.ts:245`)。

## 子系统 B：能力发现与采购（B3 批次）

四来源启用流程，对应「去哪找技能」：

| 来源 | 流程 | 信任级别 |
|------|------|---------|
| builtin | 直接列出 `plugin where source_kind='builtin'`，一键启用 | 默认 stable |
| executor-native | 探测 `agent.executor.provider` 的 skill store（如 claude-cli 的 `~/.claude/skills`），注册为 Plugin(scope=employee) | 跟随执行器 |
| company/project | 从 marketplace 检索（GitHub `gh search` / 本地 `~/.zcode/skills`）+ 新建 | marketplace 默认 experimental，首启需人工确认 |
| ai-generated | 检测到能力缺口 → 用 skill-creator 起草 SKILL.md → 落盘 → 自动健康检查 → 通过才 available | experimental，可晋升 |

第一版不建中心化市场，而是接入现有生态（GitHub / 官方 MCP registry / 本地 `~/.zcode/skills`）。

## 子系统 C：项目准备流程（B2 / B4 批次）

### C.1 Project 状态机扩展

`project.ts:32` 的 `ProjectState` 扩展：

```ts
type ProjectState =
  | 'drafting'    // 新增：需求构思（spec 起草中）
  | 'researching' // 新增：调研（竞品/技术选型/资料源）
  | 'equipping'   // 新增：能力装备（启用 plugin/生成 skill）
  | 'staffing'    // 新增：员工就位（招募/分配工位）
  | 'ready'       // 新增：准备就绪（待用户最终确认开工）
  | 'active'      // 现有：开工
  | 'paused'      // 现有
  | 'completed'   // 现有
  | 'archived';   // 现有
```

新建项目默认进 `'drafting'`（`project.ts:100` 改），保留 `'idle'` 作为兼容值或一次性迁移。**两层正交**：Project 级粗粒度准备，现有 ProjectTask launch gate 保留做每个工作单的细粒度确认。

### C.2 六阶段（借鉴 superpowers 异步化）

| 阶段 | 借鉴 superpowers | muster 异步化改造 | 出口产物 |
|------|------------------|-------------------|---------|
| drafting | brainstorming（一次一个问题） | 改为「调研问卷」批量下发，或员工拉取 | `spec.md` |
| researching | brainstorming 的「2-3 方案 + trade-off」 | 扩展为多类调研：竞品/技术选型/**资料源调查**（免费图源/调用方式）/风险登记 | `research.md` |
| equipping | （无对应） | 启用/生成 Plugin，跑能力 readiness check（复用 `discoverProjectLaunchCapabilities`） | `equipment.md` |
| staffing | （无对应） | 复用 `RecruitmentWizard` + `ensureProjectThreads` | `staffing.md` |
| ready | spec/plan 自审 + 用户 review gate | 自动跑「准备就绪检查清单」；用户最终确认才进 active | `readiness.json` |
| active | writing-plans → executing | 进入现有任务执行流，**任务级 launch gate 仍生效** | （进入 D） |

### C.3 回流机制（对应「任务有难度可回流」）

补 superpowers 缺失的「显式 PlanVersion」。`ProjectPhaseHistory` 记录每次阶段进出：`{ phase, enteredAt, exitedAt, outcome, rollbackFrom?, rollbackReason?, artifacts }`。

回流触发：
1. **自动**：任务连续失败 3 次（对齐 `systematic-debugging:195`）→ Project 自动回 `researching` 或 `equipping`
2. **手动**：用户/项目经理在任何阶段点「回到 X 阶段」
3. **scope 变更**：drafting 的 spec 被修订 → invalidate 后续阶段产物，equipping/staffing 需重做

前端 `ProjectPage.tsx:282` 的 `ProjectDetail` 加条件分支：
- `state ∈ {drafting, researching, equipping, staffing, ready}` → 渲染新的 `ProjectOnboardingWizard`（stepper，复用 `CompanySetupWizard.tsx:14` 的 `STEPS` 模式）
- `state === 'active'` → 现有 `WorkbenchShell`

stepper 顶部显示六阶段进度条（借鉴 `CompanySetupWizard` 的 `setup-step-dot`），**每阶段可点回**（可回流的可视化）。

## 子系统 D：编排与状态机（B5 批次）

### D.1 HARD-GATE 闸门

新增 `src/server/domain/project-readiness.ts`。每个状态跃迁有进入条件，服务端硬校验：

```ts
function assertCanTransition(project, target: ProjectState): void {
  // drafting → researching: spec.md 非空 + 通过 spec 自审
  // researching → equipping: research.md 非空 + 至少一个候选能力
  // equipping → staffing: 所有 requiredCapability 都 ready
  // staffing → ready: 至少 1 个员工 + 所有工位已 ensure thread
  // ready → active: ProjectReadiness 通过 + 用户最终确认
  // 任何 → 任意前序阶段: 允许（回流）
}
```

派工闸门：现有 `task.ts:225` 的 `assertProjectLaunchConfirmed` 旁加 `assertProjectActive(projectId)`——项目未 active 不能派工。

### D.2 Lifecycle 事件扩展

`lifecycle-events.ts:4` 增加（仿 `project-task.*` 命名）：
- `project.phase-entered` — `{ projectId, phase, previousPhase, rollbackFrom? }`
- `project.phase-exited` — `{ projectId, phase, outcome }`
- `project.readiness-passed` — `{ projectId, readiness }`
- `project.rollback` — `{ projectId, from, to, reason }`
- `plugin.installed` / `plugin.enabled` / `plugin.disabled` / `plugin.health-failed`

这些事件**驱动前端 stepper 刷新** + **触发后续阶段**（不再是纯通知）。

### D.3 Plan 与 PlanVersion

```sql
CREATE TABLE project_plan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  spec_ref TEXT,
  plan_doc_ref TEXT,
  created_by TEXT,
  created_reason TEXT,     -- 'initial' | 'rollback-3x' | 'scope-change' | 'manual'
  status TEXT DEFAULT 'draft',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version)
);
```

任务对象的 `plan_task_id`（对应 plan checkbox）关联到具体 version。

## 实现批次（总 spec 锁接口，批次只锁实现）

| 批次 | 范围 | 依赖 | 完成标准 |
|------|------|------|---------|
| **B1 骨干** | A.2 RuntimeToolRegistry + A.4 plugin 表 + 适配现有 3 源 | 无 | FILE_TOOLS 改注册表无回归；新工具能注册；plugin 表已建 |
| B2 流程骨架 | C.1 状态机 + D.1 闸门 + 空 wizard | B1 | 新建项目进 drafting，六阶段 stepper 可走通（内容空） |
| B3 能力接入 | A.3 MCP + B 四来源 | B1 | 能挂 stdio MCP server，能从 marketplace 装 skill |
| B4 准备内容 | C.2 六阶段产物 + C.3 回流 + 前端 wizard | B2 + B3 | 走完准备流程产出 spec/research/equipment/staffing |
| B5 编排 | D.2 lifecycle + D.3 PlanVersion | B4 | 3 次失败自动回流，plan 版本可追溯 |
| B6 AI 生成 | B 的 ai-generated + 健康检查 | B3 | 检测能力缺口 → AI 起草 skill → 测试 → 启用 |

**每个批次开工前用 writing-plans 细化为 bite-sized 任务**，避免遗忘。

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Plugin 新概念 vs 统一现有 | **统一现有**（Skill/Tool/Bridge 都变 Plugin 特例） | 零迁移现有 23+5+4 个能力；避免认知负担 |
| FILE_TOOLS 改注册表 vs 保留 | **改注册表**，内置工具变注册项 | 这是接入 MCP/自定义工具的总开关；bridge.ts 已验证此模式 |
| Project 流程 vs 任务级流程 | **两层正交**：Project 粗粒度 + ProjectTask 细粒度 | 避免重复；Project 状态机闲置正好用 |
| 流程严格线性 vs 可回流 | **可回流，显式建模 PlanVersion** | 补 superpowers 缺失，符合「灵活」诉求 |
| 借鉴 superpowers 同步对话 | **异步化改造** | muster 是多员工异步平台，不能阻塞等单条回复 |
| MCP 第一版范围 | **仅 stdio 本地 server** | 务实，覆盖 browser-use/小红书场景；HTTP/SSE 后续 |
| AI 生成 skill 时机 | **准备阶段检测缺口时主动触发** | 符合「自动执行最好」诉求 |

## 关键约束（贯穿所有批次）

- 遵循 CLAUDE.md：Supabase migration 用官方时间戳命名；不删旧迁移；远端执行用 `apply_migration` 并验证
- 遵循「上班期间组织配置锁」：插件启停需 `company.state === 'off'`
- 路径安全沿用 `isWithinWorkspace` + `readonlyDirs`
- `permissionGuard` 钩子对新工具生效
- MCP/工具执行不阻塞超 watchdog idle timeout(`engine.ts:349`)
- 凭据沿用三层解析(`engine.ts:993-1010`)
