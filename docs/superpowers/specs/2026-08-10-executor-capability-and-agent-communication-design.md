# 执行器能力矩阵调研 + API 能力探针设计 + Agent 沟通渠道设计

**日期**：2026-08-10
**状态**：调研结论文档（含两份设计，均待实现）
**范围**：只出设计与结论，不改代码。实现需另立计划。

---

## 一、背景与决策记录

用户提出四个问题，本调研基于代码证据逐一回答：

1. 接入 API 时能否操作本地文件？通过什么实现？
2. 能否复刻现有软件（CLI 执行器）的全部功能？
3. 有无必要内置开源 agent（如 OpenCode / Pi）？
4. 多 Agent 协同相比单独使用 CLI 的增量价值（卖点验证）；API 能力如何测试与提示；Agent 间是否应有沟通渠道。

**决策记录**（用户已确认）：

| 议题 | 决策 |
|------|------|
| 内置开源 agent（opencode/pi） | **不内置**。直接连接官方 CLI，pass-through 哲学延续；内置引入两套 agent 循环与两套权限模型冲突，且需跟随上游迭代 |
| 给 API 执行器补能力（Bash 工具等） | 应该做，但**对 API 供应商/模型有要求**，能力不足需向用户明确提示 |
| API 能力探针 + 能力矩阵 + 派发提示 | **纳入设计**（本文档第二部分） |
| Agent 沟通渠道 | **只出设计不实现**（本文档第三部分），后续再决策 |

---

## 二、调研结论 A：多 Agent 协同卖点验证（成立）

### A1. 并行执行（真实并行）

- 引擎并发泵：`engine.ts:1023-1032`（`pumpAll`，`Promise.all` 并行，默认并发上限 4，`MUSTER_CONCURRENCY` 可调）。
- 每 Task 一个独立 git worktree + 独立 CLI 子进程（`engine.ts:251`；`worktree/manager.ts`）；多线程并行 = 多 CLI 进程并行。
- 执行器级并发控制：`run-isolation.ts:22-37`（`parallel` 默认并发 / `profile-serial` 按档案串行 / `global-serial` 全局串行）。
- 原子领取防重复：`task.ts:408-466`（`BEGIN IMMEDIATE` + `UPDATE ... RETURNING`），集成测试 `task-engine.spec.ts:115-130`。

### A2. 任务派发、依赖与交接（A 派 B 的闭环）

- `done` 工具支持 `outboundTasks[]`（recipientAgentId/protocolId/title/payload/priority）：`file-tools.ts:180-222`。
- 落地：`completeTask` 遍历 outboundTasks → `createTask`（parentTaskId/dispatcherAgentId/assigneeAgentId）：`task.ts:554-594`。
- 依赖：`waiting_dependency` → `addDependency`；子完成 → `resumeDependents` 自动恢复父任务：`task.ts:373-394, 583-603`。
- 循环保护：`isDispatchLoop`（同对连续 3 次或 A→B→A 回环阻断）：`speech-queue.ts:39-90`。
- 工作流编排：`advanceWorkflowTask` 物化后继节点为新 Task（可派不同 assignee）：`workflow.ts:315-355`；边条件 `always/auto_review/outcome_equals/manual_approval/agent_label`；回环保护 `maxTraversals`：`workflow.ts:35-40, 365-369, 405-453`。
- 跨公司交接（B2B 外包）：`outsourcing-contract.ts` + `outsourcing-delivery.spec.ts:106-124`。

### A3. 产物仲裁与合并（多 agent 写同一项目的安全合并）

- 发布时文本三方合并（`git merge-file --diff3`）+ 二进制独占锁 + 路径逃逸防护：`publish-queue.ts:438-541`。
- 冲突自动派裁决 Task 给负责人（保留 base/ours/theirs 三份快照，最多两轮后整链升级）：`engine.ts:513-562`；测试 `engine-wiring.spec.ts:213-294`（writer 冲突 → 引擎自动派裁决 Task 给 lead → 解决收口）。

### A4. 交流机制（异步，无实时聊天）

