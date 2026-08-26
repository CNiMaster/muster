# 宿主命令·专家对话·员工配置卡 实施计划

- 日期：2026-08-26（第二轮，接 agent-host-parity 批次后的用户新拍板）
- 依据：会话定调——斜杠命令三分类（A 本地 UI/B 模板展开/C 宿主操作）；/compact 按
  执行器能力三路分流；专家进对话菜单；员工页执行配置卡（选项全部来自设置预配置）。

## 批次 I：宿主命令层 + /compact

- I1 信号通道：`ToolLoopOptions.compactRequest?: { requested: boolean }`（共享可变 flag）；
  runToolLoop 每轮循环开头检查——true 则先压缩（语义/机械复用 A2）再继续，并复位 flag。
  engine pumpThread 创建 flag 注册 `TaskEngine.activeCompactFlags: Map<taskId, flag>`，终态清理。
- I2 API：`POST /api/tasks/:taskId/compact` 三路分流：
  - running + API 型 → engine.requestCompact(taskId)（置 flag，下轮边界生效）
  - CLI 型 codex（session.compact 且 adapter compactSession 已实现）→ 调 adapter.compactSession
  - 其余（claude-code 未实现/antigravity 等无能力）→ 409 附"该执行器无可靠压缩接口"说明
- I3 composer：handleSend 拦截 `/^\/compact(\s+@(.+?))?(\s+--all)?\s*$/`：
  - `--all` → 项目全部 running 任务逐个压缩
  - `@名字` → agents 模糊匹配显示名→agentId→该员工活跃任务
  - 默认 → 当前对话对象（selectedAgentId）或 activeRuntimeTask
  - 内置命令候选加 /compact（宿主命令组）。@ 候选菜单复用现有 mention 正则（空格后已触发）。
- 空闲线程的持久历史压缩**不在本批**（涉及 thread-message 结构改造，记后续）。

## 批次 J：专家进对话菜单

- 数据源：GET /api/projects/:id/specialists（listProjectSpecialists 已存在，staff tier
  +active+agent_id 非空=常驻专家真实 agent 实体）。
- PromptComposer 对话人菜单加「在项目专家」分组（常驻+借调；蜂群匿名工蜂不进——一次性
  执行体对话语义不成立）；选中=selectedAgentId 设为专家 agentId，发送链路（工作单携带
  agentId）自动复用，零新增通道。

## 批次 K：员工页执行配置卡

- AgentExecutorJson 扩字段：thinking?/contextWindowTokens?/maxOutputTokens?（员工级默认，
  消息级覆盖仍优先；PATCH /api/agents/:id 透传已支持）。
- ProjectEmployeeWorkspace 加「执行配置」卡：
  | 配置 | 控件 | 选项来源 |
  |---|---|---|
  | 绑定执行器 | 下拉 | 执行器中心已注册档案（PUT employees/:id/profile/:profileId 已有） |
  | 模型 | 下拉 | 选中档案的 config.models（换档案选项联动清空） |
  | 思考等级 | 档位 | off/low/med/high |
  | 上下文窗口 | 下拉 | 预设档 32k/64k/128k/200k |
  | 最大输出 | 下拉 | 预设档 4k/8k/16k/32k |
- 四快捷入口：工具档（bee/staff/验收）/权限策略绑定/人设穿戴/记忆看板（profileId 过滤链接）。
  已有机制的入口聚合，缺绑定的补最小端点。

## 门

每批 tsc -b --force + vitest 全量（核对 Tests passed ≥ 1822+新增）；白名单提交。
