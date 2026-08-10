# Muster 整改计划：多类型虚拟 Agent 公司操作系统优化

> 状态：已批准，待实施
>
> 日期：2026-08-10
>
> 背景：基于对 OpenCode Sisyphus 编排模式的借鉴分析，结合 Muster 当前代码现状（执行器、人员、外包、编排、兜底机制）的深度探索，制定本整改计划。
>
> 目的：让 Muster 成为「一个人经营多家虚拟 Agent 公司的操作系统」，支持不同类型公司（软件/小说/图片/影视/编辑/社媒等）高效协作落地。
>
> 原则：不重写现有 Task/Executor/审批/恢复体系，只在上层补语义、补自动化、补缺失能力。

---

## 对前一版建议的修正

| 前一版建议 | 修正 |
|---|---|
| 「需要新增编排批次实体 orchestration_run」 | **过度设计。** 现有 `parentTaskId/rootTaskId + outboundTasks + task_dependency + waiting_dependency` 已是 fan-out/join 基础。只需给第一负责人加 `spawn_tasks`/`join_policy` 工具和汇总聚合，不必新建表。 |
| 「需要统一事件模型 event sourcing」 | **当前不急。** 持久 task_event + realtime 双轨能跑。等编排复杂度上来后再做，列为后续。 |
| 「需要把 worktree 抽象成多种 Artifact Workspace」 | **方向对但优先级低。** 小说/内容公司用文件读写已够用，图片/影视公司才需要素材目录管理。放到第六阶段随新公司类型一起做。 |
| 「API 执行器不能跑命令」 | **不准确。** `run_command` 工具对 API 型同样注册并可调用（`registry.ts:980-987`），只是 systemPrompt 和 capability-probe 反复声明「无此能力」引导模型不去用。应改为按能力探针真实结果决定，而非一刀切禁用提示。 |
| 「personas 库需要扩充」 | **先接入再扩充。** 211 个 persona 当前完全没被运行时读取，扩充再多也没用。第一步是把它们接入新建员工流程。 |

---

## 优先级总览

```
P0（系统可靠性 + 高频痛点）
  阶段一：子任务失败兜底与自动恢复    ← 最紧急，当前会永久卡死
  阶段二：执行器三级默认与多 API 管理  ← 高频痛点，独立可做
  阶段三：人员新建自动化与提示词库接入  ← 高频痛点，独立可做

P1（核心差异化）
  阶段四：外包全自动 AI 对接          ← 依赖阶段二
  阶段五：公司运营优化报告系统         ← 新需求，独立可做

P2（扩展能力）
  阶段六：公司类型扩展与项目 Playbook  ← 依赖阶段三
  阶段七：编排能力增强                ← 依赖阶段二+三
```

**并行关系：** 阶段一、二、三可并行开发。阶段四在阶段二完成后开始。阶段五独立可做。阶段六在阶段三完成后开始。阶段七在阶段二+三完成后开始。

---

## 阶段一：子任务失败兜底与自动恢复（P0，最紧急）

> **为什么最紧急：** 当前子任务失败后，父任务会永久卡在 `waiting_dependency`，没有任何人发现。这是系统可用性的根本问题。

### 任务 1.1：子任务失败时自动通知并唤醒父任务

**现状（代码证据）：**
- `failTask`（`src/server/domain/task.ts:763-772`）只置 `state='failed'`、清租约、加失败计数，**完全不处理父任务**。
- `areDependenciesMet`（`src/server/domain/task.ts:357-367`）只认 `state IN ('completed')`，`failed` 不算满足。
- `completeTask` 的父唤醒逻辑只在 `outcome==='completed'` 分支（`task.ts:600-619`），失败时无对应物。
- 结果：子任务 failed 后，父任务**永久卡在** `waiting_dependency`，既不重试也不通知，没有任何人发现。
- `resumeDependents`（`task.ts:376-397, 622-624`）注释说为补跨公司依赖恢复缺口，但只在 completed 分支调用。
- `escalateToFirstResponder`（`task.ts:652-665`）已实现追问/对齐超限上报，可复用。

**目标：** 子任务失败时自动通知父任务，由父任务的第一负责人（或父任务派发者）决定怎么办——重试、换人、或放弃。不让父任务静默卡死。

**改动点：**
1. `src/server/domain/task.ts` — `failTask` 末尾新增失败传播逻辑：
   - 查找所有依赖该 task 的父任务（`task_dependency` 表 + `parentTaskId` 单链）。
   - 对每个处于 `waiting_dependency` 的父任务：
     - 向父任务的 `task_message` 写入一条失败通知（role=`dispatch`，内容含子任务标题、失败原因、失败次数）。
     - 触发 `escalateToFirstResponder`（复用 `task.ts:652-665`），给项目第一负责人派一个 `[兜底] 子任务失败` 上报 Task，priority=8，内容含父任务和失败子任务的信息、建议处理方式（重试/换人/取消）。
   - 注意防止重复上报：检查是否已为该失败事件派过兜底 Task（可用 `task_message` 或事件记录去重）。
2. `src/server/task-engine/engine.ts` — `handleRunError`（约 `engine.ts:1207`）中 `failTask` 之后，确认失败传播逻辑被触发（`failTask` 内部处理即可，engine 不需额外调用）。
3. **不自动重试子任务**——重试决策交给第一负责人（通过兜底 Task）。第一负责人可选择：调用 `resume_task` 恢复子任务重试、调用 `spawn_tasks` 换人重做、或调用 `cancel_task` 取消并让父任务跳过该依赖。
4. 需要给第一负责人提供 `cancel_child_task` 工具（`src/server/executors/tools/registry.ts` 新增），取消失败子任务后自动把父任务的对应依赖标记为「跳过」（`areDependenciesMet` 中 `failed+cancelled` 的依赖视为已处理，不再阻塞）。

**验收标准：**
- 子任务 failed 后，父任务不再永久卡死；第一负责人收到兜底 Task 并知道哪个子任务失败了。
- 第一负责人可选择重试、换人或取消。
- 取消子任务后，父任务的依赖被标记为跳过，父任务恢复 `queued`。
- 不产生重复兜底 Task。

---

### 任务 1.2：waiting 状态超时检测与自动上报

**现状（代码证据）：**
- `waiting_input` 和 `waiting_dependency` 都没有时间超时。`recoverExpiredLeases`（`task.ts:735-749`）只管 `claimed/running`。
- `waiting_input` 的追问超限上报（`task.ts:628-631`）需要轮次累加，但轮次只在有人回答后才涨（`answerClarification` `task.ts:644`）——派发者遗忘时轮次永远停在 1，上报永远触发不了。
- `waiting_dependency` 的依赖失败在任务 1.1 中处理，但依赖长期不完成（乙方卡住、其他专家慢）也无人发现。
- `waiting_input`/`waiting_dependency` 无 lease（`completeTask` 置 waiting 时清了租约，`task.ts:514-515`），所以 `recoverExpiredLeases` 不管它们。

**目标：** coordinator 定时扫描 `waiting_input`/`waiting_dependency` 状态的 task 年龄，超阈值自动上报第一负责人。

