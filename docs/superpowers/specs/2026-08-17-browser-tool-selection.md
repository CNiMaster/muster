# Browser 工具选型备忘（WP6，2026-08-17）

> 背景：四层架构对照发现工作区层最大缺口是 Browser（浏览器自动化/网页调研）。原则：有现成开源不自研，本地优先，接入走 MCP（零 adapter 代码）。

## 结论

**主选：microsoft/playwright-mcp（npm `@playwright/mcp`，Apache-2.0，pin `0.0.79`）**，商城预置 + 能力中心工具档案双落。备选 chrome-devtools-mcp（性能/调试场景）留待真实需要再补预置。

## 候选对比（2026-08-17 评审）

| 候选 | 许可 | 形态 | 评估 |
|------|------|------|------|
| **microsoft/playwright-mcp** | Apache-2.0 | npx 本地 MCP（stdio） | ✅ 主选：Playwright 官方一线维护；本地浏览器无云依赖；accessibility-tree 快照模式对 LLM token 友好；`npx -y @playwright/mcp@0.0.79` 零安装；与现有 McpClientPool stdio transport 直接兼容 |
| GoogleChrome/chrome-devtools-mcp | Apache-2.0 | npx 本地 MCP | 性能分析/调试向更强，调研向工具面窄于 playwright；作为特定场景备选，暂不预置 |
| browser-use/browser-use | MIT | Python 库 + MCP | 自主浏览 agent 形态有趣，但依赖 Python 环境与额外 LLM 调用，运维面大；观察 |
| browserbasehq/stagehand | MIT | TS 库/MCP | 代码导向的浏览器脚本，更适合写代码场景而非运行时工具；观察 |
| AgentQL | 混合商业 | API/MCP | 云端优先 + 商业配额，与本地优先原则冲突；排除 |
| browserbase | 商业 | 云 | 云浏览器付费服务；排除（本地优先） |
| modelcontextprotocol/servers 内 puppeteer/firefox | MIT | npx MCP | 官方 servers 仓库已 archive，参考实现冻结；排除 |

## 落地

1. 商城预置 `mcp-playwright`（`src/shared/marketplace-presets.ts`，pin `0.0.79` 不可变版本；新分类 `mcp-browser`）。
2. 工具档案 `tools/browser/playwright-mcp.md`（capability: browser；员工经 `# 能力中心` 推荐卡可见）。
3. THIRD_PARTY_NOTICES.md 登记（Apache-2.0）。
4. 首次使用需本地已装 Playwright 浏览器（`npx playwright install chromium`），档案 check 命令已给。

## 不做

- 不自研浏览器工具/不写专用 adapter（能力中心=搬运工哲学；MCP 生态即插即用）。
- 浏览器沙盒与权限：沿用现有 `network` 权限动作与 MCP 默认权限，无额外门禁。
