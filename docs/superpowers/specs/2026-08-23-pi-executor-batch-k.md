# 批次 K：pi 执行器接入（队列第 5 项；opencode 已在册无需重做）

状态：proposed（2026-08-23；实测 pi 0.73.1（@mariozechner/pi-coding-agent 已装本机）+ README 事实）

## 实测事实（接入依据）

- `pi -p "<prompt>"` 非交互 print 模式；`--mode json` 全事件 JSONL（session 事件带 uuid；assistant 消息事件带文本）。
- 会话：`--session <uuid|path>` 恢复（支持部分 UUID）；`--no-session` 临时；`--session-dir` 自定义；默认 `~/.pi/agent/sessions/`。
- **无内置权限弹窗**（设计哲学：容器/扩展自建）——`--tools read,grep` 白名单只读可配；muster 侧 L0 OS 围栏兜底（与 custom CLI 同类，spec 已有「无 hook CLI 只能 L0 兜底」先例）。
- `--provider/--model/--api-key`；`--no-extensions/--no-skills` 关发现（可复现性）；`PI_SKIP_VERSION_CHECK`。
- 环境隔离：`PI_CODING_AGENT_DIR` 可改配置目录（v1 不用——保留默认 HOME，`.pi` 进 CLI 家目录白名单）。

## 模型

### 1. spawn-shell：cliHomeDirs 补 `~/.pi`

pi 写 `~/.pi/agent/sessions/`——commonPaths 白名单缺它会被 OS 围栏拒（F3 同族）。

### 2. manifests.ts 新档 `pi-cli`

- kind cli / certification experimental / detection `pi --version` / session {create:true, resume:true, fork:true}（pi 全支持）/ approvalBridge 'none'（无权限接管）。
- limitations：['无原生审批接管：无 permission hook，依赖 L0 OS 围栏（seatbelt 文件写白名单）+ 可选 --tools 只读白名单；与 custom CLI 同类已知边界', 'JSON 事件流依赖 pi ≥0.73', 'provider/model 走 pi 自身配置（~/.pi/agent 或 --api-key 注入）']。
- concurrency parallel（专家并发定论）。

### 3. 新 `src/server/executors/pi-cli-adapter.ts`（仿 antigravity/custom 形态）

- runner 可注入（测试用）；argv = `['--mode','json','--no-extensions','--no-skills','--session-dir',<runSessionDir>,(sessionHint?['--session',hint]:[]),(apiKey?['--api-key',key]:[]),'-p',prompt]`。
- prompt = systemPrompt + '# 当前 Task 工作包' + inputPacket JSON + 「最终仅返回 AgentRunResult JSON；不得使用 Markdown 代码块」。
- 解析：stdout 逐行 JSON——session 事件 id → `_sessionIdHint`（续跑）；最后一条 assistant 消息文本 → tryParseJSON → agentRunResultSchema；解析失败 → 包装为 `{outcome:'completed', summary:<全文截断>}`（不炸任务，降级可读）。
- 沙箱：guardedArgv + writeSandboxProfile([workingDir, ...commonCliWritableRoots()])（F3 口径）；env=sanitizeChildEnv。
- server.ts 注册 `adapterRegistry.set('pi-cli', new PiCliAdapter())`。

### 4. 凭据

复用 resolveExecutorCredentialForTask 既有三层解析；有 apiKeyValue 时传 `--api-key`（不入 argv 日志的脱敏由 trace 截断口径负责——trace 只记前 100 字符）。

## 测试

- 单测：adapter（fake runner——argv 形态/沙箱包装/事件解析出 sessionHint+结果/坏 JSON 降级包装）；spawn-shell cliHomeDirs 含 .pi。
- 冒烟不覆盖（本机 pi 无凭据，真跑会报 No API key——作为已知环境限制记录，不挡合并）。

## 边界与不做

- 不做 pi 扩展/skills 分发（v1 --no-extensions --no-skills 关发现保可复现）；不做 RPC 模式（v1 用 json 单向够了）；不做只读 --tools 白名单档（需要时 settings 加）。

## 实施记录

（待实施）