| 通道 | 载体 | 用途 |
|------|------|------|
| Task 内讨论 | `task_message`（role 含 dispatch），最近 6 条注入 `inputPacket.recentDiscussion` | 用户/系统与执行 agent 的讨论 |
| 公司/项目对话 | `conversation_message`（scope=company/project） | 用户发消息 → 派 Task 给第一负责人 → 引擎写回 assistant 摘要 |
| 产物可见性 | artifact 表 + `contextRefs` 引用注入（单文件 64KB/总 256KB） | 一个 agent 的产出被另一个 agent 引用 |
| Agent Bridge | `http://127.0.0.1:3456/bridge/*` | agent 主动通知宿主（进度/预览/审批），非 agent↔agent |

**诚实边界**：
- agent 之间**没有实时聊天**；交流是异步 Task 派发 + 共享产物/消息表。
- `waiting_input` 追问的答案由**用户**提供（`task.ts:620-649`），agent 之间不自动互答。
- "交互"主要指人与系统（审批中心、submit_review、@员工群聊、裁决 Task）。

### A5. 增量价值清单（相对"手动开 N 个 CLI 终端"）

1. 统一 worktree 隔离 + 三方合并仲裁（不静默覆盖，PRD 承诺项）。
2. 统一权限审批中心（CLI 工具调用经 hook/RPC 桥交 Muster 策略裁决）。
3. 依赖编排 + 工作流自动触发 + 失败熔断回退（`engine.ts:985-1008`）。
4. 会话续接（sessionIdHint/vendorSessionId）+ 压缩轮换（`session-manager.ts`）。
5. 进度可视化（realtime 事件 + 事件聚合 + 员工运行面板）。
6. 员工评级、token/成本归集、反思队列。

**结论**：多 Agent 协同机制在代码层面真实成立且有多项集成测试覆盖；"多个 Agent 并行协同工作、交流、交互"即产品卖点。

---

## 三、调研结论 B：API/CLI 能力差异与统一标准缺口

### B1. API 型执行器能做什么 / 不能做什么

**能做**（7 个内置工具，`registry.ts:329-491`）：
- 读写 worktree 内文件：`read_file / write_file / edit_file / list_files`
- 汇报进度：`notify_host`（progress/notify/preview）
- 业务审批：`submit_review`
- 结束任务：`done`（含 outboundTasks/workflowNextEdgeLabel/artifacts）
- 调用 MCP 工具（stdio/sse/http，`mcp/adapter.ts`）

**不能做**：
- **无 Bash 工具**（`PermissionAction` 枚举有 `'execute-command'` 但无任何内置工具使用它，`registry.ts:44`）→ 不能装依赖、跑测试、构建、git 操作、部署。
- 会话仅 create（openai 支持 compact），无 resume。
- 无 CLI 原生审批桥（靠 permissionGuard）。

**推论**：TDD / CI-CD / git 类 skill（正文明确要求 `npm test`、`npx tsc` 等，见 `skills/test-driven-development/SKILL.md:375`、`skills/ci-cd-and-automation/SKILL.md:88-91`）对 API 执行器是**不可执行的死建议**，但系统照常注入（`context.ts:93-108` 按任务加载，不看执行器类型）。

### B2. 统一标准的现状：不存在，三块互不相连的雏形

| 雏形 | 位置 | 运行时消费 |
|------|------|-----------|
| `ExecutorManifest.session/isolation/permissions/limitations` | `manifests.ts:7-25` | **零消费**（仅展示数据；前端用的是阉割版 `shared/executor.ts:17-24`） |
| `tools/` 档案 `executor_kind`（11 份全部声明 `cli`） | `tool-registry.ts:16-25` | **入库即死**（无人读取，包括 implementation: api 的 whisper-api/elevenlabs-api 也声明 cli） |
| 能力绑定 `requiresExecutorKind` | `company-template.ts:84` | 仅软诊断一句文案（`template-health-findings.ts:130-144`，全代码库唯一显式声明"API 型无法跑 bash"处） |

**派发逻辑**：固定员工绑定执行器，不看任务类型（`engine.ts:415` `selectAdapter(providerForManifest(...))`；`CLAUDE.md:29` 明确"员工不在 Task 中静默切换执行器"）。PRD:590 "按任务能力组合执行器"的意图**未落地**。

**已知 bug**：bridge prompt 对所有 agent 写"使用 Bash 执行 curl 命令"（`bridge.ts:96-98`），而 API 执行器无 Bash；`context.ts:117` 无条件注入 → API 执行器收到做不到的指令（实际应走 `notify_host` 工具）。

### B3. 错误模式：API 工具循环无硬校验

