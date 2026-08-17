# 第三方开源资源备忘

凡在本仓库引入或借鉴的开源资源（依赖、代码、设计）都必须在此登记：后期商业化/协议合规时用于追溯许可。引入方式 = `依赖`（npm 包引用）| `代码借鉴`（参考实现思路，未直接复制代码）| `设计借鉴`（交互/架构参考）。

| 名称 | 仓库/来源 | 许可 | 用途 | 引入日期 | 引入方式 |
|------|-----------|------|------|----------|----------|
| react-markdown | https://github.com/remarkjs/react-markdown | MIT | 对话消息 Markdown 渲染（WP4） | 2026-08-17 | 依赖 |
| rehype-highlight | https://github.com/rehypejs/rehype-highlight | MIT | 对话代码块语法高亮（WP4） | 2026-08-17 | 依赖 |
| highlight.js | https://github.com/highlightjs/highlight.js | BSD-3-Clause | rehype-highlight 底层高亮引擎（WP4） | 2026-08-17 | 依赖 |
| andrej-karpathy-skills | https://github.com/forrestchang/andrej-karpathy-skills | MIT | 编程行为准则 skill 的内容来源（WP2，中文化改写） | 2026-08-17 | 代码借鉴 |
| deepseek-harness | https://github.com/deepseek-ai/deepseek-harness | MIT | 能力对照矩阵研究参照（WP7）；不引 Cordis、不搬代码 | 2026-08-17 | 设计借鉴 |
| playwright-mcp | https://github.com/microsoft/playwright-mcp | Apache-2.0 | 浏览器自动化 MCP 商城预置（WP6，pin @playwright/mcp@0.0.79）+ 工具档案 | 2026-08-17 | 依赖 |
| jnMetaCode/agency-agents-zh | https://github.com/jnMetaCode/agency-agents-zh | MIT | `personas/` 211 个专家人设导入 | 2026-08 前 | 内容导入 |
| addyosmani/agent-skills | https://github.com/addyosmani/agent-skills | MIT | `skills/` 20 个技能导入 | 2026-08 前 | 内容导入 |

> 历史既有依赖（express/react/better-sqlite3 等）以 `package.json` 与其各自 LICENSE 为准；本表登记「本轮新增引用/借鉴」与内容级导入。Browser 工具选型（WP6）胜出后在此补登。
