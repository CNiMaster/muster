# API 能力扩展 + Agent 间沟通渠道：详细实现计划

**日期**：2026-08-10（v2，含 review 修复 + 已落地实现）
**状态**：第一部分（API 能力扩展）已实现；第二部分（agent 间沟通渠道）方案 A 实现中、方案 B 待定
**前置**：`2026-08-10-executor-capability-and-agent-communication-design.md`（设计文档）

---

## 一、API 能力扩展（已实现）

### 1.1 已落地的实现清单

| 子项 | 文件 | 状态 |
|------|------|------|
| 沙盒加固：黑名单补解释器包装/变量展开 | `src/server/sandbox.ts` | ✅ + 单测 `tests/unit/sandbox.spec.ts`（8 测试） |
| 沙盒加固：isWithinWorkspace realpath 防 symlink 逃逸 | `src/server/sandbox.ts` | ✅ |
| bridge prompt 死指令 bug 修复（按 kind 分化） | `src/server/bridge.ts`、`context.ts`、`engine.ts` | ✅ |
| opencode 审批加固（注入 deny 守卫） | `src/server/executors/opencode-cli-adapter.ts`、`manifests.ts` | ✅ + 6 测试 |
| 能力探针 capability-probe 模块 | `src/server/domain/capability-probe.ts` | ✅ + 8 测试 |
| 能力探针 connection-probe 分支 + 迁移 + REST | `connection-probe.ts`、`20260812020000_capability_probe.sql`、`api/executors.ts` | ✅ |
| 能力矩阵前端徽章 + 能力边界提示 | `ExecutorCenterPage.tsx`、`shared/executor.ts` | ✅ |
| 派发校验：REQUIRES_CLI_SKILLS + 引擎软提示事件 | `context.ts`、`engine.ts`、`lifecycle-events.ts` | ✅ |

### 1.2 Review 修复的真 bug

- **能力探针吞错误 bug**（review 才发现）：原 `runApiCapabilityProbe` 的 function calling try/catch 吞掉所有 ApiProbeError，导致认证失败/模型不存在/网络错误时返回全 false 能力矩阵而非立即失败。已修复为：`ApiProbeError` 必须上抛，只有非 ApiProbeError 的业务错误才降级为 functionCalling=false 继续测其他项。
- **capability cache_key 不含 model**：不同 model 能力不同，原 cache key 在 capability 模式 model 恒为 null。已修复为 capability 模式也按 profile.config.model 缓存。
- **REST kind 枚举漏 'capability'**：已补。

### 1.3 能力矩阵数据模型（已实现）

```ts
interface CapabilityProbeResult {
  functionCalling: boolean;      // 请求带 tools 时是否返回 tool_calls
  toolLoop: boolean;             // 工具结果回填后能否收敛
  structuredOutput: boolean;     // response_format / responseMimeType 是否生效
  instructionLevel: 'low'|'medium'|'high';
  supportedTasks: string[];
  unsupportedTasks: string[];
  note: string;                  // 人话能力边界说明
}
```

### 1.4 探针探测项（已实现）

1. **function calling + 工具循环**：发要求调用 `echo` 工具的请求 → 检查 tool_calls/functionCall → 回填结果 → 第二次请求验证收敛。
2. **结构化输出**：带 `response_format: {type:'json_object'}`（openai）/ `responseMimeType: application/json`（gemini）验证返回合法 JSON。
3. **指令遵循等级**：标准提示"只回复 MUSTER_CAPABILITY_OK"→ high（精确）/ medium（包含）/ low（不相关）。

### 1.5 UI 展示（已实现）

执行器中心"已绑定执行器"卡片：API 型显示"测试能力"按钮 + 4 个能力徽章（函数调用/工具循环/结构化输出/指令遵循）+ 可展开的可执行/不可执行任务清单 + 人话能力边界说明。

---

## 二、Agent 间沟通渠道

### 2.1 方案 A：任务内咨询 `ask_colleague`（实现中）

**目标**：agent A 执行任务时，向同事 B 发起结构化咨询，B 回复后 A 继续原任务（不产生新任务链）。

#### 2.1.1 数据模型（不新建表，复用现有 task + task_message）

