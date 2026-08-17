---
id: playwright-mcp
capability: browser
implementation: local
executor_kind: ""
credential_keys: []
install: "npx -y @playwright/mcp@0.0.79"
check: "npx -y playwright@latest --version"
maturity: stable
---

# Playwright MCP（浏览器自动化 / 网页调研）

Playwright 官方 MCP server（microsoft/playwright-mcp，Apache-2.0）。给执行器一双"手"：打开网页、点击、填表、截图、抽取内容——补齐调研类任务（researching 阶段）的网页触达能力。

## 何时用

- 需要**实时网页信息**的调研/竞品分析/资料收集（模型训练数据过时时）。
- 需要**登录后才能看**的页面内容（在本机浏览器会话内操作）。
- 需要**验证**线上页面实际表现（表单流程、文案上线效果）。

## 接入（平台是搬运工）

经 `POST /api/plugins` 落 MCP 配置（stdio）：

```json
{
  "kind": "mcp-server",
  "name": "playwright",
  "config": { "transport": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@0.0.79"] }
}
```

或能力商城直接安装预置 `mcp-playwright`（同配置一键落库）。工具以 `mcp_playwright__*` 前缀注册进运行时工具集，走 `network` 权限动作。

## 前置条件

- Node 18+（npx 可用）。
- 首次使用前装浏览器内核：`npx playwright install chromium`（约 120MB，装一次）。

## 使用纪律

- 默认 accessibility-tree 快照模式（token 友好）；需要视觉判断时再切 `--vision` 截图模式。
- 抓取内容落文件（如 `research/*.md`）再引用，不要把长网页全文贴进对话。
- 登录态/cookie 属于本机会话，敏感站点操作前确认权限档允许。
