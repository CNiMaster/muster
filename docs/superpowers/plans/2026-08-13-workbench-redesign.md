# 工作台改版实现计划（提交批准）

**Spec**：`docs/superpowers/specs/2026-08-13-workbench-redesign-design.md`
**北极星**：默认面只暴露"对话→派活→看进展→审批"；plumbing 撞墙才出现；让用户先用起来是第一位。
**顺序**：0（文档）→ 1（一键启动）→ 2（IA 骨架）→ 3（收敛清理）→ 4（手感）→ 5（文案）。每批独立提交、typecheck+测试+e2e 绿。

---

## 批次 0 — 文档先行
- [x] spec `docs/superpowers/specs/2026-08-13-workbench-redesign-design.md`
- [x] plan `docs/superpowers/plans/2026-08-13-workbench-redesign.md`（本文件）

---

## 批次 1 — 一键模板启动（最高用户价值）

**目标**：选模板 → 可选改名 → 一键开跑（执行器/权限/项目/任务/人设全自动）。打通 243 人设库与模板。

### Task 1.1 — 后端 company-starter domain（TDD）
- [x] 新 `src/server/domain/company-starter.ts`：`quickStartCompany(db, { templateId, name?, goal? })`
  - 调 `buildPackage` + `createBuiltinCompanyTemplateDraft`（template-registry.ts）
  - 自动套默认执行器：取系统设置里的默认 provider/tier（FirstRunWizard 配的）；无执行器 profile 则报清晰错误"请先在设置页配置一个执行器"
  - 自动套默认权限策略：无则建一条默认项目级策略
  - 项目名/首任务取自模板（`projectName` / `firstTaskTitle`）
  - **接通人设库**：按 role → persona-library 启发式映射（domain + role 关键词），命中则用 persona 的 soul/principles/capabilities 覆盖薄字符串；未命中兜底用模板原 soul
- [x] 扩展或复用 `commitCompanySetup`（company-setup.ts）支持 quick 模式（缺省值自动补，不强制逐员工绑定步骤）
- Test `tests/integration/company-starter.spec.ts`：选模板→公司 online+项目+首任务+员工带 persona soul；无执行器→清晰错误；persona 映射命中/未命中兜底
- 验收：调用返回 { company, project, firstTask }，公司 state=online（或可上线态）

### Task 1.2 — quick-start API
- [x] `POST /api/company-setup/quick-start` body `{ templateId, name?, goal? }` → `quickStartCompany`
- [x] 复用现有 catalog `GET /api/company-setup/templates`（前端选模板用）
- 验收：curl/集成测试创建成功并返回公司 id

### Task 1.3 — 前端"快速开始"模式
- [x] `CompanySetupWizard` 加快速模式：模板网格 → 点击 → 可选改名弹窗 → 调 quick-start → 落地公司对话（路由 `/companies/:id?view=conversation`，批次 2 前先落到现有活动 tab）
- [x] 原 5 步保留为"自定义/高级"入口
- 验收：选模板→1-2 点击→进入公司，员工有富人设、首任务已派发

**Commit**：`feat(redesign B1): 一键模板启动——starter bundle + 人设接通 + 快速模式`

---

## 批次 2 — 三栏 IA 落地（对话为中心）

### Task 2.1a — 对话成为公司默认中心（已先行落地）
- [x] CompanySectionKey 加 `conversation`；CompanyWorkNavigation 主区置顶"对话"
- [x] 新 CompanyConversation 组件：ConversationPanel 提为公司默认落地 + slim next-action 提示
- [x] CompanyPage 默认 activeTab → conversation；一键开跑落地 ?view=conversation
- [x] CSS 对话中心撑满中栏；e2e 验证一键开跑→对话中心

### Task 2.2b — 公司标签栏（浏览器式切换，先行落地）
- [x] 新 `CompanyTabBar`：全部在营公司自动为标签、当前高亮、>6 收进「▾更多」、行末「＋新建」；右侧 首页/设置/更多▾（员工库/审批/执行器/能力/外包/权限暂存，B3 归位）
- [x] 所有路由常驻（App.tsx 替换旧扁平顶栏）——解决"切公司要点开多层菜单"痛点 + 双导航模型收敛第一步
- [x] e2e：标签出现/当前高亮/新建入口（overflow 稳健断言）

