# 批次 I-a 实施计划（执行 specs/2026-08-23-panel-plugin-protocol-batch-i.md）

worktree：`git worktree add ../muster-plugin-i -b feat-panel-plugin`（node_modules 软链）。三小段一次交付，四门全绿后合并 main；spec 同步实施记录。

## I-a1 协议+服务端

1. `src/shared/plugin.ts`：PluginKind 加 `'panel'`；`PanelPluginManifest` + manifest 联合型新分支。
2. 新 `src/server/domain/panel-plugin.ts`：`panelManifestSchema`（zod：entry 相对路径/`.html` 结尾/无 `..`，title 必填，height number≤720|'auto' 可选）+ `parsePanelManifest` + `panelEntryRelPath`。
3. `src/shared/panel-plugin-protocol.ts`：`PanelPluginMessage` 联合（ready/markup/init）+ `isPanelPluginMessage(e.data)` 守卫 + `MARKUP_LIMIT=8192` + `clampMarkup`（截断）。
4. `src/server/api/plugins.ts`：companyExclusiveHandler zod kind 枚举加 `'panel'`；安装时 kind=panel 走 parsePanelManifest 强校验（失败 400）。
5. `src/server/api/artifacts.ts`：`GET /panel-plugins`（effective kind=panel 列表，含 manifest 解析）+ `GET /panel-plugins/:pluginId/entry`（plugin 表查→resolveArtifactPath/isPathAllowed→CSP 允脚本头→sendFile）；逃逸/未装/越权分别 403/404/403。
6. 测试：`tests/integration/panel-plugin.spec.ts`（列表过滤/entry 200+CSP/403 逃逸/404 未装/安装校验 400）+ `tests/unit/panel-plugin-manifest.spec.ts`。

## I-a2 宿主 UI

7. `src/client/hooks/queries.ts`：`usePanelPlugins(projectId)`。
8. 新 `src/client/components/workbench/PanelPluginHost.tsx`：
   - 无插件返回 null；InspectorGroup「面板插件」（ProjectContextInspector 挂载，默认折叠）。
   - 折叠卡互斥展开；iframe `sandbox="allow-scripts"` src=entry 端点；message 监听守卫+ready 高度驱动（≤720）。
   - markup→标记卡片（label/时间/摘要）；「引用到对话」接线：先查 H6 quotedContext 的实际通道（ProjectTaskWorkspace lift 或 store），同通道注入；做不到则 `window.dispatchEvent(new CustomEvent('muster:composer-quote',{detail}))` 由 PromptComposer 监听并入引用条——实现时按现有代码取其一，spec 记录选型。
   - 失败态：iframe onError→卡片错误行。
9. 组件测试 `tests/unit/panel-plugin-host.spec.tsx`（隐藏条件/展开互斥/markup 卡片+引用回调/超限截断提示/守卫丢弃 v≠1）。

## I-a3 专家产出路径+收口

10. `templates/panel-plugin-template.html`（骨架：ready+markup 示例）+ `docs/plugins/panel-plugin-v1.md`（契约+安装步骤）。
11. e2e：`tests/e2e/panel-plugin.spec.ts`——安装 panel 插件（API 直装）→右栏出现「面板插件」组→展开→iframe 存在。
12. spec 实施记录（含 quotedContext 接线选型/偏差）；四门（tsc -b --force 真退出码/vitest 全量/MUSTER_KEEPAWAKE=off smoke+e2e）→合并。

## 边界提醒

- 预览端点禁脚本语义不动；entry 端点 CSP 是唯一放脚本的口。
- 安装走现有上班锁（assertWorkbenchOff）；不新增迁移。