- 咨询 = 一个特殊 Task（`task.kind='consultation'`，或 inputProtocol 里带 `consultation:true` 标记）。
- 复用 `task.parent_task_id`（A 的 task 是 parent）、`task.assignee_agent_id`（B）。
- 回复通过 `task_message`（role='dispatch'）回填到 A 的 recentDiscussion。

#### 2.1.2 工具定义

```jsonc
{
  "name": "ask_colleague",
  "description": "向同事员工发起一次结构化咨询。对方回复后本任务继续执行。用于请求信息、方案探讨、确认依赖。不要用于派活（派活用 done 的 outboundTasks）。",
  "parameters": {
    "type": "object",
    "properties": {
      "recipient_agent_id": { "type": "string", "description": "被咨询的员工 id" },
      "question": { "type": "string", "description": "咨询内容（尽量具体）" },
      "context_refs": { "type": "array", "items": { "type": "string" }, "description": "可选：供对方只读引用的文件路径（worktree 内）" }
    },
    "required": ["recipient_agent_id", "question"]
  }
}
```

#### 2.1.3 执行流程

1. A 调 `ask_colleague` → `executeTool` 在 registry handler 内创建咨询 Task（parent=A.task，assignee=B，inputProtocol={consultation:true, question, contextRefs, askerTaskId}）。
2. A 的工具循环**阻塞**等待（返回 tool result 前 await）—— B 领取并完成咨询 Task。
3. B 领取咨询 Task → assembleContext 注入 question + contextRefs（只读挂载 A 的 worktree 路径到 readonlyDirs）→ B 执行回复（done 工具返回 summary 作为回复内容）。
4. B 完成 → 引擎把 reply 写回 A 的 task_message（role='dispatch'）→ 解除 A 的工具循环阻塞 → A 收到 reply 作为 tool result 继续原任务。

#### 2.1.4 边界与防护

- **B 忙**：咨询 Task 排队（复用现有排队），A 阻塞等待有超时（如 10 分钟）。
- **B 不可用**（离职/offline）：咨询 Task 超时 → A 收到"对方不可用" → A 可降级为 done(waiting_dependency) 或继续。
- **循环咨询**：复用 `isDispatchLoop`（A→B→A 回环阻断）。
- **权限**：ask_colleague 动作走 permissionGuard，新增 action `consultation`（非 HIGH_RISK，默认 allow 但记审计）。
- **contextRefs 路径安全**：只读挂载 A 的 worktree 路径，经 isWithinWorkspace 校验（已加固 realpath）。

#### 2.1.5 涉及文件

- `src/server/executors/tools/file-tools.ts`：加 ask_colleague 工具定义。
- `src/server/executors/tools/registry.ts`：注册 handler（创建咨询 Task + 阻塞等待回复）。
- `src/server/executors/tool-loop.ts`：tool result 等待机制（已有，咨询 handler 返回 Promise 即可）。
- `src/server/domain/task.ts`：咨询 Task 创建 + 完成时回填 task_message 到 parent。
- `src/server/executors/context.ts`：咨询 Task 的 assembleContext 注入 question + contextRefs readonlyDirs。
- `src/server/task-engine/engine.ts`：咨询 Task 完成后通知 parent 解除阻塞。

### 2.2 方案 B：独立探讨线程（待定，复杂度高）

**目标**：项目级"讨论室"，多员工异步串行发言，结论压缩回项目（派 Task / 写 memory / 产 artifact）。

**复杂度评估**：新 3 张表（discussion / discussion_participant / discussion_turn）+ 发言轮转调度 + conclude_discussion 结论分发 + 前端讨论室 UI。**建议方案 A 验证价值后再做**。

---

## 三、后续未做项（P1/P2，另立计划）

| 优先级 | 项 | 说明 |
|--------|----|------|
| P1 | API 型 Bash 工具 | 注册 bash 工具到 registry，复用黑名单 + classifyCommand + permissionGuard，使 API 执行器能力对齐 CLI |
| P1 | 能力标准字段落地到 frontmatter | 把 REQUIRES_CLI_SKILLS 迁移到 SKILL.md frontmatter `requiresExecutor` 字段 |
| P2 | API 工具循环硬校验 | 未知工具/纯文本回复/坏参数加校验与纠正重试 |