### Task 2.1 — UnifiedRail 左栏
- [ ] 新 `src/client/components/workbench/UnifiedRail.tsx`：主区（对话/项目/员工/产物）+ 回看折叠组（审批/复盘/进化/记忆）+ 高级折叠组（外包）+ 设置；按 scope（无公司/公司/项目）自适应
- [ ] 替代 `CompanyWorkNavigation` / `ProjectWorkNavigation`；收编顶栏 9 项
- Test 组件冒烟（各 scope 渲染 + 折叠组）

### Task 2.2 — 对话为中心
- [ ] 公司默认落地 = 中心对话（`ConversationPanel scope="company"`）；cockpit 概览移右栏/次要
- [ ] 项目默认 view 改为 group（对话）
- [ ] 右栏：对话激活时显示"本次对话派生的 Task + 进度 + 产物"（复用 ContextInspector + 新对话任务视图）

### Task 2.3 — 统一导航模型
- [ ] 全局页（首页/公司列表/设置等）也走 `WorkbenchShell`，顶栏 9 项收进左栏 + ⌘K
- [ ] 保留所有现有 route（不删，重组入口）
- 验收：单一导航模型；进公司→对话中心；左栏收编全部目的地

**Commit**：`feat(redesign B2): 三栏 IA——UnifiedRail + 对话为中心 + 统一导航`

---

## 批次 3 — 收敛回看 + plumbing + 设置整合

- [ ] 左栏"回看"组：审批(`/reviews`)+复盘+进化+记忆 归组折叠
- [ ] 左栏"高级"组：外包
- [ ] `SettingsPage`：执行器/能力/权限配置归位（去 hub-of-hubs）；自主进化/网络代理/3档tier 进"高级"折叠区
- [ ] 孤儿页定夺：关系图/工作流编辑器 加入口或藏高级
- 验收：设置不再 hub-of-hubs；回看归组；plumbing 降级

**Commit**：`feat(redesign B3): 收敛回看/plumbing 入口 + 设置整合`

---

## 批次 4 — 对话体验升级（实时 + 内联）

### Task 4.1 — 后端 message.* 实时事件
- [ ] `postSystemMessage`（conversation.ts）发布 `message.created` 事件（复用 RealtimeBus）
- [ ] 可选：task 步骤（工具调用起止）作为对话事件发布
### Task 4.2 — 前端实时 + 内联
- [ ] `ConversationPanel` 订阅 `message.*` → 即时刷新（4 秒轮询降级兜底）
- [ ] `MessageBubble` 扩展：工具调用/任务进度作为特殊气泡内联渲染（复用 EventFeedList 数据源）
- 验收：发消息→看见 agent 实时干活（步骤内联）→回复秒到

**Commit**：`feat(redesign B4): 对话实时 message.* + 内联步骤渲染`

---

## 批次 5 — 引导与文案

- [ ] `FirstRunWizard` 去技术化：自动检测 CLI 优先；API key 步只填一个、高级收起；不问环境变量名/baseURL
- [ ] 术语统一：人才市场→员工库；jargon 换白话/tooltip；中英一致
- [ ] 统一首轮引导：合并 FirstRunWizard+OnboardingGuide+空状态；首跑完→落地一键启动的公司对话（衔接批次 1）
- [ ] 各页空状态统一："这是干嘛的、什么时候用"
- 验收：新用户首跑→选模板→落进对话，全程不见环境变量/jargon

**Commit**：`feat(redesign B5): 引导去技术化 + 术语统一`

---

## 风险与边界
- **不丢功能**：所有 route 保留，只重组入口。
- **批次 2 风险最高**（IA 重构）——保留深链、渐进切换、每步可回退。
- **批次 1 人设映射**：启发式 + 兜底（无匹配用模板原 soul），不阻塞。
- **不做**：token 级流式；两表合并；通用 CLI 配置管理器。

## 实施权限
- npm run typecheck / npm test / npm run test:e2e
- 创建/修改 src 前后端文件、新 migration（批次 1 若需启动包快照表）
- 创建 spec/plan 文档
