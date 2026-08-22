# 面板插件协议 v1（批次 I-a）

> 面板插件 = 一个项目内的 HTML 文件，安装在右栏「面板插件」组里以 iframe 沙箱运行，
> 可交互（放映/画板/标注），可把标记数据**受控回传**进对话。专家写插件是一等目标：
> 照 `templates/panel-plugin-template.html` 抄即可产出合格插件。

## 一、manifest 与安装

安装走插件表（kind=`panel`，工作台独占）：

```json
POST /api/plugins/exclusive
{
  "name": "幻灯片面板",
  "kind": "panel",
  "source": { "kind": "workbench" },
  "manifest": {
    "kind": "panel",
    "panel": {
      "entry": "panels/deck.html",
      "title": "幻灯片",
      "height": 400
    }
  }
}
```

- `entry`：项目内**相对** HTML 路径（禁绝对路径/`..`；必须 `.html` 结尾）。服务端按
  产物三防线解析（resolveArtifactPath + isPathAllowed），逃逸 403。
- `title`：折叠卡标题（≤60 字）。
- `height`：初始高度 px（120–720）或 `"auto"`（等 ready 消息上报；上限 720）。
- 安装需工作台下班（`assertWorkbenchOff`）；manifest 不合法 400。

## 二、运行环境（安全模型）

- iframe `sandbox="allow-scripts"`，**无 allow-same-origin** → opaque origin：
  读不到工作台 cookie/localStorage；服务端无 CORS 头，fetch 全被拦。
- 入口响应 CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'
  data:; img-src data: blob:; connect-src 'none'`——内联脚本/样式可用，**无外部网络**
  （不能引 CDN/字体/图）；图片用 data: URI 内嵌。
- 与 `/artifacts/preview` 的关系：预览端点禁脚本（用来看），面板端点允脚本（用来交互）。

## 三、postMessage 协议（v1 单向回传）

插件 → 宿主（`parent.postMessage(msg, '*')`）：

| 消息 | 字段 | 说明 |
|---|---|---|
| `ready` | `height?: number` | 就绪/内容高变化时上报；宿主夹紧 ≤720 |
| `markup` | `payload: unknown`、`label?: string` | 标记回传；宿主展示卡片，用户点「引用到对话」后随下轮消息附 `> 引用：…` 前缀 |

宿主 → 插件：

| 消息 | 字段 | 说明 |
|---|---|---|
| `init` | `context: { pluginId, projectId, taskId? }` | iframe onLoad 后下发一次 |

约束：
- 所有消息必须带 `v: 1`；宿主丢弃 `v` 不对、type 不在白名单、来源不是自己 iframe 的一切消息。
- markup 载荷序列化后 ≤8KB，超限截断并提示。
- v1 **没有**：保存文件、执行命令、网络代理、双向大数据下发。需要这些能力时走受托越界
  通道（bridge elevated-command）同款审批，v2 再评估。

## 四、专家产出工作流

1. 把 HTML 写进项目产物（如 `panels/deck.html`），自测可用浏览器直接打开。
2. 告诉用户/人事 entry 路径与标题，由其在插件页或经 API 安装（见上）。
3. 用户在右栏展开「面板插件」组即见；标记回传 → 「引用到对话」。

## 五、测试锚点

- 协议/manifest 单测：`tests/unit/panel-plugin-manifest.spec.ts`
- 端点/安装集成：`tests/integration/panel-plugin.spec.ts`
- 宿主组件：`tests/unit/panel-plugin-host.spec.tsx`
- e2e：`tests/e2e/panel-plugin.spec.ts`