- 未知工具/纯文本回复/坏参数 → 只是喂回错误文本或 `outcome:'blocked'`（`tool-loop.ts:122-152`；注释与代码不符——"尝试解析为 AgentRunResult"实际未实现）。
- `maxToolCalls=50` / 300s 超时兜底（`openai-adapter.ts:55-56`）。
- CLI 侧有一次性格式纠正重试（`claude-code-adapter.ts:119-157`），API 侧无对应机制。
- **模型能力不足的 API 供应商可能错误完成任务**——目前无能力分级、无提示。

---

## 四、调研结论 C：沙盒安全评级与实锤漏洞

### C1. 各执行器安全评级

| 执行器 | 机制 | 评级 |
|--------|------|------|
| codex-cli | RPC 硬审批（accept/decline 二选一，`codex-cli-adapter.ts:88-98`）；deny 策略下自动 `read-only` 沙箱 + 永不批准（`codex-cli-adapter.ts:25-26`） | **强** |
| claude-code-cli | PreToolUse/PermissionRequest hook 桥，桥不可用时 **fail-closed 拒绝**（`claude-permission-bridge.ts:34` helper fail-closed）；spawn 用 `bypassPermissions` 但 hook 是权威入口（`claude-code-adapter.ts:234-241`） | 中强 |
| API 型（openai/gemini） | worktree 路径强校验（`isWithinWorkspace`）+ permissionGuard（HIGH_RISK_ACTIONS 自动审批，`permission.ts:11`）+ 审批可人工确认 | 中强（无 OS 级沙箱） |
| antigravity-cli | `--sandbox --add-dir` + 审批桥 | 中 |
| opencode-cli | `approvalBridge:'none'` + `--auto` —— **危险命令完全无审批**，仅依赖用户 opencode deny 规则（manifest 自声明 experimental） | **弱（最弱一环）** |
| custom-cli | 受限非交互运行，无审批接管 | 弱 |

### C2. 两个实锤漏洞（`src/server/sandbox.ts:24-51`）

**漏洞 1：Bash 黑名单可被解释器包装绕过**。黑名单正则只匹配表面命令：
- `python -c` 只匹配 `os.system|subprocess` —— `shutil.rmtree('/')`、`os.remove` **不匹配**。
- `node -e` 只匹配 `child_process` —— `fs.rmSync('/', {recursive:true})` **不匹配**。
- `rm -rf "$HOME"`、`rm -rf ./foo` 的变体绕过 `\brm\s+-rf\s+[\/~]` / `\.` 模式。

**漏洞 2：`isWithinWorkspace` 无 realpath 解析**（`sandbox.ts:89-97` 仅 `resolve()` 前缀检查）：worktree 内若存在指向外部的**符号链接**，文件工具写操作可经 symlink 逃逸出 worktree。

### C3. 已有防护（不应低估）

- 权限策略体系完整：规则 > deny > high-risk > outside-scope > no-approval > ask（`permission.ts:52`）；scope 支持 task/project/workspace/selected-directories/device。
- `HIGH_RISK_ACTIONS` 已含 delete-outside-project/system-install/credential-access/git-push/deploy（`permission.ts:11`）。
- 命令分类 `classifyCommand`（`cli-permission-bridge.ts:28-35`）→ 高风险命令自动进审批。
- API 文件工具 read 上限 64KB、readonlyDirs 只读（`file-tools.ts` 注释 + `registry.ts:105,111-120`）。
- **注意**：API 型执行器无 Bash 工具，其文件操作被路径校验 + 审批双重约束——**越界风险反而低于 opencode-cli**。

---

## 五、内置开源 agent 的必要性结论：不必要

### 外部调研摘要

| 候选 | 嵌入方式 | 本地文件操作 | 备注 |
|------|----------|-------------|------|
| opencode（anomalyco/opencode，MIT） | TS SDK `@opencode-ai/sdk`，`createOpencode()` 进程内 server+client | 内置工具（read/write/edit/bash）+ allow/ask/deny 权限 | 能力最全；但引入第二套 agent 循环 |
| pi（earendil-works/pi，MIT） | Node SDK `createAgentSession()` | read/write/edit/bash | 无内置沙箱（官方明说靠 OS 边界） |
| Claude Agent SDK | npm 依赖，agent 循环跑在自己进程 | 内置文件工具 + Bash | 商业条款约束命名 |
| Codex SDK | spawn 子进程 + JSONL | 沙箱模式可配 | 本质是子进程包装 |
| MCP server 方案 | 工具层标准化 | 取决于 server | 不含 agent 循环，仍需 agent 主体 |

