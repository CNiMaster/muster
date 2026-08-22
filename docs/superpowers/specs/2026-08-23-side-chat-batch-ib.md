# 批次 I-b：侧边辅助对话 /side（协议第二租户）

状态：proposed（2026-08-23；来源=批次计划 B 档「侧边辅助对话 /side 移入批次 I（协议第二租户）」）

## 背景与定位

muster 的三种对话载体（项目任务对话/群聊/探讨）**全部创建任务**（群聊落收件箱项目、探讨每轮一个 turnTask）。侧边对话补最后一块：**免任务的快速问答**——不建 task、不进引擎、不占执行器健康、不进反思记忆。用户在干活间隙问一句「这个报错什么意思」不该惊动组织。

「第二租户」：面板插件（I-a）是右栏第一租户，侧边对话是第二个——右栏 InspectorGroup 常驻轻入口 + `/side` 独立路由页承载完整历史。

## 模型

### 1. 数据：conversation_message 扩 scope 'side'

- 迁移 `20260823130000_side_chat.sql`：conversation_message 表重建，scope_kind CHECK 扩 `'side'`（沿用 plugin 表重建同款模式；表上有索引一并重建）。
- 每工作台**一条**侧边会话：scope_id=workbenchId；消息 role=user/assistant，author='user'/答复者 agent id（见下）。
- listMessages 复用（kind='side'）；清空=物理 DELETE 该 scope（用户隐私口：随手问可一键抹）。

### 2. 域：src/server/domain/side-chat.ts

- `postSideMessage(db, workbenchId, content)`：
  1. 事务一：插 user 消息；
  2. 调 `callLlm`（平台级，tier economy 省成本；超时 60s）：system=轻助手人设（第一负责人名义+「侧边对话：快速问答，不建任务不调工具」边界说明），user=近 12 轮历史转录+本轮问题（callLlm 两消息接口，历史拼进 user）；
  3. 事务二：插 assistant 消息（author=负责人 agent id，人设名义）。
- **失败降级**：callLlm 抛错（无凭据/超时）→ assistant 消息落明确指引文案（「未配置模型凭据/调用失败——到 设置→凭据 配置 OpenAI 兼容 key」）——不 500、不留空转。
- `clearSideChat(db, workbenchId)`：DELETE 全部 side 消息。
- 答复者=第一负责人（无则 ensureWorkspaceStaff().leadAgentId）：组织语义不缺位——名义归属负责人，用户认知一致；但**不派任务不写待办**。

### 3. API：src/server/api/side.ts

- `GET /api/side/messages`（正序，最近 200 条）
- `POST /api/side/messages` `{content}` → `{user, assistant}`（同步等答复；60s）
- `DELETE /api/side/messages` → 清空
- 鉴权口径与现有 /api 相同（本地单用户）；无新权限面（无任务无工具无文件）。

### 4. UI

- **/side 路由页**：AppShell 内新页——标题「侧边对话」+说明行（免任务/不入记忆/一键清空）；消息列表（MessageBubble 简版或轻量气泡：user 右/assistant 左）；底部输入框（单行自增高+发送；Enter 发送 Shift+Enter 换行——不复用全功能 PromptComposer，侧边对话刻意轻）；「清空会话」按钮（确认弹窗）。
- **右栏第二租户入口**：ProjectContextInspector 新 InspectorGroup「侧边对话」（默认折叠）：折叠态=最近 1 条摘要；展开=最近 3 条气泡+单行输入（快捷问答，走同一 API）+「展开全部 ↗」链接 /side。
- 左栏导航加 /side 入口（⚡ 独立任务区下方，图标 💬）。

### 5. 边界与不做

- 不做：工具调用/附件/@引用/模式药丸（侧边对话刻意无任务语义）；流式（v1 同步，等待期按钮 loading）；多侧边会话（每工作台一条，v2 按需）；进反思/记忆（一次性问答，明确不沉淀）。
- 模型凭据未配置时：回答=指引文案（e2e 断言锚点）。

## 测试

- 域：postSideMessage 落两条消息+负责人 author；callLlm 失败降级文案；clearSideChat 清空；历史截 12 轮。
- API 集成：GET/POST/DELETE 往返+空 content 400。
- 组件：/side 页渲染+发送回调+清空确认；右栏组折叠态/展开态/链接。
- e2e：/side 发送「你好」→ 用户气泡出现 + 降级指引文案出现（无凭据环境确定性断言）。

## 实施记录

（待实施）
