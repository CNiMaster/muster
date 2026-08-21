# UI 改版批次 F：右栏信息架构 + 预览容器 + 超时自动继续 + 轻量体验包

状态：proposed（2026-08-22 立项；来源：对照 zcode docs/changelog 的 UI 评估轮）

## 背景与目标

右栏（ProjectContextInspector）承载重要信息但排版无规则：三 Tab 互斥导致扫视不完整、四张卡嵌在 `selectedTask` 分支内、空态占位、折叠机制缺失、宽度变量有 min/max 范围却无拖拽手柄。本批次四件事：

1. **F1 右栏三层信息架构**（去 Tab 改纵向折叠流）
2. **F2 左右栏宽度拖拽补完**
3. **F3 预览容器 v1**（右栏直开图片/Markdown/HTML，经服务端安全代理）
4. **F4 waiting_input 超时自动继续**（默认一直等；设置可开；任务级快调 5/10/30 分钟）

外加 F5 轻量体验包（会话回到底部、Markdown 表格横滚+图片放大、粘贴表格保纯文本）。

产品规则一句话：**有数据才出现，有变化才提醒，看过就安静。**

## F1 右栏三层信息架构（去 Tab）

自上而下：

1. **瞬时层**：🚨 需要你关注（`attentionTotal>0` 才出现，原有逻辑）
2. **当前选中对象头**：employee 视图=员工卡；否则=当前任务头卡（#seq/title/brief/StateBadge+标记完成）
3. **折叠组「任务现场」**（selectedTask 存在时默认展开）：deliverables checklist + 验收进度 + 蜂群拓扑
4. **折叠组「班底与打法」**（默认收起，徽章=specialists+matches）：专家池（**不再依赖 selectedTask**）+ 蓝图匹配（保留 `!uiSimple` 门禁）
5. **折叠组「产物」**（默认收起；**空态整组不渲染**）：条目点击右栏预览（F3）
6. DiscussionPanel 原样（自动展开第一条 active 不变）

- 折叠用 `<details class="inspector-collapse">`（global.css 现成样式，此前零消费者）
- 展开状态 localStorage `muster:inspector-collapse:<groupId>`（挂载读/点击写，仿 mu-trace-expand 模式）
- 简单/专业差异收敛为密度：蓝图卡不渲染（已有）+ 简单模式按需组默认全收起
- 修复：`activeTask` 的 `t.id === selectedTask?.id` 工作单 id 对项目任务 id 永不命中 → 改 `t.projectTaskId === selectedTask?.id`
- 清死代码：`projectState`/`onChatWithAgent` 死 props、`.active-agent-*` 死样式、测试陈旧 `companyId`

## F2 宽度拖拽

nav 右缘/inspector 左缘 6px `.workbench-resizer`；pointerdown 捕获+move 实时+pointerup 才持久化；clamp 左[200,360]右[240,420]；双击重置默认 248/304；≤1179 抽屉态隐藏。

## F3 预览容器 v1

- 服务端 `GET /api/projects/:id/artifacts/preview?path=`：`resolveArtifactPath` + `isPathAllowed` 双校验（口径同 files/tree）；`.html/.htm` 走此端点并加 CSP（`default-src 'none'; style-src 'unsafe-inline' 'self' data:; img-src 'self' data:`）+ `X-Content-Type-Options: nosniff`；图片/音视频/PDF sendFile。现有 `/raw` 不动（有既有消费方）
- 客户端 `InspectorPreviewHost`：URL `?preview=<path>` 驱动；类型分派复用 ArtifactsPage 正则（image/pdf/video/audio/md）；「放大」Modal size xl、「在画廊打开」、关闭
- 已知限制：Markdown 内嵌相对路径图片不代理；worktree 未合并分支产物不可预览（无现成路由，留后续）

## F4 waiting_input 超时自动继续

- 迁移：task 表加 `auto_continue_minutes INTEGER NULL`（NULL=跟随全局；0=本任务一直等）、`auto_continue_stopped INTEGER NOT NULL DEFAULT 0`
- 全局设置 `waiting_auto_continue_minutes` 默认 **0=一直等**（用户定案：默认不开启）
- 生效分钟 = `task.auto_continue_minutes ?? 全局`；等待起点 = `task_suspension.created_at`（两入口均落挂起行；缺行回退 `updated_at`）
- **任何用户交互永久停计（本轮）**：clarify/align 答复、显式停止计时、pause/cancel → `auto_continue_stopped=1`；再进 waiting_input 重置 0
- 到期动作：`answerClarification(source:'auto', answer:'确认，请继续执行')` + system 消息留痕「超时未答复，已自动继续执行」；竞态由 answerClarification 的 state 校验兜底
- 评审庭辩论进行中的任务跳过本轮
- 任务级快调 API：`POST /api/tasks/:id/auto-continue`（minutes: 5/10/30/0/恢复跟随）
- 挂点：coordinator tick 内 `reportStaleWaitingTasks` 旁独立 try/catch；与 30min STALE 上报自然分层
- 前端：Task DTO 附 `waitingSince`/`autoContinueMinutes`/`autoContinueStopped`（仅 waiting_input 任务）；等待态 Badge 旁 mm:ss 倒计时+「停止计时」；ConversationPanel/ClarifyCard 倒计时条+分钟快调

## F5 轻量体验包

1. ConversationPanel 离底 >240px 显示「↓ 回到最新」；贴底时新消息保持贴底
2. MarkdownPreview 表格横向滚动容器 + 图片点击放大（Modal）
3. PromptComposer 粘贴 `text/html` 含 `<table>` 时优先 `text/plain`

## 不做但铺路

- **输入回滚/编辑历史**：zcode 一步撤销=编辑末条用户消息重发+本轮文件原子重置；Gemini 每步可撤是会话检查点树。地基已有（task_message 全量留存+每任务 worktree git 隔离），难点在轮次→文件变更归属（多 agent 并行）。单独立项，第一步只做"编辑消息不改文件"
- changelog 更早条目待用户粘贴后评估（候选：划选上下文、@文件引用、对话流工具调用分组、首页提示词推荐）

## 验收

- 单测：`project-context-layout.spec.tsx` 重写（折叠组/默认展开/持久化/空态不渲染）；resizer 拖拽；settings schema 新键；InspectorPreviewHost 分派
- 集成：auto-continue（自动 queued+留痕+人答竞态+辩论跳过+覆盖优先级）；preview 路由（逃逸 403/CSP/Content-Type）
- e2e：右栏折叠持久化、预览打开、倒计时可见（新写）
- 终验：`tsc -b --force` 0 错 → vitest 全量 → smoke 77（动了 task 域）→ e2e 全绿