**改动点：**
1. `src/server/domain/task.ts` — 新增 `findStaleWaitingTasks(db, maxAgeMs)`：
   - 查询 `state IN ('waiting_input','waiting_dependency') AND updated_at < now - maxAgeMs`。
   - 返回 task 列表含等待时长、等待原因（waiting_input 的 clarification 轮次 / waiting_dependency 的未完成依赖列表）。
2. `src/server/runtime/coordinator.ts` — `tick()` 中新增调用：
   - 每 tick（2 秒）调 `findStaleWaitingTasks(db, STALE_WAITING_THRESHOLD_MS)`。
   - 阈值默认：`waiting_input` 30 分钟，`waiting_dependency` 60 分钟（可在公司设置中配置）。
   - 对每个 stale task 调 `escalateToFirstResponder`，派 `[超时] Task #N 长时间等待` 上报 Task，内容含等待时长、原因、建议处理方式。
   - 去重：同一 task 的超时上报间隔至少 30 分钟，避免重复轰炸。
3. 上报后第一负责人可：回答澄清（`answerClarification`）、催促依赖方、取消任务、或调整策略。

**验收标准：**
- task 在 `waiting_input` 超过 30 分钟无人回答，自动上报第一负责人。
- task 在 `waiting_dependency` 超过 60 分钟依赖未完成，自动上报第一负责人。
- 同一 task 不会在短时间内重复上报。
- 公司设置可调整超时阈值。

---

### 任务 1.3：Inspector 定时自动运行

**现状（代码证据）：**
- Inspector（`src/server/domain/inspector.ts`）只在用户手动调 `GET /api/projects/:id/inspector`（`src/server/api/phase7.ts:46-50`）时跑。
- 建议不持久化，没有定时自动执行（全仓 grep 仅 phase7.ts 一处调用）。
- 能检测拥堵（congestion，queued≥5）、缺席（absence，idle 线程却有 queued）、死循环（loop，clarificationRounds>0）、心跳停滞（stuck，心跳超 2 倍租约）、建议扩容（suggest_mirror）、正常（ok）。
- 注释 `inspector.ts:3-7` 明确「监察员只能提醒、催促、暂停异常 Task 和提出建议，不能自行修改组织、增加镜像或改变项目方向」。
- 前端 `DashboardPage.tsx:75` 拉取 inspector 建议渲染为警告条，但需用户主动打开页面。

**目标：** Inspector 定时自动运行，发现异常自动上报或持久化，用户无需主动拉取。

**改动点：**
1. `src/server/runtime/coordinator.ts` — 新增 Inspector 定时调用：
   - 每 60 秒（可配置）遍历所有 online 公司的 active 项目，调 `generateInspectorSuggestions(db, projectId)`。
   - 对非 `ok` 的建议：持久化到新表 `inspector_alert`（迁移新增：id/projectId/kind/message/severity/createdAt/resolvedAt）。
   - 高严重度（stuck/absence）：同时调 `escalateToFirstResponder` 派上报 Task。
   - 中严重度（congestion/loop/suggest_mirror）：持久化 + realtime 事件通知前端。
2. `src/server/domain/inspector.ts` — 建议增加 `severity` 字段（high/medium/low）。
3. `src/server/api/phase7.ts` — 新增 `GET /api/projects/:id/inspector/alerts`（未解决告警列表）、`POST /api/inspector/alerts/:id/resolve`（手动标记已处理）。
4. 前端 Dashboard 增加告警徽章和未处理告警列表。
5. 去重：相同 kind+projectId 的告警 5 分钟内不重复创建。

**验收标准：**
- 员工心跳停滞 60 秒内自动产生告警并上报第一负责人。
- 前端 Dashboard 显示未处理告警。
- 用户可手动标记告警已处理。
- 不产生重复告警。

---

### 任务 1.4：failed task 自动重试（有限次数）

**现状（代码证据）：**
- `failed` task 无自动重试。`failed → queued` 只能 `resumeTask` 手动触发（`task.ts:237, 913-926`）。
- watchdog 停下来的 task 落 `failed` 后只能人工 resume（`run-watchdog.ts:85-91` abort → `engine.ts:521-527` failExecutionRun → `handleRunError` → `failTask`）。
- 会话级 retry/compact/rotate（`engine.ts:516` 的 `for(;;)` 重试循环）只在单次 `adapter.run` 内生效，不是 task 级重试。
- `recoverExpiredLeases`（`task.ts:735-749`）只管 `claimed/running`，不管 `failed`。
- `isRecoverableSessionError`（`engine.ts:107`）已有可恢复错误判断逻辑，可复用。

**目标：** 非永久性失败（如超时、网络错误、会话崩溃）的 task，自动重试有限次数后仍失败才上报人工。

**改动点：**
1. `src/server/domain/task.ts` — task 增加 `auto_retry_count` 字段（迁移新增）。
2. `failTask` 中判断失败原因：
   - 可重试失败（超时、网络错误、session 崩溃 — 复用 `isRecoverableSessionError` `engine.ts:107` 的判断逻辑）+ `auto_retry_count < MAX_AUTO_RETRY`（默认 2）→ 自动 `resumeTask` 重回 `queued`，`auto_retry_count++`，记录事件。
   - 不可重试失败（逻辑错误、权限拒绝、安全阻断）或重试次数用尽 → 保持 `failed`，走任务 1.1 的失败传播。
3. `src/server/task-engine/engine.ts` — `handleRunError` 中区分可重试和不可重试失败，传递给 `failTask`。
4. 重试间隔：首次立即重试，第二次延迟 30 秒（避免快速重复失败）。

**验收标准：**
- task 因超时失败后自动重试，不需人工介入。
- 重试 2 次仍失败才保持 `failed` 并上报第一负责人。
- 权限拒绝/安全阻断不自动重试，直接上报。
- 重试次数和原因记录在 task 事件中。

---

## 阶段二：执行器三级默认与多 API 管理（P0，高频痛点）

### 任务 2.1：全局三级默认执行器设置

**现状（代码证据）：**
- 只有平台全局 `SystemSettings.defaultProvider`（单值，`src/server/domain/setting.ts:44`）+ 员工一对一绑定 `executor_profile_id`（`executor-profile.ts:99`）。
- 没有公司级默认，没有项目级默认，没有按任务规模路由。
- 引擎选执行器是单值回退链：`providerForManifest(executorProfile?.manifestId) ?? effectiveExecutor?.provider ?? defaultProvider`（`engine.ts:1396`）。
- `selectAdapter`（`engine.ts:148-151`）按 provider 从 adapterRegistry 取。
- 前端 `executor-selection.ts:1-3` `selectPreferredExecutor` 只在列表里挑第一个 connected 的，仅用于 UI 展示，不参与派发路由。

**目标：** 用户在系统设置中配置三级默认执行器：
- `primary`（大活/复杂任务）：高质量推理模型或 CLI
- `secondary`（标准任务）：次选
- `tertiary`（小活/轻量任务）：低成本模型，用于讨论、咨询、通知类 task

