# 右栏标签&顶栏&底栏一致性（2026-08-27 续批，小增量闭环）

状态：proposed（两步签字：本页 plan → exitPlanMode 准入实施）

## 背景与用户拍板三事（本节即拍板语录稿）

1. **侧边对话/归档等全局右栏页未进标签**：现有标签仅覆盖项目域四工具（tasks/merges/artifacts/knowledge）+ doc(预览)/plan；全局壳（/archive /side 等）仍每点一次就整页导航、与标签互不知情。定案：全局右栏类工具也进标签（同在 `?rt=` 数组，工具域加前缀 `g:` 区分，全局壳 = 上下文锚点上一最近项目）。
2. **顶栏跟着右栏变**：`WorkbenchHeader breadcrumb` 与 `commandOptions:sectionLabel` 按当前月签重算（任务清单/知识库等），而中栏对话始终是固定任务。定案：顶栏**只认中栏**（projectView/选中任务/员工），不跟右栏活动签走。
3. **中栏底栏换行**：`PromptComposer mu-conv-toolbar` 一行里挤满模型/深度/模式/人/对话/发送等控制；窄中栏即折行。定案：**不允许折行**——模型与思考度折成图标按钮（点开菜单确认原有选项），工具行单行横滚（不增纵高）；左栏自动收放：中栏窄过阈值自动收（随窗口拖拽节流触发）、宽回阈值且非用户手动关则自动展开。
4. 出底栏口径补充：当前代码里选模型还有 `modelOptions`（全执行器真实模型清单+聚合去重，与 `useUiMode/models` 路径一致）——图标化不丢选择能力。

## 实施范围（拆两人一机房）

| 域 | 改动 | 规模 |
|---|---|---|
| 状态层 `inspector-tabs.ts` | `RtEntry += g:tool / g:side`（归档=global-archive 兼顾旧 inmates），`INSPECTOR_TOOL_LABELS` 扩表，`routeToolKey` 增全局路由→key；写路径沿用 `appendRt` 限 8 | 小 |
| 动作层 | 新增 `openGlobalTool(toggle)`、`globalPathFor`，跨壳导航用 lastProjectId 锚点；`navigateContext` 保留 projectTask | 小 |
| 宿主 `InspectorTabsHost.tsx` | 挂 `GlobalResolver` 渲染 ArchivePage/Settings 等（不改全局壳，中栏保持；tool-pane 保留容器查询） | 中 |
| 左栏导航 `ProjectWorkNavigation.tsx` | 「常用」两项走 `openGlobalTool`（仅项目路由接管；归档高亮跟标签） | 小 |
| 顶栏 `ProjectPage.tsx` + `useInspectorTabs` | 去掉随签的 breadcrumb 重算；`commandOptions` sectionLabel 只派生自 projectView/selectedProjectTaskId | 小 |
| 底栏 `PromptComposer.tsx` | 两控件图标化（模型🔧/深度🧠 各一按钮，下拉同现选项；工具行 `white-space:nowrap` 横滚；`isCompactBar` 派生展示） | 中 |
| 左栏自动收放 | `useWorkCentreCompact` hook：RO 观测中栏宽度 `<560 && rightOpen`→ 自动收；`>=740` 且非用户手动关则展回；节流 120ms | 中 |

> 2026-08-27 用户澄清扩大范围：右栏近域工具不限于本节前述两条（global archive/side）——
> `INSPECTOR_TOOLS` 项目域四工具（tasks/merges/artifacts/knowledge）加上全局侧边对话/归档等
> 全部为“右栏工作面”，**所有右栏状态一律经标签开关**（套用本节状态/动作/宿主三段式）；
> 非右栏的中栏页（dashboard/plans/reports/materials/settings/* 等 surface 形态工具）
> 不入标签——其 `?rt=` 深链需求单独批处理。

## 不做

全局标签在独立导航页（/projects/new 等无上下文页）的开启表征——先不收；底栏"一期自动收"已覆盖到"二期抽屉图标栏"的过渡态——样式细节留复审镜头；全局标签的 draft 持久化/多项目跨壳标签锚点拖动。

## 验证门

`tsc -b --force` / 两单元 spec / 浏览器六场景（归档走标签/知识库与侧聊共存/顶栏锁定/底栏单行/中栏 520 窄带自动收/手动关不自动回）。仅暂存本批文件，不声明 `add -A`。
