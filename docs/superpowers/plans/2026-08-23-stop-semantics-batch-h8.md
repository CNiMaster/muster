# 批次 H8 实施计划：停止语义 + 即时回执 + 环境预检

对应 spec：`docs/superpowers/specs/2026-08-23-stop-semantics-batch-h8.md`（0c4060e，用户三轮定稿）。
worktree：`git worktree add ../muster-h8 -b feat-stop-h8`（基于 main@4dc7398）+ 软链接 node_modules（不 npm ci）；提交 `--no-verify`（lefthook 被安全防护拦截）。

## 核心设计定案（侦察结论）

**`task.stop_requested` 列 = 统一停止标记，三路汇入同一收尾器 `finalizeSafeStop`，不改 TASK_OUTCOMES 枚举：**

1. **API 执行器·边界停**：tool-loop 收 `stopSignal` → 置 flag；工具执行完/新一轮开前 break → adapter 返回 `blocked`（openai-adapter 空结果现状即返回 blocked，不抛错）→ 引擎在**执行器返回后检查** `stop_requested=1` → finalizeSafeStop。
2. **API 执行器·模型等待**：stopSignal 且 `inModelCall` → `controller.abort()`（fetch 中止）→ adapter 抛错 → 引擎 **catch 分支**检查 `stop_requested=1` → finalizeSafeStop。
3. **CLI 执行器**：stopSignal → `SIGINT`（Claude Code/codex 优雅收尾出总结）→ adapter 正常返回 → 引擎**返回后检查** → finalizeSafeStop；60s 超时 → forceStop（主 controller.abort）→ catch 分支 → 同收尾。其余 CLI 适配器（gemini/opencode/custom/antigravity）不接 SIGINT，天然走 60s 兜底（spec 记边界）。

`finalizeSafeStop`：running/claimed → paused（direct SQL + interruption_count+1 + 清 stop_requested）+ preserveWorktree（不删 task_runtime——363 行 `getTaskRuntime` 复用已存在，「继续」免费）+ 文件清单（listTaskBranchChanges，cap 50）+ 步数/最后动作（最新 tool_call/file_edit trace）+ task_event `interrupted`（打断记录卡数据源）+ 生效回执系统消息 + thread paused + realtime。

**pauseTask 缺陷修复**：/pause 路由对 running/claimed 改走 engine.requestStop（安全停）；等待态仍走域 pauseTask。interruptTask 保留为强停原语不动（引擎关机在用），/interrupt 端点保留标 deprecated，UI 全部切 /stop。

**插话语义统一（I5 收敛）**：interruptMode='interrupt' 发送 与 排队条 ↑立即 = 同一动作：requestStop（安全停→paused）+ 立即 postUserMessage（新任务进队列，旧任务留 paused+记录卡）。server flush 端点内聚这两步。

## 实施顺序（S1→S4，每步可编译）

### S1 迁移 + 域层
- 迁移 `20260823100000_task_stop_requested.sql`：`ALTER TABLE task ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0`。
- `domain/task.ts`：Task 类型 + fromRow 加 `stopRequested`；`requestStopTask(db, taskId)`（幂等置位 + task_event `stop_requested` + 返回最新动作信息供回执）；`resumeTask` UPDATE 加 `stop_requested=0`。
- `domain/setting.ts`：`stopGraceMs`（默认 60000，clamp 5000-600000）入 getSystemSettings + 更新链（api/settings.ts zod 同步）；SettingsPage 加数字输入（挨着 interruptMode）。

### S2 引擎 + 执行器
- `executor.ts`：ExecutionContext 加 `stopSignal?: AbortSignal`。
- `engine.ts`：
  - 每 run 建 stopController：`activeStops: Map<taskId, {controller, hardTimer}>`；`ctx.stopSignal = stopController.signal`（661 行区）；finally 清理（clearTimeout + delete）。
  - `requestStop(taskId)`：requestStopTask（域）→ 受理回执（postSystemMessage「已请求停止——等待…」+ realtime `task.stop_requested`）→ stopController.abort() → hardTimer(读设置 stopGraceMs) → `forceStop`（task_event `stop_forced` + abortTask）。run 不活跃（waiting 态）时仅置位回执，不打信号。
  - 执行器返回后检查（791 行结果校验后、outcome 处理前）：`stop_requested=1` → preserveWorktree=true → finalizeSafeStop → return。
  - catch 新分支（waiting_approval 之后、resolutionContext/handleRunError 之前）：`stop_requested=1` → 同上（mode='forced'）。
  - `finalizeSafeStop(task, thread, worktreeInfo, {mode, summary, err})`：见上；worktreeInfo 空守卫（无 worktree 任务）。