新建员工时默认继承这三级，用户可逐人覆盖。派发任务时引擎按任务标签自动选级，primary 不可用或能力不匹配时自动 fallback。员工手动绑定执行器时，固定用绑定的，不参与三级路由。

**改动点：**
1. 新增迁移：`system_settings` 增加三级字段 `executor_tier_primary_id` / `executor_tier_secondary_id` / `executor_tier_tertiary_id`（均外键到 `executor_profile.id`，可空）。`company` 表增加同名三列（公司级覆盖，可空，NULL 时继承全局）。
2. `src/server/domain/setting.ts`：`SystemSettings` 增加三级字段及 getter/setter。
3. `src/server/domain/company.ts`：公司级三级默认的读取与覆盖逻辑。
4. `src/server/task-engine/engine.ts`：`selectAdapter` 改为三级回退链。新增 `selectExecutorForTask(db, task, thread)` 方法，按以下规则选级：
   - 任务标签 `heavy`（含 `REQUIRES_CLI_SKILLS` 或显式标记）→ primary
   - 任务标签 `standard` → secondary
   - 任务标签 `lightweight`（讨论/咨询/通知/`inputProtocol.lightweight=true`）→ tertiary
   - 选中的 profile 不可用（connection probe 失败）或能力不匹配（capability probe 显示不支持该任务所需能力）→ 降级到下一档
5. 员工绑定优先级：员工 `executor_profile_id`（显式绑定）> 公司三级默认 > 全局三级默认。员工绑定的是「固定执行器」时不参与三级路由，直接用绑定的。
6. `src/client/pages/SettingsPage.tsx`：增加三级默认执行器下拉（每个下拉列出所有 connected 的 executor profile）。
7. 公司详情页增加公司级三级默认覆盖（可选，不填则继承全局）。

**验收标准：**
- 系统设置可配三个执行器 profile，保存后生效。
- 新建员工不手动选执行器时，按任务标签自动使用对应级别。
- primary 执行器探针失败时，任务自动降级到 secondary，不卡死。
- 员工手动绑定执行器后，该员工任务固定用绑定的，不受三级影响。

---

### 任务 2.2：API 执行器多 profile 管理 UI 完善

**现状（代码证据）：**
- `executor_profile` 表已支持多个 API profile（`executor-profile.ts:86` `listExecutorProfiles` 全量返回），后端 `POST /api/executors` 创建端点已支持（`api/executors.ts:89`）。
- API profile 的 config 结构：openai 兼容 = `{provider:'openai', baseURL, model}`；gemini = `{provider:'gemini', model}`（`ExecutorCenterPage.tsx:168-170`）。
- 但前端 `ExecutorCenterPage.tsx` 的 API profile 创建只暴露 baseURL/model 两个字段，且全局设置页只有一个 API 配置入口，用户感知上是「只能填一个」。
- 凭据通过 `credentialRef: {kind:'env', reference:'OPENAI_API_KEY'}` 只存环境变量名（`ExecutorCenterPage.tsx:167,175`），复用 `credential-store.ts` 三层解析。

**目标：** API 执行器管理体验对齐 CLI——用户可创建多个 API profile（不同供应商/不同模型/不同用途），每个独立命名、独立凭据引用、独立能力探针，在三级默认中可分别选为 primary/secondary/tertiary。

**改动点：**
1. `src/client/pages/ExecutorCenterPage.tsx`：API profile 创建/编辑表单完善——profile 名称、manifest 选择（openai-compatible / gemini）、baseURL、model、凭据引用（从 `credential_definition` 选）、并发模式、自定义 headers（可选）。支持列表查看、编辑、删除、探针重跑。
2. `src/client/pages/SettingsPage.tsx`：移除或降级全局单一 API 配置为「快速入门默认值」，引导用户到执行器中心管理多 profile。
3. 凭据管理 UI 对齐：API profile 创建时可从已有凭据定义选，也可新建凭据定义（环境变量名），复用现有 `credential-store.ts` 三层解析。

**验收标准：**
- 用户可创建 5 个不同 API profile（如 DeepSeek、通义、智谱、Kimi、Gemini），各自独立配置和探针。
- 三级默认设置中可分别选用不同 profile。
- 删除一个 profile 不影响其他 profile。

---

### 任务 2.3：修正 API 执行器能力提示一刀切问题

**现状（代码证据）：**
- `src/server/executors/context.ts:162-181` 对所有 API 型执行器注入「没有命令执行能力」提示。
- `src/server/domain/capability-probe.ts:213` 固定写「无命令执行能力」。
- 但 `run_command` 工具实际已注册且可调用（`registry.ts:980-987`），`tool-assembly.ts:33-60` 对所有公司不分 executor kind 一律装配。
- `runCommandHandler`（`registry.ts:239-294`）spawn `/bin/sh -c` 执行命令，带三重安全（黑名单、permissionGuard、cwd 隔离）。
- OpenAI/Gemini adapter 的 `callModel` 把 tools 原样塞进请求 body（`openai-adapter.ts:70-76`，`gemini-adapter.ts:63-67`）。
- function calling 强的 API（如 DeepSeek）被错误引导不去用命令能力。

**目标：** 按能力探针真实结果决定提示内容，而非按 manifest kind 一刀切。

**改动点：**
1. `src/server/executors/context.ts:162-181`：能力边界提示改为读取 `connection_probe.capability_json`，按真实探测结果生成提示，而非按 `manifest.kind==='api'` 判断。
2. `src/server/domain/capability-probe.ts:213`：`note` 不再固定写「无命令执行能力」，改为根据 `functionCalling` 和 `toolLoop` 推导。`supportedTasks`/`unsupportedTasks` 增加命令执行项的判定。
3. `src/server/task-engine/engine.ts:493-503`：`executor.capability-warning` 改为按探针结果触发，而非按 manifest kind。

**验收标准：**
- function calling 强的 API 执行器，systemPrompt 不再声明「无命令能力」，可正常调用 run_command。
- function calling 弱的 API 执行器，仍提示能力限制。
- 能力探针结果与实际提示一致。

---

## 阶段三：人员新建自动化与提示词库接入（P0，高频痛点）

### 任务 3.1：接入 personas 提示词库到运行时

**现状（代码证据）：**
- `personas/*.md` 共 211 个专家人设文件，按域分目录（engineering/52、specialized/52、marketing/51、product/14、security/10、data/8、design/8、qa/9、backend/3、frontend/2、devops/2）。
- 每个有 frontmatter（name/description/emoji/color）+ 自由 Markdown 正文（身份与记忆/核心使命/关键规则/技术交付物/工作流程/沟通风格/成功指标等章节）。
- **运行时完全不读取**（`grep -rln "personas/" src scripts` 全部命中为空）。
- 新建员工时 `soul` 只是字符串拼接：`你是${name}的${employee.name}。你的职责是：${responsibilities}`（`company-setup.ts:79`、`recruitment.ts:22`）。
- `AgentProfile` 结构化字段（`soul`/`principles`/`capabilities`）存在于数据库表 `agent_profile`（`agent-profile.ts:6-21`），但 personas 文件格式与之不兼容。
- `personas/domains.json`（219 行）把域映射到 persona 名列表。