### 结论

- 5 个 CLI 适配器已覆盖主流 agent，多 Agent 协同闭环完整（见第二节）——**直接连接官方 CLI 即可获得全部能力，无需内置**。
- 内置 SDK 引入两套 agent 循环 + 两套权限模型冲突，且需跟随上游迭代；进程内嵌入还有崩溃波及宿主的风险。
- 值得做的不是"内置"，而是：**① 补统一能力标准 ② 补 API Bash 工具 ③ 加固沙盒 ④ API 能力探针**（①③④见本文档；②见后续建议）。

---

## 六、设计一：API 能力探针 + 能力矩阵 + 派发提示（纳入设计）

### 6.1 现状缺口

`connection-probe.ts:24` 的 `probeArgs` 仅覆盖 4 个 CLI 执行器；**API 型（openai/gemini）返回空数组**——API 执行器没有任何连通性探针，更无能力探针。现有探针只验证"能否回 MUSTER_CONNECTION_OK"，不验证能力（function calling / 工具循环 / 结构化输出）。

### 6.2 设计目标

1. 对 API 执行器提供真实能力探针（HTTP 请求，非 execFile）。
2. 产出能力矩阵 `CapabilityProbeResult`，UI 展示"此 API 能完成哪些工作 / 不能完成哪些 / 建议连接 CLI"。
3. 派发时按任务需求校验执行器能力，不满足则提示/阻断（堵住"死建议"）。
4. 支撑"对 API 供应商有要求"：能力不足的模型在绑定页明确标注边界。

### 6.3 数据模型

```ts
// ProbeKind 扩展
export type ProbeKind = 'connectivity' | 'model' | 'capability';

export interface CapabilityProbeResult {
  functionCalling: boolean;      // 请求带 tools 时是否返回 tool_calls
  toolLoop: boolean;             // 工具结果回填后模型能否继续并收敛
  structuredOutput: boolean;     // response_format / json_schema 是否生效
  instructionLevel: 'low' | 'medium' | 'high';  // 标准指令完成度评分
  supportedTasks: string[];      // 由探针结果推导：可执行的任务类别
  unsupportedTasks: string[];    // 缺 bash 等：不可执行的任务类别
  note: string;                  // 人话提示（如"无命令执行能力，测试/构建/安装依赖需连接 CLI"）
}
```

存储：`connection_probe` 表加 `capability_json` 列（或独立 `capability_probe` 表），与现有 probe 缓存机制一致（24h 缓存、force 重测）。

### 6.4 探针流程（API 型执行器）

1. **function calling**：发 `chat/completions` 请求，tools 里给一个 `echo` 工具，要求"调用 echo 工具并返回 payload"，检查响应 `tool_calls` 存在且合法（复用 `openai-adapter.ts` / `gemini-adapter.ts` 的请求构造）。
2. **工具循环**：模拟一轮 `tool_loop`（调用 → 回填 functionResponse → 再次请求），验证模型消费结果并继续收敛（复用 `tool-loop.ts` 骨架，轻量版）。
3. **结构化输出**：带 `response_format: {type:'json_object'}`（或 json_schema）请求，验证返回合法 JSON 且符合约束。
4. **指令遵循等级**：标准提示词（如"只回复 MUSTER_CONNECTION_OK，不要调用工具"）→ 按响应合规度给 low/medium/high。
5. 所有请求用临时空目录、无副作用、超时 60s、脱敏记录（复用 `redact`）。

### 6.5 能力矩阵与 UI 展示

- **员工绑定页 / 执行器卡片**（`ExecutorCenterPage.tsx`）：能力徽章（Function Calling / 工具循环 / 结构化输出 / 指令等级）+ 能力边界说明 + "以下工作需连接 CLI：测试、构建、安装依赖、git 操作"提示 + "建议连接：Codex CLI / Claude Code CLI / ..."。
- **执行器健康视图**：能力探针结果入健康检查（`executor-health.ts`），降级时在状态看板可见。

### 6.6 派发校验（堵死建议）

