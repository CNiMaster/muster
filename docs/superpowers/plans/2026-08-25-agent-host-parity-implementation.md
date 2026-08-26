# Agent 宿主能力对齐·实施计划

- 日期：2026-08-26
- 依据 spec：`docs/superpowers/specs/2026-08-25-agent-host-parity-batches.md`（七条拍板决策 + 八批次 + craft 改名前置）
- 状态：已批准，实施中

## 总则

- 每批独立 commit；全量门 = `tsc -b --force`（防 tsbuildinfo 假绿）+ vitest 全量核对
  Tests passed 总数 ≥ 基线（1760+）。
- migration 用官方时间戳命名；本地 SQLite 主库先行，备份库下次启动自然追平。
- 提交白名单文件绝不 add -A（并行会话防护）；新依赖登记 THIRD_PARTY_NOTICES。
- 涉 e2e：先清 3456/24678 端口；`MUSTER_KEEPAWAKE=off`。

## 批次 0：memory scope 'skill' → 'craft'（前置改名，一次改净不留兼容）

- migration `20260826xxxxxx_craft_scope_rename.sql`：UPDATE memory_entry / memory_candidate
  两表 scope 值替换；若建表有 CHECK 约束引用 'skill' 一并重建。
- 源码改值：`memory.ts` 12 处（含 skillClause/orderClause 的 SQL 字面量）、`api/memory.ts`
  zod、`reflection.ts`、`agent-home.ts`、`specialist-snapshot.ts`、`capability-binding.ts`、
  `client/api/types.ts`；`MemoryScope` 类型改为 `'personal'|'workspace'|'project'|'craft'`。
- 4 个测试夹具文件改值。
- 验收：`grep -rn "scope='skill'\|scope: 'skill'" src tests` 为空；记忆套件全绿。

## 批次 A：API 执行器工具层（最优先）

**A1 search_files / glob_files builtin**（照 `tools/web-tools.ts` 模式）
- 新文件 `src/server/executors/tools/search-tools.ts`：`search_files(pattern, glob?, path?,
  maxResults?)` 流式逐文件逐行 grep，忽略 node_modules/dist/.git，跳过二进制，返回
  `文件:行号:行文本` cap 200 行；`glob_files(pattern, path?)` 目录遍历匹配。
- `registry.ts` createBuiltinToolRegistry（:1313 起）注册，`permissionAction='read-file'`
  （executeTool :1479 的 path 分支守卫）。
- 验收：API 型任务一次跨文件符号定位；临时目录夹具单测。

**A2 语义压缩（v2）**
- `tool-loop.ts:139` 处新增 `compactMessagesSemantic(old, callModel)`：复用 CallModelFn
  （:60），tools 传空数组，摘要 prompt 要求保留决策理由/结论/未竟事项；失败或未配置
  便宜档则降级 `compactMessagesToDigest`（v1 兜底）。
- 触发分支 :262-268 接入；便宜模型走 `resolveProfileForTier(db,'low')`
  （model-tier.ts:70，engine 侧组装后经 opts 传入，adapter 不传则纯机械）。
- 消息流加手动「压缩上下文」动作。

**A3 builtin todo**
- `todo_read` / `todo_write`，存储按 task 隔离（`$MUSTER_HOME` 下 tasks/<id>/todo.json）。
- 验收：长循环任务 trace 显示模型自建清单并逐项推进。

## 批次 B：自控桥

**B1 管理域动作**：`bridge.ts` BRIDGE_ACTIONS（:40，单一事实来源，同时驱动路由与
prompt 注入）新增 POST 动作族：settings-get/set、plugin-install/toggle、
knowledge-query/append、switch-mode；各自独立 handler（样板 :235 borrow-specialist）。
安全边界（已拍板）：改设置/装插件=事事确认——ensureApprovalRequest +
markTaskWaitingApproval + approvalBroker.wait（样板 elevated-command :268-316）；
知识库写入=编辑自动+trace 留痕。负责人岗（DISPATCHER_ROLE）systemPrompt 附管理域
动作说明。

**B2 self-MCP 包装**：新增子命令 `muster mcp-bridge --loopback <url> --task <id>`——
stdio MCP server（复用现有 MCP SDK），把 BRIDGE_ACTIONS 映射为 MCP tools；API 型执行器
在 tool-assembly 阶段内建 connect（McpServerConfig stdio，client-pool :93 复用），
CLI 型继续 curl HTTP 零适配。
- 验收：API 型任务工具列表出现管理工具；负责人改设置走完审批流。