**目标：** 新建员工时可从 personas 库选择专家身份，自动填入 soul/principles/capabilities。人才市场展示 personas 库分类，用户按域/关键词浏览和选用。

**改动点：**
1. 新增 `src/server/domain/persona-library.ts`：
   - 启动时扫描 `personas/*.md`，解析 frontmatter + 正文。
   - 提供 `listPersonas(domain?)` / `searchPersonas(keyword)` / `getPersona(id)`。
   - 将自由 Markdown 正文转换为 `AgentProfile` 结构：`soul` = 正文「身份与记忆」+「核心使命」段落；`principles` = 正文「关键规则」段落按行拆分；`capabilities` = 正文「技术交付物」+「工作流程」关键词提取 + frontmatter 元数据。
   - 缓存解析结果，文件变更时重新加载。
2. `src/server/api/agent-profiles.ts`：新增 `GET /api/personas`（列表/搜索）、`GET /api/personas/:id`（详情）。
3. `src/client/pages/AgentLibraryPage.tsx`：人才市场增加「从专家库选用」入口，按域分类浏览 personas，选中后预填充新建表单。
4. `src/server/api/agent-profiles.ts`：`POST /api/agent-profiles` 增加 `personaId` 可选参数，传入时从 persona 库自动填充 soul/principles/capabilities，用户填的字段覆盖自动填充。

**验收标准：**
- 人才市场可浏览 211 个专家，按域分类。
- 选用一个 persona 后，新建员工表单自动填入 soul/principles/capabilities。
- 自动填充的内容来自 persona 文件正文，不再是「你是X，岗位是Y」的拼接。

---

### 任务 3.2：AI 增强单个员工新建

**现状（代码证据）：**
- `src/server/domain/setup-assistant.ts:125-143` 的 `generateAgentProposal`（AI 生成 role/responsibilities/skills/tools）已实现，schema 在第 29-35 行。
- API `src/server/api/setup-assistant.ts:21-28` `POST /api/setup-assistant/agent` 已实现。
- 客户端 hook `src/client/hooks/queries.ts:152-156` `useGenerateAgentProposal` 已定义。
- **但全客户端没有任何组件调用 `useGenerateAgentProposal`**（grep 仅命中 queries.ts 自身）。
- 且即便接线，它也只生成 role/skills/tools，**不生成 soul/principles**。
- `ClaudeSetupGenerator`（`setup-assistant.ts:59-96`）调 `claude` CLI `--json-schema` 输出 structured output，`--max-budget-usd 0.10`。

**目标：** 新建员工时，用户输入岗位名称和简要职责描述，系统调用 AI 自动生成完整的 soul/principles/capabilities/recommendedExecutor/recommendedPermission，用户可编辑后确认。

**改动点：**
1. `src/server/domain/setup-assistant.ts`：`generateAgentProposal` 扩展输出，增加 `soul`（一段人格描述）、`principles`（3-5 条工作原则）、`capabilities`（结构化能力声明）。提示词参考 personas 库中相似域的专家风格。
2. `src/client/components/agents/RecruitmentWizard.tsx`：`new-profile` 分支增加「AI 智能填充」按钮，调用 `useGenerateAgentProposal`，用户输入岗位 + 职责简述后自动填充全部字段。
3. `src/client/pages/AgentLibraryPage.tsx`：「从空白创建」也增加 AI 填充选项。
4. 流程优先级：用户选 persona → 自动填充 → 用户可再用 AI 微调 → 确认。或用户不选 persona → 输入岗位描述 → AI 生成 → 确认。

**验收标准：**
- 输入「小红书文案策划」+ 简述，AI 生成完整专家档案（soul/principles/capabilities/推荐执行器/推荐权限）。
- 生成结果可编辑。
- 生成时参考 personas 库已有相似专家，保持风格一致。

---

### 任务 3.3：扩充 personas 库覆盖缺失行业

**现状（代码证据）：**
- 211 个 persona 主要覆盖工程/营销/产品/安全/数据/设计/QA。缺失：图片制作、影视制作、编辑出版、短视频/小红书专门角色。
- `personas/domains.json` 记录域到 persona 的映射，新增域需更新此文件。

**目标：** 新增以下域的 persona 文件，每个域 8-15 个核心角色：

| 新增域 | 角色示例 |
|---|---|
| `visual/`（图片制作） | 创意总监、平面设计师、插画师、品牌视觉设计师、UI 视觉设计师、修图师、排版设计师、AI 绘图提示词工程师 |
| `video/`（影视制作） | 制片人、导演、编剧、分镜师、剪辑师、调色师、音效设计师、字幕设计师、后期合成师 |
| `publishing/`（编辑出版） | 主编、策划编辑、文字编辑、事实核查员、校对员、排版设计师、版权专员 |
| `social/`（社媒发布） | 小红书运营、抖音策划、B 站 UP 主策划、视频号运营、微博运营、社媒数据分析、爆款标题策划、封面设计师 |

**改动点：**
1. 在 `personas/` 下新建上述目录，每个角色一个 `.md`，格式对齐现有 persona（frontmatter + 正文段落）。
2. 更新 `personas/domains.json` 注册新域。
3. 任务 3.1 的 `persona-library.ts` 自动扫描新目录，无需额外改动。

**验收标准：**
- 人才市场可浏览新增域的专家。
- 新建图片/影视/编辑/社媒公司时，可从对应域选用专家。

---

## 阶段四：外包全自动 AI 对接（P1，核心差异化）

### 任务 4.1：外包自动接受

**现状（代码证据）：**
- 外包决策树全自动选乙方（`outsourcing-decision.ts:113-144`）：①内部能做→internal；②跨公司扫在营公司找有能力乙方（`findVendorCompany` `:82-105`，按 `c.state='online'` 优先）→outsource；③都没有→recruit。
- 但接受需要人工点「接受委派」并选对接人：API `/outsource/contracts/:id/accept` 需 `vendorLiaisonAgentId`（`outsourcing.ts:164-180`，`outsourcing-contract.ts:220-235` 校验对接人属乙方）。
- 客户端 `OutsourcingCenterPage.tsx:215-235` 是按钮触发。无自动接受逻辑（grep 全 server 无 auto-accept）。

**目标：** 契约创建后，乙方公司第一负责人自动接受并自动选对接人（根据任务类型从乙方员工中匹配最合适的人选），进入 in_progress。用户可在公司设置中关闭自动接受（默认开）。

**改动点：**
1. `src/server/domain/outsourcing-contract.ts`：新增 `autoAcceptContract(db, contractId)`：
   - 校验乙方公司在线。
   - 调用能力匹配逻辑从乙方员工中选对接人（按 `requiredCapabilityIds` 匹配员工 `capabilities`，无完美匹配时选第一负责人）。
   - 调用现有 `acceptContract`。
2. `src/server/runtime/coordinator.ts`：tick 中检测 `pending` 状态的外包契约，自动触发 `autoAcceptContract`（可加一个轮询或事件钩子）。
3. `src/server/domain/company.ts`：公司设置增加 `auto_accept_outsourcing` 开关（默认 true）。
4. 前端外包中心保留手动接受入口作为 fallback。

