# 执行过程展示（Execution Trace Display）设计

> 日期：2026-08-15 ｜ 分支：`execution-trace-display`
> 对应 PRD：`docs/PRD-agent-company-workbench.md`（看板/任务详情章节之后新增「执行过程展示」段）

## 背景

muster 本质是一个 Agent 框架：执行器在跑（工具循环 / Claude Code 等 CLI），但「执行过程」对用户是黑盒。已有的展示只覆盖三件事：任务状态事件（event-feed 白名单）、协作摘要（ActivityPanel）、终态成果（task.artifacts + ArtifactsPage）。用户想看的三类信息——**运行了什么工具、编辑了什么文件、产生了什么图片**——在「执行中」维度全部缺失，且缺的是两层：数据层不落库、展示层无组件。

展示范式对齐 Claude Code / OpenCode / Pi Agent：过程流在中间列（工具调用卡片、淡化思考块、Skill 调用徽章），状态在右栏；默认折叠、想查能查；按类型批量展开/收起且全局记忆；蜂群维持树状列表；失败蜂自动修复（重发/换思路）。

## 现状（file:line 证据）

### 已有的「过程近似物」
- 关键事件流：`src/server/domain/event-feed.ts:24-40`（14 种状态事件白名单）→ `api/events.ts` → `EventFeedList.tsx` / `CompanyActivity.tsx` / `DashboardPage.tsx:243`。展示的是任务生命状态，不是过程明细。
- TaskDetailPage 右栏：`EventsCard`（`TaskDetailPage.tsx:347-361`，只 kind 徽章+时间，不展开 payload）、「成果变更」卡片（`:158-170`，终态文件清单）、`SwarmTreeCard`（`:199-252`，缩进树+状态着色+停群）。
- 协作活动流 `ActivityPanel.tsx`（@A→@B 派发摘要）；`ArtifactsPage.tsx` 终态产物多媒体渲染。
- Agent Bridge：`bridge.ts:39-83` 注册 progress/notify/preview 三动作，prompt 注入（`buildBridgePromptSection`）。

### 缺口（本设计要补的）
- **工具调用**：只进执行器内存（`tool-loop.ts:100-227` messages 局部数组）或 debug 日志（`engine.ts:616-618` onOutput/onToolCall 只 log.debug）；落库仅聚合计数（`usage_record.tool_calls`、`capability_usage_stat`）。前端零渲染。
- **文件编辑**：只有终态 artifacts 声明；过程 write_file/edit_file 不留痕（handler 在 `file-tools.ts:134-164`）。
- **图片/中间产物**：终态可见，执行中不可见；bridge preview 通道是死的——`bridge.ts:170` 只 realtime.publish 不落库，前端 `realtime.ts:29-31,91-96` 只消费 notify toast，preview/progress 发出即消失。
- **思考**：请求侧已有（`openai-adapter.ts:67-81`、`gemini-adapter.ts:53-77` 的 reasoning/thinking 参数，`thinking-params.ts` 深度归一化），响应侧未提取；CLI 的 vendor transcript（`~/.claude/projects/<cwd>/<sessionId>.jsonl`）已在跨 worktree 拷贝（`claude-code-adapter.ts:454-492`）但从未解析。
- **蜂群失败**：task 级 auto-retry 只覆盖可恢复会话错误（`task.ts:1024-1043`）；蜂失败走 `handleSwarmTaskFailure`（`swarm.ts:436-448`）→ 告警调度中心人工处置，无「换思路重发」。
- 无 trace/step/execution-log 表；`run-isolation.ts:14-18` 预留的 `runs/<runId>/logs` 目录无代码写入；测试层对「过程被展示」零断言。

## 关键决策（用户已拍板）

1. **展示形态**：过程流内嵌 TaskDetailPage 主列（摘要下方新增「执行过程」时间线卡片），右栏维持信息/蜂群/事件历史——「过程在中间、状态在右栏」。
2. **思考完整纳入**：有数据就展示（默认折叠），没有自然没有；思考深度调节入口已有（设置革新 B3 的 thinkingDepth），不重复造。
3. **默认折叠、想查能查**：payload 默认折叠；「展开同类/收起同类」按 kind 批量操作；偏好存 localStorage 每 kind 一 key，全局跨任务记忆。
4. **蜂群不搞画布**：维持现有派出列表+树状任务状态；本轮只加「失败蜂已重发」标记与跳转；重点补失败自动修复（重发/换思路）。
5. **不引新前端依赖**：时间线用现有 Card/entity-list/全局样式实现。