1. **skill 元数据**：`skills/*/SKILL.md` frontmatter 增加 `requiresExecutor: 'cli' | 'api' | ''`（TDD/CI-CD/git-workflow/browser-testing/shipping 等标记 `cli`；纯内容创作类可为空）。skill 扫描（`context.ts:93` `resolveTaskSkills`）透传该字段。
2. **派发校验**：`engine.ts` 派发前（或 `claimNextTask` 后）校验——任务解析出的 skills 含 `requiresExecutor:'cli'` 而员工执行器能力矩阵缺 bash → **默认提示**（任务状态/事件流/对话窗口可见），策略可配置为提示或阻断。
3. **API 执行器补 Bash 工具后**：校验逻辑改为按 `CapabilityProbeResult` 判定（工具存在 ≠ 模型会正确用），仍保留能力边界提示。

### 6.7 涉及文件清单

`src/server/domain/connection-probe.ts`（probeArgs 扩展 API 分支 + capability 探针）、`src/server/executors/openai-adapter.ts` / `gemini-adapter.ts`（探针请求复用）、`src/shared/executor.ts`（类型）、`src/server/db/migrations/*`（capability_json）、`src/server/api/executors.ts`（REST）、`src/client/pages/ExecutorCenterPage.tsx`（能力徽章 UI）、`src/server/executors/context.ts`（skill requiresExecutor 透传）、`src/server/task-engine/engine.ts`（派发校验）、`skills/*/SKILL.md`（frontmatter 标注）。

---

## 七、设计二：Agent 沟通渠道（只设计，不实现）

### 7.1 目标与原则

员工间小范围**探讨、请求、咨询**。设计原则：与"派发任务"区分开（讨论 ≠ 派活），但复用同一套执行基础设施（线程/工具循环/权限/审批），不引入实时聊天（保持异步、可审计）。

### 7.2 方案 A：任务内咨询（低复杂度，推荐优先）

**工具**：`ask_colleague`（注册进内置工具，`registry.ts`）：

```jsonc
{
  "name": "ask_colleague",
  "description": "向同事员工发起一次结构化咨询。对方回复后本任务继续执行。用于请求信息、方案探讨、确认依赖。",
  "parameters": {
    "type": "object",
    "properties": {
      "recipient_agent_id": { "type": "string", "description": "被咨询的员工 id" },
      "question": { "type": "string", "description": "咨询内容（尽量具体，可引用文件路径/产物 id）" },
      "context_refs": { "type": "array", "items": { "type": "string" }, "description": "可选：供对方只读引用的文件路径（worktree 内）" }
    },
    "required": ["recipient_agent_id", "question"]
  }
}
```

**流程**：
1. A 调 `ask_colleague` → 引擎创建**咨询型轻任务**（新 state 或 `task.kind='consultation'`；无独立 worktree 或共享只读上下文，含 context_refs 白名单）。
2. B 的线程领取（复用 `claimNextTask` 归属逻辑）→ B 以普通执行流程运行（session 复用），回复 = 结构化结果（`reply` 文本 + 可选引用产物）。
3. 回复写回 `task_message`（role='dispatch'）→ A 的工具循环收到结果（如同普通 tool result）→ **A 继续原任务**，不产生新 Task 链。

**复用与成本**：
- 复用：outboundTasks 派发机制、task_message dispatch 角色、`recentDiscussion` 注入（B 侧上下文）、permissionGuard（新增 `consultation` 动作或复用 `external-message` HIGH_RISK_ACTION）。
- 成本：一个工具 + 咨询任务类型 + 回复回填，**复杂度低**。

**边界**：
- B 忙（正在跑任务）→ 咨询任务排队（现有排队机制）。
- B 不可用（离职/offline）→ 回复"对方不可用"，A 可降级为 `done(outcome:'waiting_dependency')` 或继续。
- 循环咨询防护：复用 `isDispatchLoop`（同对连续 N 次阻断）。

### 7.3 方案 B：独立探讨线程（高复杂度，第二阶段）

**概念**：项目级"讨论室"（topic），独立于任务，参与者多个员工，异步串行发言。

**数据模型**（新迁移）：

```sql
CREATE TABLE discussion (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  topic TEXT NOT NULL,
  initiator_agent_id TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','concluded','closed')),
  minutes_json TEXT,           -- conclude 时写入纪要
  conclusion_json TEXT,        -- 结论要点 + 落地建议
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE discussion_participant (
  discussion_id TEXT NOT NULL REFERENCES discussion(id),
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (discussion_id, agent_id)
);
CREATE TABLE discussion_turn (  -- 发言记录
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussion(id),
  task_id TEXT NOT NULL REFERENCES task(id),  -- 每次发言 = 一个轻任务
  speaker_agent_id TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL
);
```