**验收标准：**
- 甲方派发外包任务后，乙方在数秒内自动接受并开始执行，全程无需人工。
- 公司设置可关闭自动接受，关闭后回退到人工接受。
- 自动选的对接人有能力匹配依据，记录在契约中。

---

### 任务 4.2：外包自动验收与返工循环

**现状（代码证据）：**
- 外包完成后 `onOutsourcedTaskCompleted`（`outsourcing-delivery.ts:18-35`）标记契约 `delivered`，然后 `triggerHandoverDiscussion`（`engine.ts:748-749`）发起 task-clarification 讨论。
- 但验收决定（completed/changes_requested/rejected）需要人工点按钮（`outsourcing.ts:188-221`，`OutsourcingCenterPage.tsx:241-249`）。
- 返工已有完整机制：`changes_requested` → 自动 `createReworkTask`（`outsourcing.ts:199-208`），带 feedback + 原验收标准，契约回 in_progress；`revisionRound` 累计。

**目标：** 乙方交付后，甲方第一负责人自动验收：
- 调用 AI 验收（读取交付物 + 验收标准，判断是否达标）。
- 达标 → 自动 `completed`，通知甲方用户。
- 不达标 → 自动 `changes_requested` + `createReworkTask`，带 AI 生成的 feedback 返回乙方。
- 连续返工超过阈值（默认 3 次）→ 转人工验收，避免死循环。
- 硬高危交付物（如涉及发布/部署）→ 转人工验收。

**改动点：**
1. 新增 `src/server/domain/outsourcing-review.ts`：
   - `autoReviewOutsourcing(db, contractId)`：读取交付物清单 + 契约验收标准 + 甲方项目上下文，调用甲方第一负责人（或专用验收 Agent）做 AI 验收，返回 `{verdict: 'completed'|'changes_requested'|'rejected', feedback, confidence}`。
   - `revisionRound` 超过阈值时返回 `needs_human`。
2. `src/server/task-engine/engine.ts`：`onOutsourcedTaskCompleted` 后自动触发 `autoReviewOutsourcing`，按结果调 `submitReview` 或转人工。
3. `src/server/domain/outsourcing-contract.ts`：`submitReview` 保持现有接口，自动验收调用它时传 AI verdict。
4. 公司设置增加 `auto_review_outsourcing` 开关（默认 true）+ `max_auto_review_rounds`（默认 3）。
5. 前端外包中心展示自动验收结果和返工轮次，人工可随时接管。

**验收标准：**
- 乙方交付后甲方自动验收，达标自动完成，不达标自动返工并附 feedback。
- 返工 3 次仍不达标时转人工，不死循环。
- 全程事件可审计（验收 verdict、confidence、feedback 持久化）。
- 用户可关闭自动验收回退到人工。

---

### 任务 4.3：外包契约与 task_dependency 打通

**现状（代码证据）：**
- 外包承接 task 与甲方源 task 之间未自动建 `task_dependency`（`createOutsourcedTask` `outsourcing-contract.ts:315-356` 未调 `addDependency`）。
- 甲方源 task 等乙方交付靠契约状态机 + 人工验收，不是靠 task_dependency 自动唤醒。
- `resumeDependents`（`task.ts:376-397, 620-624`）注释说为补跨公司依赖恢复缺口，但外包入口未接上依赖边。
- 交付时 worktree 源 repo 切到甲方（`engine.ts:234-244`），只读挂载甲方资料（`engine.ts:328-338`），产物 publish 目标指向甲方 rootDir（`engine.ts:608-611`）。

**目标：** 外包承接 task 创建时自动 `addDependency(甲方源task, 乙方承接task)`，乙方完成后甲方源 task 自动唤醒（如果甲方源 task 是 `waiting_dependency` 态）。

**改动点：**
1. `src/server/domain/outsourcing-contract.ts:315-356` `createOutsourcedTask`：创建乙方承接 task 后，调 `addDependency(甲方源taskId, 乙方承接taskId)`。
2. 确认甲方源 task 在派发外包时进入 `waiting_dependency` 态（如未自动进入，在 `outsourcing-decision.ts` 或外包派发入口补充）。
3. **注意：** 验收通过后依赖才视为满足（不是乙方 task completed 就满足，要验收通过）。可能需要在 `areDependenciesMet` 或外包 completion 路径中特殊处理——验收通过时手动调 `resumeDependents`。
4. 验收不通过（返工）时，甲方源 task 保持等待，乙方返工 task 完成后再触发验收。
5. 借助阶段一任务 1.1 的失败传播：乙方 task failed 时甲方源 task 也收到通知。

**验收标准：**
- 甲方派发外包后，甲方源 task 自动进入等待。
- 乙方交付并验收通过后，甲方源 task 自动恢复 queued。
- 验收不通过返工时，甲方源 task 保持等待。
- 乙方 task failed 时甲方收到通知（阶段一兜底）。

---

## 阶段五：公司运营优化报告系统（P1，新需求）

> **用户原话：** 「针对公司的一些组织构建、人员调整、人员能力变更增加、优化提示词，定期给出升级报告，针对某一家公司的，或者手工的。经过一定时间沉淀后自动分析，包括人员的、公司的、近期的。报告简单智能，用户可一键审批通过。比如某个人员应该调整、应该外聘人员、增加人员、发现什么问题，简单陈述。这些不是真实公司，是针对用户管理虚拟 Agent 公司提供便利的方式。」

### 任务 5.1：公司运营优化报告生成

**现状（代码证据）：**
- 反思系统（`reflection.ts`）只沉淀 per-task 经验记忆（LESSON/RULE），**不调整组织、不调人员、不调执行器**（注释 `reflection.ts:12-13`）。
- Inspector（`inspector.ts`）只有「建议扩容镜像」（suggest_mirror），不持久化、不自动跑。
- 员工 rating 自动计算（`employee-rating.ts:30-76`，四维加权 score = 完成任务数×1 + 记忆条数×0.5 + 任职天数×0.2 + 外包验收通过数×3），但只是一个展示用星级，**不影响派工、不影响执行器选择、不影响权限**。
- 组织调整全靠用户手动操作（`company.ts:158` 章程更新、`recruitment.ts` 招募、`handover.ts` 交接均为用户主动）。
- 强制复盘（`report.ts`）是项目级任务复盘（每完成 20 个 task 触发 `review_paused` + 聚合看板 + 备注转修正 Task），不是公司级组织优化报告。
- 公司驾驶舱（`company-cockpit.ts`）实时聚合 roleGaps/risks/nextAction，按需查询非定期。
- `company-cockpit.ts:25-27` 能算出「公司模板要求岗位但尚未任职」的缺口，但只是提示用户去招募页，不自动招募。

**目标：** 系统定期（或手动触发）为每家公司生成一份简洁的运营优化报告，内容包括：
- 近期工作概况（完成数、失败数、平均耗时、成本）
- 人员表现排名和异常（高产出/高失败率/长时间无产出）
- 组织建议（建议增加人员、建议调整人员能力、建议更换执行器、建议扩容镜像、建议调整工作流）
- 人员能力变更建议（某专家 rating 低 + 失败率高 → 建议调整推荐执行器或补充能力）
- 发现的问题（卡死任务、长期等待、审批积压、预算异常）