## 批次 C：知识库（两级库）

- migration：`knowledge_base`(scope_level platform|project, project_id NULL) +
  `knowledge_doc`(base_id FK, source_material_id, title, format, raw_path,
  extracted_text, tags_json) + `knowledge_fts`（FTS5，参照 memory_fts）。
- `domain/knowledge.ts`：createBase/importDoc/listBases/searchKnowledge
  （expandMatchTokens 词元+FTS5+标题 tag 加权）/delete。两库规则（已拍板）：项目上下文
  导入→项目库（无则提示建）；通用库仅显式。
- 抽取：md/txt 直存；PDF=pdf-parse、docx=mammoth（登记 notices）。
- builtin `search_knowledge`（read-file 档）+ assembleContext 知识库段（渐进命中，
  受软预算）。
- UI：项目工具页 KnowledgeBasePage（main.tsx :121 样板）+ 通用库全局页。
- 检索边界与「agent 两步改写」见 spec §批次 C。

## 批次 D：管理面

- D1 市场重定义：MarketplacePage 增「已安装」区（启/停/卸载，复用能力中心逻辑）；
  商城扩类（命令/钩子/面板 tab）。
- D2 记忆看板 MemoryBoardPage（全局页）：4 维 scope 筛选（craft 子筛人设/员工）+
  沉淀者/项目过滤 + 查看/编辑/删除 + 注入策略徽章（personal 全量/craft 按人设/
  workspace+project 渐进）；无审批队列。
- D3 命令管理：user_commands 存储（复用 user-skills 结构，$ARGUMENTS 模板+绑定
  技能/模式/档位）+ PromptComposer :344 斜杠候选合并动态源 + 命令管理页。
- D4 钩子：domain/hook.ts 生命周期事件集（task_start/pre_tool/post_tool/task_end/
  context_assemble）+ plugin kind='hook' 注册 + 执行点埋入（executeTool 前后/engine
  任务态）+ 钩子过权限档 + 管理页。

## 批次 E：文档生产

- 依赖 docx/exceljs/pdf-lib（开源选型登记 notices）；builtin
  `document_create(format,path,content|rows)` / `document_update`，产物走 artifact
  审批流；skills/ 增 document-authoring 正文。
- 验收：API 型各生成一例 docx/xlsx/pdf。

## 批次 F：执行器引导安装（2026-08-26 实施时确认：已存在，收口不重复实施）

- 核查结论：一键安装链路历史批次已交付——domain/executor-install.ts runInstallStream（官方
  命令流式安装+diagnoseInstallError）、ExecutorCenterPage「自动安装/重试/手动命令展开」、
  setup-assistant 新手旅程第一步即「选工具（自动扫描/自动安装）」且自然可跳过（API 走第二步）。
- spec 探索阶段的缺口判断基于盲区，实际无缺口。switch-mode 桥动作评估：composer/意图检测
  已覆盖模式切换，桥侧弱场景不开管理域写洞——留后续真实需求再启。

## 批次 G：计划流闭环

- 意图进模式：handleSendPrompt（ProjectTaskWorkspace :152）前置关键词规则 v1
  （计划/规划/方案→非 plan 模式自动切并 toast 可撤销）。
- 计划产物：plan 模式完成时 `createPlanVersion`（project-plan.ts :68 已有版本域，
  PlanStatus draft→active），planDocRef 落 artifact；draft→active 需用户确认
  （复用 submit_review）。
- 侧栏查看（挂批次 H 标签）+ active 计划转工单（复用 createWorkOrder 链路）。

## 批次 H：侧边栏标签化

- WorkbenchShell inspector（:189）内加 InspectorTabs 容器：标签
  {id, type: doc|tool|plan|discussion, title, closable}。
- ProjectContextInspector 现有组块映射为默认标签；空态=建议项
  （最近文档/计划/常用工具）。
- 开合联动：开文档/工具→push 标签+右栏开；关最后标签→右栏收；再点工具入口=
  toggle 标签。

## 尾批：verification-before-completion 技能

skills/verification-before-completion/SKILL.md（中文化，对齐 INDEX「验证阶段」分组）
+ INDEX.md 登记。

## 顺序与门

0 → A → B → C → D → E → F；G/H 在 C/D 后并行插空；尾批随时。
每批：tsc -b --force + vitest 全量（核对 Tests passed 总数）+ 白名单提交。
