# 批次 I-b 实施计划（执行 specs/2026-08-23-side-chat-batch-ib.md）

前置：批次 I-a 已合 main。worktree：`git worktree add ../muster-side-chat -b feat-side-chat`（node_modules 软链）。一段交付，四门全绿合并；spec 同步实施记录。

## 步骤

1. **迁移** `src/server/db/migrations/20260823130000_side_chat.sql`：conversation_message 表重建，scope_kind CHECK 扩 `'side'`（先读 20260819000000 的重建版 DDL 抄全列；索引一并重建——先 grep 该表现有全部索引名）。
2. **域** `src/server/domain/side-chat.ts`：
   - `SIDE_SCOPE_KIND='side'`；答复者解析 `getWorkbench().firstAgentId ?? ensureWorkspaceStaff(db).leadAgentId`；
   - `postSideMessage(db, workbenchId, content)`：事务插 user → callLlm（tier economy，system=轻助手人设+边界说明，user=近 12 轮转录+本轮，timeoutMs 60s）→ 事务插 assistant（author=负责人 id）；callLlm 抛错 → assistant 落降级指引文案（不抛）；
   - `listSideMessages(db, workbenchId, limit=200)`（复用 listMessages kind='side' 或直查）；`clearSideChat`。
   - conversation.ts：ScopeKind 类型扩 `'side'` + assertScope 认 side（getWorkbench 校验 id）。
3. **API** `src/server/api/side.ts`：GET/POST/DELETE `/api/side/messages`（zod content min1；POST 返回 {user, assistant}）；server.ts 挂路由（grep pluginsRouter 挂载点同款）。
4. **UI**：
   - `/side` 页 `src/client/pages/SideChatPage.tsx`：标题+说明行+清空（Modal 确认）+气泡列表（user 右/assistant 左，assistant 首行显示负责人名）+底部单行自增高输入（Enter 发送/Shift+Enter 换行/发送中 loading）；App 路由表加 /side（找路由定义文件——react-router 结构实现时核）。
   - 右栏租户组：ProjectContextInspector 新 InspectorGroup「侧边对话」（默认折叠）：折叠=最近 1 条摘要；展开=最近 3 条+单行输入+「展开全部 ↗」/side；位置在「面板插件」组之后。
   - 左栏导航 /side 入口（⚡ 独立任务区下方，实现时按 ProjectWorkNavigation 结构挂）。
5. **hooks**：queries.ts 加 `useSideMessages`/`useSendSideMessage`/`useClearSideChat`。
6. **测试**：`tests/integration/side-chat.spec.ts`（域往返+降级+清空+API 400）；`tests/unit/side-chat-page.spec.tsx`（渲染/发送回调/清空确认）；e2e `tests/e2e/side-chat.spec.ts`（/side 发送→用户气泡+降级文案）。
7. spec 实施记录+四门（smoke/e2e 带 MUSTER_KEEPAWAKE=off，vitest 不带）→合并。

## 风险与提醒

- callLlm 网络调用不得进 better-sqlite3 事务（事务内 async 会卡死库）——两个独立事务包插消息。
- e2e 环境无凭据：断言降级文案（确定性）。
- 不改群聊/项目对话语义；listMessages 的 'side' 分支不影响既有 scope。