报告简洁智能，用户可一键审批通过，通过后自动执行组织调整。

**改动点：**
1. 新增迁移：`company_optimization_report` 表（id/companyId/periodStart/periodEnd/reportJson/status=generated/approved/rejected/dismissed/createdAt）+ `report_action_items` 子表（reportId/actionType/description/reason/expectedEffect/params_json/status=approved/rejected/pending_executing/executed/failed）。
   - actionType 枚举：`add_employee` / `adjust_employee` / `adjust_executor` / `expand_mirror` / `adjust_workflow` / `remove_employee` / `adjust_permission` / `prompt_optimization`
2. 新增 `src/server/domain/optimization-report.ts`：
   - `generateOptimizationReport(db, companyId, periodStart?, periodEnd?)`：聚合近期数据（task 统计、员工表现、inspector 告警、反思记忆、预算使用、等待/卡死/失败 task），调 AI 生成结构化报告。
   - AI 提示词要求：简洁、具体、可操作；每条建议带理由和预期效果；不超过 10 条建议。
   - 建议 action types 映射到可执行操作。
3. 定期触发：coordinator 中新增定时（默认每 24 小时或每完成 50 个 task，可配置）为每家 online 公司生成报告。
4. 手动触发：API `POST /api/companies/:id/optimization-report`（立即生成当前周期报告）。
5. AI 生成时参考：
   - 员工 rating 和失败率（`employee-rating.ts`）
   - inspector 告警（阶段一任务 1.3 持久化的告警）
   - 反思记忆（`reflection.ts` 的 LESSON/RULE）
   - 公司驾驶舱数据（`company-cockpit.ts` 的 roleGaps/risks/nextAction）
   - 任务执行统计（完成数、失败数、耗时、成本）
   - 长期等待/卡死 task 列表

**验收标准：**
- 系统定期为每家公司生成优化报告，包含人员表现、组织建议、问题发现。
- 报告简洁（不超过 10 条建议），每条带理由。
- 用户可手动触发立即生成。
- 报告持久化，可查看历史报告。

---

### 任务 5.2：报告一键审批与自动执行

**现状（代码证据）：**
- 无组织自动调整机制。所有组织变更（章程、人员增减、镜像扩容、权限/执行器变更）需用户手动操作。
- 现有可复用的操作：`recruitment.ts`（招募）、`handover.ts`（交接，四阶段 drafting→awaiting→receiving→completed）、`agent-profile.ts:169-183`（updateAgentProfile）、`executor-profile.ts:90-97`（bindEmployeeExecutorProfile，需公司下班）、`workflow.ts:140-211`（saveWorkflow，需公司下班 `isOrgLocked`）。
- 公司状态：下班（off）允许修改组织，上班（online）组织配置锁定（`company.ts` `isOrgLocked`）。

**目标：** 用户查看报告后可一键审批通过，系统自动执行被批准的建议操作。也可逐条选择、修改或拒绝。

**改动点：**
1. `src/server/api/optimization-report.ts`（新增）：
   - `GET /api/companies/:id/optimization-reports`（列表）
   - `GET /api/optimization-reports/:id`（详情含 action items）
   - `POST /api/optimization-reports/:id/approve`（一键审批通过所有 action items，或传入选中的 item ids）
   - `POST /api/optimization-reports/:id/dismiss`（忽略）
   - `POST /api/optimization-reports/:id/items/:itemId/modify`（修改单条建议参数）
2. `src/server/domain/optimization-report.ts`：新增 `executeApprovedActions(db, reportId, selectedItemIds?)`：
   - 按 action type 执行：
     - `add_employee`：从 personas 库或 AI 生成新员工档案，自动招募到公司（复用 `recruitment.ts`）。**必须公司下班状态才能加人**，若公司在线则标记为 pending，等下次下班时执行。
     - `adjust_employee`：调整员工 capabilities/responsibilities（需公司下班）。
     - `adjust_executor`：调整员工绑定执行器 profile（需公司下班，复用 `bindEmployeeExecutorProfile`）。
     - `expand_mirror`：增加项目镜像（上班期间可做，不改变组织语义）。
     - `adjust_workflow`：修改工作流图（需公司下班，复用 `saveWorkflow`）。
     - `remove_employee`：启动交接流程（复用 `handover.ts` `offboardEmployee`）。
     - `adjust_permission`：调整权限策略（需公司下班）。
     - `prompt_optimization`：优化员工 soul/principles（AI 重写，需公司下班，复用 `updateAgentProfile`）。
   - 每个操作执行后记录结果（成功/失败/pending）。
   - 需要公司下班的操作若公司在线 → 标记 pending，提示用户「下次下班时自动执行」或「立即下班执行」。
3. 前端新增公司优化报告页面：报告列表 → 报告详情 → action items 卡片展示（每条含类型/描述/理由/预期效果/执行状态）→ 一键审批按钮 + 逐条选择 + 修改参数。

**验收标准：**
- 用户一键审批后，被批准的建议自动执行。
- 需公司下班的操作在下次下班时自动执行，或提示用户立即下班。
- 每个操作的执行结果可查看。
- 用户可逐条选择、修改参数、拒绝。

---

### 任务 5.3：提示词优化建议

**现状（代码证据）：**
- 员工 soul/principles 新建时从 personas 库填充或 AI 生成（阶段三完成后），但运行中不会根据表现自动优化。
- 反思系统沉淀的 LESSON/RULE（`reflection.ts:285-317`）可作为优化依据但未用于改写 persona。
- `agent_profile_base` 表存版本快照（`agent-profile.ts:149-151`），`restoreSnapshot` 可回滚（`agent-profile.ts:271`）。

**目标：** 报告中包含「提示词优化建议」——基于员工近期表现和反思记忆，AI 分析是否需要优化 soul/principles。用户审批后自动重写 persona（保留原始版本可回滚）。

**改动点：**
1. `optimization-report.ts` 生成报告时，对每个员工：
   - 读取近期 task 的反思记忆（LESSON/RULE）。
   - 读取失败率和失败原因。
   - AI 判断是否需要优化提示词，需要则生成优化后的 soul/principles 草稿。
2. action type `prompt_optimization`：执行时 `updateAgentProfile` 写入新 soul/principles，同时 `agent_profile_base` 存版本快照（复用现有版本机制 `agent-profile.ts:149-151`）可回滚。
3. 前端报告展示优化前后对比，用户可查看差异后决定是否批准。

**验收标准：**
- 高失败率员工的报告含提示词优化建议。
- 优化后的 soul/principles 可回滚到原版本。
- 用户可查看优化前后差异。

---

## 阶段六：公司类型扩展与项目 Playbook（P2）

### 任务 6.1：新增图片/影视/编辑/社媒公司模板