- `tool-loop.ts`：`opts.stopSignal` → flag + `inModelCall` 追踪；模型等待中收到→controller.abort()；边界（轮顶/模型返回后未开工具前/每工具后）break。
- `claude-code-adapter.ts` + `codex-cli-adapter.ts`：stopSignal → `proc.kill('SIGINT')` 一次（{once:true}）；signal（硬）路径不动。
- `fake-executor.ts`：delay 完成后/步末检查 `ctx.stopSignal?.aborted` → throw `'fake: safe-stop boundary'`（模拟等命令跑完到边界停——测试断言半成品文件保留）。

### S3 API + 客户端
- `api/tasks.ts`：`POST /stop`（域置位+受理回执+engine.requestStop，engine 经 app.locals）；`/pause` rewire（running/claimed→同 stop；等待态→pauseTask 原逻辑）；`/interrupt` 标 deprecated 注释。
- `api/projects.ts`：queue flush（213 行区）interruptTask→engine.requestStop（回执「已打断并送出」）；新 `POST /api/projects/:id/tasks/stop-all`（running/claimed 循环 requestStop，返回 N）。
- `client/api.ts`：stopTask/stopAllProjectTasks/discardStoppedTask；Task 类型加 stopRequested。
- `PromptComposer.tsx`：三态——输入空+运行 `[■ 停止 ⌄]`（⌄ 菜单「暂停本项目全部任务（N 个运行中）」）；有字运行中 `[发送 ↑]`（发送走排队/插话通道）；空闲 `[发送 ↑]`；`stopRequested` → `[⏸ 停止中…]` 禁用。onStop 语义注释更新（安全停非回队列）。
- `ProjectTaskWorkspace.tsx`：onStop → stopTask；interruptMode='interrupt' 发送 → stopTask+post；提示语「已请求停止，等待当前命令完成…」。
- 新 `InterruptRecordCard.tsx`：useTaskEvents 过滤 kind='interrupted'（取最新），渲染停点/文件清单/三出口——**继续**=POST /resume（worktree 复用续跑）；**补齐**=记录摘要预填 composer 发新消息；**回退**=POST /tasks/:id/discard-stop（removeWorktree keepBranch:false + deleteTaskRuntime + 置 queued 从头重跑）。挂消息流（refTaskId 消息分支旁）+ TaskDetailPage。
- `api/tasks.ts` 补 `POST /discard-stop`。
- `WorkLivePanel.tsx`：执行者目录顶部「全部暂停」→ stop-all（第二入口）。
- 生效回执=系统消息落库（finalizeSafeStop 已 postSystemMessage），前端消息流天然渲染；LiveProcessBar 随 running 态消失（既有逻辑）。

### S4 环境预检
- 新 `scripts/preflight.mjs`：spawn 自检（node --version / git --version / node_modules/.bin/esbuild --version）+ darwin 下 xattr 检测目标二进制隔离属性（esbuild realpath）→ 输出可操作中文指引（系统设置允许 / xattr -dr 命令）；失败 exit 1；`MUSTER_SKIP_PREFLIGHT=1` 跳过。
- `package.json` 加 `"preflight"`；`playwright.config.ts` webServer.command 前缀 `npm run preflight && `。
- 新 `src/server/executors/spawn-errors.ts`：`classifySpawnError(msg)`（EPERM/Gatekeeper 报错串模式）；engine.handleRunError 失败摘要追加指引（macOS 才提示）；单测覆盖模式串。

## 测试矩阵
- 域：stop_requested 置位幂等/resume 清位；stopGraceMs 设置链 round-trip。
- 引擎集成（fake-executor）：①写文件中停（delay 中 stop→文件保留+paused+interrupted 事件+回执消息）②超时升级（graceMs 极小→forced→paused 非 failed）③续跑复用（paused→resume→第二次 run expectFiles 同 worktree）④回退（discard-stop→worktree 删+queued）。
- tool-loop 单测：模型等待中止 / 工具边界 break。
- API HTTP 级（教训：域层拦不住方法不匹配）：/stop、/stop-all、/pause rewire、queue flush 新语义。
- 前端：三态按钮渲染+菜单+停止中禁用；InterruptRecordCard 三出口回调。
- spawn-errors 单测。

## 边界与不做
蜂群依赖序批量停（并行停即可）；自动汇总任务派发（spec 可选项，不做）；gemini/opencode/custom/antigravity 的 SIGINT（走 60s 兜底，spec 记录）；历史树回退。spec 全程同步实施记录。

## 验证与合并
每段提交后跑门；终验四门全绿（tsc -b --force 判真实退出码 / vitest 全量 / smoke / e2e，MUSTER_KEEPAWAKE=off）→ main 归因检查 → merge → 复验 tsc → 清 worktree。