## 数据层设计（批次 1）

### 新表 execution_trace（不污染 task_event 状态机语义）

```sql
-- 20260815080000_execution_trace.sql
CREATE TABLE execution_trace (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,                    -- execution_run.id，可空（bridge/notify 事件可能无 run）
  seq INTEGER NOT NULL,           -- 任务内自增序号
  kind TEXT NOT NULL CHECK (kind IN
    ('thinking','text','tool_call','tool_result','file_edit','progress','preview','notice','error')),
  name TEXT,                      -- 工具/Skill 名（tool_call/tool_result/file_edit 有值）
  summary TEXT,                   -- 一行摘要（时间线条目默认显示这行）
  payload_json TEXT,              -- 详情（args/result/路径等，已截断）
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_execution_trace_task ON execution_trace(task_id, seq);
```

领域模块 `src/server/domain/execution-trace.ts`（仿 `task-event.ts` 模式）：
- `appendTrace(db, { taskId, runId, kind, name, summary, payload })`——内部取 nextSeq、截断 payload（单字段 ≤8KB 标记 truncated）、超 500 条先裁最老 `tool_result`。
- `listTrace(db, taskId, { kind, before, limit })`——时间正序/过滤/分页。
- `publishTraceAppended(event)`——调 realtime.publish 推 `trace.append`。

### 写入点（全部挂现成钩子，不新增执行链路）

| 来源 | 挂点 | 产出 kind |
|---|---|---|
| API 执行器循环 | `tool-loop.ts:120-189`（assistant message / tool call / tool result / catch） | thinking / text / tool_call / tool_result / error |
| CLI 执行器 | `engine.ts:615-618` onOutput / onToolCall | text（按间隔聚合）/ tool_call |
| CLI thinking | vendor transcript JSONL 解析（`claude-code-adapter.ts:454-492` 已拷贝的文件）：执行中定时 tail + 结束后全量补齐 | thinking |
| 文件编辑 | `file-tools.ts:134-164` write_file/edit_file handler | file_edit |
| 预览/进度/通知 | `bridge.ts:141-173` GET handler + notify_host（`file-tools.ts:57-84`） | preview / progress / notice |
| 蜂群重发 | 批次 4 的自动修复 | notice |

API 路径的 thinking 需扩展：`ChatMessage`（`tool-loop.ts:28-37`）加 `thinking?: string`，openai adapter 从响应 reasoning 提取、gemini adapter 从 thoughts 提取；模型无数据则字段缺省，前端自然不显示。

CLI 路径的 tool_result：onToolCall 只有 name+input，无结果回调——结果与 thinking 同走 transcript 解析通道（解析 tool_result 块按 tool_use id 关联补录），执行中定时 tail + 结束后全量补齐；解析失败则只展示调用不展示结果（条目标注「结果未捕获」）。

## 展示层设计（批次 2）

### 布局与条目

- `TaskDetailPage.tsx` 主列、摘要 Card 之后插入 `<ExecutionTraceCard taskId />`；运行中卡片头部显示「思考中/调用工具/运行中」徽章+心跳点，终态显示耗时/工具轮数（usage 数据现成）。
- 条目渲染（时间线，倒序展示最新在上）：
  - `thinking`：灰斜体折叠块「💭 思考中…」，点击展开全文，**默认折叠**。
  - `tool_call`：`● name(参数摘要)` 卡片，展开显示完整 args + 关联 tool_result；来源徽章（内置/MCP/Skill/插件，数据来自 RuntimeToolRegistry source）。
  - `tool_result`：默认并入所属 tool_call 的展开区，独立条目仅在无关联 tool_call 时渲染。
  - `file_edit`：`✏ path（write/edit）` 卡片，展开看片段。
  - `text`：assistant 直接输出文本块。
  - `progress` / `notice`：轻量条目（左侧竖线+文案）。
  - `preview`：图片缩略图内嵌（路径走现有 artifact 读取接口），点击灯箱放大。
  - `error`：红色边框条目。
- **折叠交互**：卡片头部「展开同类/收起同类」按钮按 kind 批量操作；每 kind 展开态存 localStorage key `mu-trace-expand:<kind>`，全局跨任务记忆。
- **实时**：服务端 `trace.append` realtime 事件；`realtime.ts:9-66` 的 `queryKeysForRealtimeEvent` 增加 `['task-trace', taskId]` 映射，执行中增量渲染。