**现状（代码证据）：**
- 6 个内置模板（`company-templates.ts:108-175`）：general/software/content/novel/marketing/consulting。
- 模板包含：部门 + 岗位 + isLead + projectName + firstTaskTitle（`TEMPLATE_BASES`），经 `withCollaboration`（`:44-106`）自动补齐 org/communication 关系与 workflow 节点。
- 知识模型/能力绑定/自动化/展示元数据在 `template-registry.ts`（`KNOWLEDGE_MODELS` `:51-235`、`TEMPLATE_META` `:237-267`、`buildPackage` `:312-335`）。
- 客户端展示在 `src/client/domain/company-templates.ts:25-98`。
- 新增内置模板要改 4-5 处。

**目标：** 新增 4 个公司模板：

| 模板 ID | 名称 | 部门 | 核心岗位 |
|---|---|---|---|
| `visual` | 图片制作公司 | 创意部、制作部、质量部 | 创意总监(lead)、平面设计师、插画师、AI 绘图工程师、修图师、质量审核员 |
| `video` | 影视制作公司 | 策划部、制作部、后期部 | 制片人(lead)、编剧、分镜师、剪辑师、调色师、音效师、后期合成师 |
| `publishing` | 编辑出版公司 | 策划部、编辑部、校审部 | 主编(lead)、策划编辑、文字编辑、事实核查员、校对员、排版设计师 |
| `social` | 社媒运营公司 | 策划部、创作部、运营部 | 运营总监(lead)、内容策划、文案写手、封面设计师、数据分析师、平台运营专员 |

**改动点：**
1. `src/server/domain/company-templates.ts:7`：`CompanyTemplateId` 联合类型加 `visual|video|publishing|social`。`TEMPLATE_BASES:108-175` 加 4 份（部门/员工/isLead/projectName/firstTaskTitle）。`withCollaboration` 自动补关系和工作流。
2. `src/server/domain/template-registry.ts:51` `KNOWLEDGE_MODELS` 加 4 个知识模型（图片素材/视频时间线/稿件版本/社媒排期）；`:237` `TEMPLATE_META` 加元信息；`:337` 数组加 4 个 id。
3. `src/client/domain/company-templates.ts:25` `COMPANY_TEMPLATE_OPTIONS` 加展示项；`:49` `PROJECT_CREATION_PRESETS` 加项目预设。
4. 每个模板的 `taskProtocol`（输入/输出字段）和 `artifactTypes` 按行业定义（如图片公司 artifact = 原图/缩略图/风格说明；影视公司 = 脚本/分镜/素材/成片；社媒 = 标题/正文/封面/标签/排期）。

**验收标准：**
- 创建公司向导可选 10 个模板（原 6 + 新 4）。
- 每个新模板生成完整组织架构（部门 + 员工 + 工作流 + 权限）。
- 新模板的 artifact 类型和验收标准符合行业特征。

---

### 任务 6.2：项目 Playbook 概念（轻量实现）

**现状（代码证据）：**
- 同一家公司所有项目走同一套工作流（`workflow.ts` 定义公司级 workflow）。
- 项目只管 rootDir（`project.ts`），不绑定 playbook 或工作模式。

**目标：** 项目创建时可选 Playbook（项目工作模式），不同 Playbook 对应不同的阶段定义、成果类型和验收标准。Playbook 是模板级别的配置，不新建大表，用项目元数据字段承载。

**改动点：**
1. `src/server/domain/project.ts`：项目增加 `playbook_id` 字段（可空，默认继承公司模板默认 playbook，迁移新增）。
2. 新增 `src/server/domain/playbooks.ts`：定义 Playbook 目录（如 `software-feature`/`novel-chapter`/`image-campaign`/`short-video`/`social-post`/`editorial-article`），每个 playbook 包含 `phases`/`artifactTypes`/`approvalGates`/`defaultWorkflow`。
3. `src/client/pages/ProjectPage.tsx`：新建项目时选 playbook，影响后续阶段展示和验收。
4. Playbook 可由公司模板预置，也可用户自定义（存为公司级配置）。

**验收标准：**
- 同一家内容公司可创建「小红书图文」和「长篇专栏」两种 playbook 的项目，流程不同。
- playbook 决定项目的阶段、成果类型和审批节点。

---

## 阶段七：编排能力增强（P2）

### 任务 7.1：给第一负责人增加并行派发工具

**现状（代码证据）：**
- `outboundTasks`（`result-schema.ts:10-16,28`，JSON schema `:43-56`）支持一次声明多个子任务，父 task `waiting_dependency` 等全部完成。
- 但没有显式的 `spawn_tasks`/`join_policy` 工具，join 策略只有「全部完成」一种（`areDependenciesMet` `task.ts:357-367` 只认全 completed）。
- `task_dependency` 表（`migrations/0001_init.sql:218-223`）是多对多，支持 N 进 1 的 join。

**目标：** 第一负责人可通过工具一次并行派发多个子任务给不同专家，指定 join 策略，父任务按策略自动汇总。

**改动点：**
1. `src/server/executors/tools/registry.ts`：新增 `spawn_tasks` 工具：
   - 参数：`tasks[]`（每个含 title/assignee或requiredCapability/priority/inputProtocol）、`joinPolicy`（all/any/quorum/best-effort）、`aggregateMode`（summary/artifacts/structured）。
   - 一次创建多个子 task，父 task 自动进 `waiting_dependency`。
2. `src/server/domain/task.ts`：`waiting_dependency` 恢复逻辑扩展支持 join policy：
   - `all`：所有子 task 完成（现有行为）。
   - `any`：任一子 task 完成即恢复，其余取消。
   - `quorum`：多数完成即恢复（需记录 quorum 阈值）。
   - `best-effort`：不阻塞父 task，子 task 异步执行，结果写回父 task 上下文。
3. join policy 存在 `task` 表新字段或 `task_dependency` 扩展字段。
4. 汇总：父 task 恢复时，将子 task 的 summary/artifacts 按 `aggregateMode` 聚合注入父 task 上下文。

**验收标准：**
- 第一负责人可一次派 3 个研究子任务给不同专家，指定 `joinPolicy: all`，3 个都完成后父任务恢复并收到汇总。
- `joinPolicy: any` 时第一个完成即恢复，其余自动取消。
- 简单任务不强制拆分（第一负责人自行判断是否需要 spawn）。

---

### 任务 7.2：能力路由（自动选专家）

**现状（代码证据）：**
- `createTask`（`task.ts:267-284`）需显式指定 `assignee`，校验 `assignee.companyId === project.companyId`。
- `requiredSkillIds`/`requiredCapabilityIds` 字段存在但未用于自动匹配专家。
- `capability_binding` 表记录了员工与能力的绑定（`template-registry.ts:269-298` `capabilityBindingsFor` 从知识模型字段反推）。
- `agent.capabilities` 字段存在于 `agent_profile` 表。

**目标：** 派发任务时可只指定 `requiredCapabilities` 不指定 assignee，系统自动从公司在线员工中匹配最合适的专家。匹配失败时上报第一负责人。

