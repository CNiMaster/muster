# 右栏统一标签系统 P2（2026-08-27）

状态：implemented（随本批提交）
前置：0d7e9ca 容器自适应 + 0c45913 浮层化。研究轮结论见对话与记忆「UI 定案口径」页。

## 背景与定案

右栏现有六套"打开物"机制互不通气：工具走路由、文档预览 `?preview=` / 工作现场 `?panel=` 走单槽参数、成果编辑走 Modal、左栏开关语义、右栏伪标签条（硬编码快捷字）。用户拍板做统一标签系统：

- **开启物三域合一**：tool / doc(预览) / plan(工作现场) 全部进同一个数组型 URL 状态，每个是一张标签页
- **URL 驱动保留**：可后退/可分享/刷新恢复（沿用现有 preview 的优点），序列化在 `?rt=` 参数
- ** pathname 停留任务现场**：新开 doc/plan/tool 标签不再切路由，中栏对话不被打断（现状是开工具=整栏路由切换）
- **旧入口全部归一兼容**：旧路由 `/projects/:id/artifacts` 直访 → 自动注册为 tool 标签；旧参数 `?preview=` / `?panel=` mount 时吸收为标签
- **保活 = 滚动位置级**：每张标签的滚动位置在切换间保留（body scrollTop 记忆）；组件内表单输入态不承诺（跨路由 keep-alive 需门户级改造，明确不做并记录原因）

## 明确不做

ArtifactEditor 从 Modal 改标签（编辑保持聚焦模态）；全局侧聊/归档并入（属 global-tools 壳，项目域先行）；组件实例级 keep-alive；localStorage 持久化标签集（URL 已覆盖刷新语义）。

## 设计

### 数据模型（`inspector-tabs.ts` 纯函数模块）

```ts
type RtEntry =
  | { kind: 'doc'; path: string }      // id: doc:<encodeURIComponent(path)>
  | { kind: 'plan'; name: string }     // id: plan:<name>（胶囊名）
  | { kind: 'tool'; tool: ProjectToolKey };
```

- `parseRtParam / serializeRt`：容错解析（未知 kind 丢弃）、按 id 去重、上限 **8 张**（超出丢弃最旧）
- 活动标签：`?rtA=<id>`，缺省=最后一张；清空 rtA = 回「现场」（隐式首张，不可关闭）
- 关闭语义：从数组移除；若关的是活动标签则激活前一张；若关的是**当前路由**的工具且经由旧路由进来 → 导航回现场

### 组件（`InspectorTabsHost.tsx`）

- 渲染位置：WorkbenchShell 的 `inspector` prop 整体替换为 Host——标签条吸顶 + 活动体分发
- 标签条：横向滚动不折行（多开不吃纵向空间）、活动态高亮、逐个 ✕；仅当存在已开启物才渲染
- 活动体分发：`tool:*` 复用 `.work-inspector-tool` 容器（保住容器查询适配）；`doc:*` 用 PreviewBody（放大 Modal/画廊链接保留）；`plan:*` 用 WorkLivePanel；现场=ProjectContextInspector
- `InspectorTabsContext` 提供 `openDoc/openPlan/openTool/closeTab`，供左栏导航、WorkCapsule、产物组调用
- 迁移 effect：mount/param 变化时吸收旧 `preview/panel` 参数；旧工具路由直访时同步注册 tool 标签

### 接线改动面

| 文件 | 改动 |
|---|---|
| ProjectToolPageShell.tsx | inspector 分支换 Host；InspectorToolPane 降级为纯 body 容器（头条由标签条替代）；TOOL_LABELS 移至 utils 共享 |
| ProjectContextInspector.tsx | 内嵌 InspectorPreviewHost / WorkLivePanel 区块移除（变标签） |
| ProjectWorkNavigation.tsx | INSPECTOR_TOOLS 类链接改走 openTool（onClick preventDefault；⌘/中键仍走原生路由深链） |
| WorkCapsule.tsx | 展开 ▸ 工作现场走 openPlan |
| InspectorPreviewHost.tsx | 抽出可复用 PreviewBody；独立区块用法退役 |
| global.css | 标签条样式 + ≤340 紧凑档适配（追加文件尾块） |

## 验证门

1. `npx tsc -b --force` 干净
2. 新增 `tests/unit/inspector-tabs.spec.ts`（解析容错/去重/截断/关闭激活链）+ workbench-preferences 7/7 不回归
3. 浏览器全链路（隔离 :3479）：旧路由直访自动成标签；连续开 3 个文档不互顶；doc+plan+tool 混挂切换；✕ 链与回退键行为；240–360 四档复扫零真实越界；滚动保活肉眼验证
4. 仅暂存本批文件，中文提交信息，不 push