**发言调度**：讨论室内**同一时刻仅一个发言者**（串行轮转）。每个发言 = 一个轻任务（`task.kind='discussion-turn'`）派给下一位参与者；发言内容写回 discussion_turn；下一位的 `inputPacket` 注入前序发言摘要（最近 N 条）+ 讨论目标。复用引擎 pump 与线程状态机。

**结论压缩回项目（回答"任务外结论如何落地"）**：`conclude_discussion` 工具（或讨论发起者总结）：
1. **纪要**（minutes）写入 discussion 表 + `postSystemMessage` 到项目对话窗口（用户可见）。
2. **结论要点**（conclusion）按落地方式分发：
   - 派发实施 Task：`conclusion.actions[]` → 逐个 `createTask`（assignee 指定，可带 payload）。
   - 写项目记忆：经 `flushThreadMemory` / 项目 memory 通道沉淀（复用 `memory.ts`）。
   - 产出文档：纪要作为 artifact 发布到项目目录（复用 publish 流程）。
3. 讨论室关闭（state='concluded'），全部记录只读留档。

**复杂度评估**：新 3 张表 + 发言轮转调度 + 结论分发机制 + 与任务/项目上下文打通 + 前端讨论室 UI（列表/参与者/发言流/纪要）。**明显高于方案 A**。

**边界**：无实时聊天（发言是异步串行）；讨论不产生 worktree 产物（除非结论落地）；防讨论失控（轮次上限、`isDispatchLoop` 风格防护）。

### 7.4 建议路径

1. **Phase 1**：方案 A（ask_colleague）——覆盖"请求、咨询"核心场景，成本低，验证"双向咨询"价值。
2. **Phase 2**：方案 B（探讨线程）——覆盖"探讨、头脑风暴"，需先落地 7.3 的结论压缩机制。

---

## 八、后续建议清单（本次不实现）

| 优先级 | 项 | 说明 |
|--------|----|----|
| P0 | **沙盒加固-黑名单** | 补解释器包装（python shutil/os/import、node fs、ruby、perl）、变量展开（`rm -rf "$HOME"`）、`find -delete`、`xargs rm`；`sandbox.ts:24-51` |
| P0 | **沙盒加固-realpath** | `isWithinWorkspace` 改用 realpath 解析防 symlink 逃逸；`sandbox.ts:89-97` |
| P0 | **opencode 审批** | `approvalBridge:'none'` + `--auto` 无审批最弱；方案：适配器注入 deny 规则文件 / 升级 approvalBridge（`opencode-cli-adapter.ts`） |
| P1 | **API 型 Bash 工具** | 注册 bash 工具到 registry，复用黑名单 + `classifyCommand` + permissionGuard 审批；使 API 执行器能力对齐 CLI（不依赖模型厂商内置能力） |
| P1 | **能力标准落地** | manifest 能力字段入运行时消费 + skills `requiresExecutor` + 派发校验（与设计一联动） |
| P2 | **bridge prompt 死指令 bug** | `bridge.ts:96-98` 按执行器 kind 分化提示（API 型提示用 notify_host 工具） |
| P2 | **API 工具循环硬校验** | 未知工具/纯文本回复/坏参数加校验与纠正重试（对齐 `claude-code-adapter.ts:119-157`） |

---

## 附：外部调研来源

- opencode SDK：https://opencode.ai/docs/sdk/ ；server：https://opencode.ai/docs/server/ ；tools/permissions：https://opencode.ai/docs/tools/ 、https://opencode.ai/docs/permissions/ ；仓库：https://github.com/anomalyco/opencode
- pi（earendil-works/pi）：https://pi.dev/docs/latest 、https://pi.dev/docs/latest/sdk 、https://github.com/earendil-works/pi
- Claude Agent SDK：https://code.claude.com/docs/en/agent-sdk/overview 、https://code.claude.com/docs/en/agent-sdk/permissions
- Codex SDK：https://github.com/openai/codex （sdk/typescript/README.md）
- Cline SDK：https://docs.cline.bot/cline-sdk/overview
- MCP：https://modelcontextprotocol.io/quickstart/user
