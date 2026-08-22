# 批次 I-a：面板插件协议 v1（HTML 即应用租户）

状态：proposed（2026-08-23；队列来源=muster-next-batch-plan-2026-08-22「批I=插件协议+侧边对话」）

## 背景与目标

右栏目前只有静态预览（InspectorPreviewHost：HTML 走 /artifacts/preview，服务端 CSP 禁脚本 + iframe sandbox 双保险）。要让「HTML 即应用」：专家/用户产出的交互式 HTML 面板（PPT 放映、画板、标注器）作为一等租户进右栏，可交互、可把标记/数据**受控回传**进对话。

**专家写插件是一等目标**（muster-expert-synthesis-direction）：协议+模板+契约文档让 agent 能自主产出合格面板插件——产物即插件，安装即用。

## 模型

### 1. Plugin kind 扩 `panel`

- `PluginKind` 增加 `'panel'`；manifest 联合型新增 `{ kind:'panel'; panel: PanelPluginManifest }`。
- `PanelPluginManifest = { entry: string（项目内相对 HTML 路径）; title: string; height?: number|'auto'（初始高度，auto=ready 消息驱动）}`。
- v1 作用域=workbench 独占（复用 POST /api/plugins/company-exclusive，zod kind 枚举扩 panel；smoke-4 口径 source 'workbench'）。
- 校验：新 `src/server/domain/panel-plugin.ts`——zod schema（entry 必须 .html 结尾、无 `..`、非绝对路径）+ `panelEntryPath(manifest)` 取路径。

### 2. 入口文件服务（与预览端点分离）

- 新端点 `GET /api/projects/:id/panel-plugins/:pluginId/entry`（挂 projectArtifactsRouter）：
  - 查 plugin 表（kind=panel、workbench 生效口径）→ manifest.entry → 复用 `resolveArtifactPath` + `isPathAllowed` 三防线（路径逃逸 403、未安装 404）。
  - CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:;`——**允许脚本**（与预览端点的差异点），但仍无外部网络（default-src none 兜底）。
  - 客户端 iframe `sandbox="allow-scripts"`（**不加 allow-same-origin**）：opaque origin——读不到 muster 的 cookie/localStorage/fetch 凭据，服务端无 CORS 头时 fetch 全被拦。双防线与 H9 哲学同源（L0 兜底，不信内容）。
- 列表端点：`GET /api/projects/:id/panel-plugins`——effective 插件过滤 kind=panel（给右栏组渲染）。

### 3. 受控 postMessage API（v1 只做单向回传）

协议模块 `src/shared/panel-plugin-protocol.ts`（宿主与插件共用类型+守卫）：

- plugin→host：`{v:1,type:'ready',height?:number}`（就绪/报高）/ `{v:1,type:'markup',payload:unknown,label?:string}`（标记回传）
- host→plugin：`{v:1,type:'init',context:{pluginId,projectId,taskId?}}`
- 宿主守卫：`event.source === iframe.contentWindow && data?.v === 1`，否则丢弃；markup payload `JSON.stringify ≤ 8KB`，超限截断+提示（防插件刷屏/炸内存）。
- v1 **不做**：save-file / 命令执行 / 双向大数据 context 下发（request-context 留 v2）。

### 4. 宿主 UI

- `PanelPluginHost.tsx` 挂 ProjectContextInspector 新 InspectorGroup「面板插件」；**无 panel 插件不渲染组**（零插件零打扰）。
- 每插件一张折叠卡：标题+iframe；一次只展开一个（互斥，防多 iframe 抢资源）；height 上限 720px。
- markup 到达 → 组内「插件标记」卡片（来源插件+时间+payload 摘要），操作=「引用到对话」：走 H6 quotedContext 同通道进 PromptComposer（`> 引用：…` 前缀随下轮输入；接线实现时按现有代码选：Workspace state 或 CustomEvent，取现有 H6 同款）。可清除。
- iframe 加载失败/404 → 卡片内错误态（不留白盒）。

### 5. 专家产出路径

- `docs/plugins/panel-plugin-v1.md`：协议契约（manifest/消息/CSP/上限）+ 安装步骤（产物入库→插件页安装 kind=panel）。
- `templates/panel-plugin-template.html`：骨架（ready 上报+markup 示例+最小样式），专家照抄即合格。
- 专家工作流：专家把 HTML 写进项目产物 → 用户/人事在插件页登记安装。v1 不做一键安装探测。

## 测试

- 单测：panel-plugin zod 校验（合法/路径逃逸/非 html）；协议守卫（v≠1 丢弃/超限截断）。
- 集成：entry 端点（200+CSP 头/逃逸 403/未装 404）+ 列表端点（workbench 过滤）。
- 组件：PanelPluginHost（组隐藏条件/iframe src/ready 调高/markup 卡片+引用回调/互斥展开）。
- e2e：安装 panel 插件→右栏出现组→iframe 加载（断言存在）；markup 全链在组件层覆盖。

## 边界与不做

- 不做插件保存文件/执行命令/网络代理（v2 按需评估，走受托越界通道同款审批）。
- 不做多插件布局/拖拽；不做版本更新与签名（复用 plugin 表 maturity 标注）。
- 不改 /artifacts/preview 的禁脚本语义（两条通道并存：预览=看，面板=用）。

## 分期

- I-a1 协议+服务端（kind/manifest/两端点/共享协议模块）
- I-a2 宿主 UI（组+iframe+markup 回传引用）
- I-a3 专家产出路径（模板+文档）+四门收口
- 一段交付合并；I-b 侧边对话另行 spec。

## 实施记录

（待实施）