**改动点：**
1. 新增 `src/server/domain/agent-router.ts`：
   - `findBestAssignee(db, companyId, requiredCapabilities, taskType?)`：按 `capability_binding` + `agent.capabilities` + 员工在线状态 + 当前负载评分，返回候选。
   - 评分维度：能力匹配度 + 角色匹配 + 历史质量（rating）+ 执行器可用性 + 负载（当前排队 task 数）。
2. `src/server/domain/task.ts:267-284` `createTask`：assignee 为空但 `requiredCapabilities` 非空时，调 `findBestAssignee` 自动分配。匹配失败抛错或 fallback 到第一负责人。
3. `spawn_tasks` 工具支持 `requiredCapabilities` 代替 `assignee`。

**验收标准：**
- 第一负责人派任务时可不指定人，只指定「需要代码探索能力」，系统自动分给 Explorer 类专家。
- 自动分配有评分依据，记录在 task 事件中。
- 所有候选都不在线时 fallback 到第一负责人并提示。

---

### 任务 7.3：Discussion 并行轮次（可选增强）

**现状（代码证据）：**
- Discussion（`discussion.ts:252-331`）串行轮流发言，同一时刻仅一个发言者。
- 每次发言 = 一个特殊 task（`inputProtocol.discussion:true`），完成后 `completeDiscussionTurn`（`engine.ts:722-737`）创建下一个发言者 task。
- 7 类场景（`DISCUSSION_SCENARIOS` `:52-95`）：help-request / task-clarification / quality-review / task-breakdown / standard-alignment / conflict-resolution / brainstorm。

**目标：** 增加 `parallel-round` 模式——同一轮多个参与者并行发言，轮次结束后由 moderator/synthesis task 汇总，再进入下一轮或结论。适合 brainstorm 和 quality-review 场景。

**改动点：**
1. `src/server/domain/discussion.ts`：`createDiscussion` 增加 `mode: 'sequential' | 'parallel'`（默认 sequential，向后兼容）。
2. parallel 模式：同一轮为所有参与者各建一个发言 task，全部完成后再建 synthesis task，synthesis 完成后进入下一轮。
3. `src/server/task-engine/engine.ts:722-737` 的轮转逻辑增加 parallel 分支。

**验收标准：**
- brainstorm 讨论可设 parallel 模式，4 个参与者同时发言，汇总后进入下一轮。
- sequential 模式行为不变。

---

## 明确不做的事

1. **不重写** Task 状态机、Executor 抽象、审批体系、Session 恢复机制——这些是稳定的通用内核。
2. **不新增** event sourcing 统一事件模型——当前双轨（持久 task_event + realtime）够用，后续再评估。
3. **不把 worktree 改成通用 Artifact Workspace**——等图片/影视公司真正需要时再做。
4. **不照搬 Sisyphus 的 tmux/文件状态方案**——沿用数据库 + Executor + Realtime。
5. **不把 Sisyphus 作为平台固定角色**——它是第一负责人的编排能力，不同公司叫法不同（总编/制片人/创意总监/主编）。
6. **不强制所有任务走并行编排**——简单任务继续单 Agent 快速路径，复杂任务才 spawn。

---

## 执行优先级与依赖关系

```
阶段一（子任务失败兜底）  ←  P0 最紧急，独立可做
阶段二（执行器三级默认）  ←  P0，独立可做
阶段三（personas 接入）   ←  P0，独立可做
    ↓
阶段四（外包全自动）      ←  依赖阶段二（乙方选执行器）
阶段五（运营优化报告）    ←  独立可做，但引用阶段一 1.3 的 inspector 告警
    ↓
阶段六（新公司模板）      ←  依赖阶段三（新模板用新专家 personas）
阶段七（编排增强）        ←  依赖阶段二+三（能力路由需执行器和专家库就绪）
```

**第一、二、三阶段可并行开发。** 第四阶段在第二阶段完成后开始。第五阶段独立可做。第六阶段在第三阶段完成后开始。第七阶段在第二+三阶段完成后开始。

---

## 给执行者的注意事项

1. **每个任务都有代码证据**（文件路径 + 行号），执行前先读对应文件理解现状。
2. **数据库迁移遵循项目约定**：文件名 `YYYYMMDDHHMMSS_描述.sql`，写在 `src/server/db/migrations/`。
3. **先跑现有测试**确认基线绿：`npm test`。改完跑相关测试（`tests/integration/` 和 `tests/unit/` 下有 ask-colleague、discussion、restart-recovery、outsourcing、run-command 等测试）。
4. **前端改动遵循现有组件风格**（React 19 + 现有 UI 组件库）。
5. **AI 生成/验收功能要注意成本**——复用现有 `--max-budget-usd` 机制。
6. **每个阶段完成后做一轮冒烟测试**：创建公司 → 新建项目 → 派发任务 → 观察执行 → 验收交付，确认端到端可用。
7. **阶段一是最紧急的**——当前子任务失败会永久卡死，这是系统可用性的根本问题，应优先完成。

---

## 关键文件索引（执行者快速定位用）

| 模块 | 关键文件 |
|---|---|
| Task 状态机与依赖 | `src/server/domain/task.ts` |
| Task 引擎 | `src/server/task-engine/engine.ts` |
| 运行时协调器 | `src/server/runtime/coordinator.ts` |
| 执行器 Manifest | `src/server/executors/manifests.ts` |
| Executor Profile | `src/server/domain/executor-profile.ts` |
| 凭据三层解析 | `src/server/domain/credential-store.ts` |
| 能力探针 | `src/server/domain/capability-probe.ts` |
| 连通探针 | `src/server/domain/connection-probe.ts` |
| 系统设置 | `src/server/domain/setting.ts` |
| Agent Profile | `src/server/domain/agent-profile.ts` |
| 公司模板 | `src/server/domain/company-templates.ts` |
| 模板注册表 | `src/server/domain/template-registry.ts` |
| 蓝图生成 | `src/server/domain/template-architect.ts` |
| AI 建议生成 | `src/server/domain/setup-assistant.ts` |
| 招募 | `src/server/domain/recruitment.ts` |
| 交接 | `src/server/domain/handover.ts` |
| 外包决策 | `src/server/domain/outsourcing-decision.ts` |
| 外包契约 | `src/server/domain/outsourcing-contract.ts` |
| 外包交付 | `src/server/domain/outsourcing-delivery.ts` |
| 反思系统 | `src/server/domain/reflection.ts` |
| Inspector | `src/server/domain/inspector.ts` |
| 强制复盘 | `src/server/domain/report.ts` |
| 公司驾驶舱 | `src/server/domain/company-cockpit.ts` |
| 员工评级 | `src/server/domain/employee-rating.ts` |
| Discussion | `src/server/domain/discussion.ts` |
| 权限守卫 | `src/server/domain/permission.ts` |
| AI 审批 | `src/server/domain/ai-approval.ts` |
| 工具注册表 | `src/server/executors/tools/registry.ts` |
| 上下文装配 | `src/server/executors/context.ts` |
| Watchdog | `src/server/task-engine/run-watchdog.ts` |
| 生命周期事件 | `src/shared/lifecycle-events.ts` |
| 常量 | `src/shared/constants.ts` |
| personas 库 | `personas/*.md` + `personas/domains.json` |