### 蜂群树增强（同批次，轻）

`SwarmTreeCard` 保持现有结构；失败蜂若已被自动修复重发，节点显示「已重发 → #新蜂号」链接；不引画布。

## API 设计

- `GET /api/tasks/:id/trace?kind=&before=&limit=`（`api/tasks.ts` 增端点，与 `/events` 并列）→ `{ items: TraceItem[] }`。
- `TraceItem`（`src/shared/types.ts`）：`{ id, taskId, runId, seq, kind, name, summary, payload, truncated, occurredAt }`。
- 前端 hook `useTaskTrace`（`hooks/queries.ts`），query key `['task-trace', taskId]`。

## 蜂群失败自动修复设计（批次 4，最小闭环）

现况：蜂失败 → `handleSwarmTaskFailure` 记账/告警/解除依赖 → 调度中心人工决定补蜂。缺口：不可恢复失败（逻辑错误等）无自动「换思路重发」。

设计（尊重熔断与预算，不放大失控）：
1. `failTask` 收尾时，蜂任务（`task.swarm_id` 非空）失败且不可重试（`isRecoverableSessionError` 为假或 auto-retry 已耗尽）→ 进入自动修复评估。
2. 预算：每蜂最多重发 1 次（新蜂任务不再重发，防递归）；全群重发上限 `swarmRepairMax`（系统设置键，默认取 swarmMaxNodes 的 1/3 向下取整）——超限维持现告警。
3. 重发：`createWorkerBee` 新蜂，inputPacket 注入失败蜂的 summary + 最近 task_reflection 教训（换思路依据，复用 reflection 沉淀通道）；新蜂计入 swarm_run 计数（nodes_total+1）。
4. 留痕：原蜂追加 `superseded_by` 标记（swarm_run 或 task 字段），`appendTrace(notice)`「蜂成员失败 → 已换思路重发 #新号」，`appendTaskEvent('swarm_bee_repair_dispatched')`。
5. 熔断不变：失败 >50% 或预算超限 → 现有熔断路径。

## 不在本轮范围

- 蜂群画布（树列表已满足，画布另议）。
- token 级流式输出（text 按间隔聚合，不做打字机）。
- diff 级文件对比（file_edit 只显示路径+操作+片段）。
- trace 的跨任务聚合查询（只做单任务时间线）。
- 执行器安装 SSE 日志的改造（已实现，不动）。

## 数据模型汇总

1 个迁移：`20260815080000_execution_trace.sql`（execution_trace 表 + 索引）。
系统设置新键：`swarmRepairMax`（蜂群自动修复上限，走现有六步链 setting.ts → api/settings.ts → queries.ts → SettingsPage）。
蜂群字段：task 行加 `superseded_by`（指向重发新蜂的 task id，可空；蜂群树靠它渲染「已重发 → #新号」标记）。

## 测试

- integration：`tests/integration/execution-trace.spec.ts`——API 路径 tool-loop 桩落 trace（thinking/text/tool_call/tool_result/error）、bridge preview/progress 落 trace、file_edit 落 trace、`GET /api/tasks/:id/trace` 过滤分页、超 500 条裁剪；`tests/integration/swarm-repair.spec.ts`——蜂失败自动重发（预算/换思路注入/superseded 标记/熔断不受影响），并回归现有 `swarm.spec.ts` 断言不破坏。
- unit：`tests/unit/execution-trace-card.spec.tsx`——折叠/同类展开/localStorage 记忆、各 kind 渲染、realtime key 映射。
- e2e：TaskDetailPage 执行过程可见（沿用 product-completion 框架，1 条冒烟路径）。

## 实施批次

1. **B1 数据层**：迁移 + execution-trace.ts + 全部写入点（API 循环/bridge/file-tools/CLI 回调）+ GET API + integration 测试。
2. **B2 展示层**：ExecutionTraceCard + 折叠/同类展开/全局记忆 + realtime 映射 + unit/e2e 测试。
3. **B3 thinking**：ChatMessage 扩展 + openai/gemini adapter 响应侧提取 + CLI transcript 解析补录。
4. **B4 蜂群自动修复**：swarmRepairMax 设置 + 重发/换思路/留痕 + swarm-repair 测试 + 树节点标记。
