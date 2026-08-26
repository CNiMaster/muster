# 第三方开源资源备忘

凡在本仓库引入或借鉴的开源资源（依赖、代码、设计）都必须在此登记：后期商业化/协议合规时用于追溯许可。引入方式 = `依赖`（npm 包引用）| `代码借鉴`（参考实现思路，未直接复制代码）| `设计借鉴`（交互/架构参考）| `内容导入`（提示词/资产文件导入）。

| 名称 | 仓库/来源 | 许可 | 用途 | 引入日期 | 引入方式 |
|------|-----------|------|------|----------|----------|
| react-markdown | https://github.com/remarkjs/react-markdown | MIT | 对话消息 Markdown 渲染（WP4） | 2026-08-17 | 依赖 |
| rehype-highlight | https://github.com/rehypejs/rehype-highlight | MIT | 对话代码块语法高亮（WP4） | 2026-08-17 | 依赖 |
| highlight.js | https://github.com/highlightjs/highlight.js | BSD-3-Clause | rehype-highlight 底层高亮引擎（WP4） | 2026-08-17 | 依赖 |
| andrej-karpathy-skills | https://github.com/forrestchang/andrej-karpathy-skills | MIT | 编程行为准则 skill 的内容来源（WP2，中文化改写） | 2026-08-17 | 代码借鉴 |
| deepseek-harness | https://github.com/deepseek-ai/deepseek-harness | MIT | 能力对照矩阵研究参照（WP7）；不引 Cordis、不搬代码 | 2026-08-17 | 设计借鉴 |
| playwright-mcp | https://github.com/microsoft/playwright-mcp | Apache-2.0 | 浏览器自动化 MCP 商城预置（WP6，pin @playwright/mcp@0.0.79）+ 工具档案 | 2026-08-17 | 依赖 |
| Open-DeepSeek-Harness-Desktop | https://github.com/ahamoment-101/Open-DeepSeek-Harness-Desktop | MIT | 蓝图连线画布设计参考（三栏布局、Sidecar 视觉持久化、DAG 防环；技术基于 @xyflow/react） | 2026-08-17 | 设计借鉴 |
| codex-closeout-archive | https://github.com/ChenJinCloud/codex-closeout-archive | MIT | 任务收尾归档与高密度人可读摘要设计（8 节结构化收尾、5-12 转折点时间线、决策证据链） | 2026-08-17 | 设计借鉴 |
| jnMetaCode/agency-agents-zh | https://github.com/jnMetaCode/agency-agents-zh | MIT | `personas/` 211 个专家人设导入 | 2026-08 前 | 内容导入 |
| addyosmani/agent-skills | https://github.com/addyosmani/agent-skills | MIT | `skills/` 20 个技能导入 | 2026-08 前 | 内容导入 |

| dnd-kit (@dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities) | https://github.com/clauderic/dnd-kit | MIT | 项目主页/侧栏列表拖拽排序（项目分组拖动与组内排序，批2） | 2026-08-18 | 依赖 |
| lefthook | https://github.com/evilmartians/lefthook | MIT | git hooks 管理（pre-push typecheck 门禁，工程地基批次 E） | 2026-08-19 | 依赖 |
| pdf-parse | https://github.com/runet1m/pdf-parse | MIT | 知识库 PDF 文本抽取（capability parity 批次 C） | 2026-08-26 | 依赖 |
| mammoth | https://github.com/mwilliamson/mammoth.js | BSD-2-Clause | 知识库 docx 文本抽取（capability parity 批次 C） | 2026-08-26 | 依赖 |
| docx | https://github.com/dolanmiu/docx | MIT | 文档生产 docx 生成（capability parity 批次 E） | 2026-08-26 | 依赖 |
| exceljs | https://github.com/exceljs/exceljs | MIT | 文档生产 xlsx 生成（capability parity 批次 E） | 2026-08-26 | 依赖 |
| pdf-lib | https://github.com/Hopding/pdf-lib | MIT | 文档生产 pdf 生成（capability parity 批次 E） | 2026-08-26 | 依赖 |

> 历史既有依赖（express/react/better-sqlite3 等）以 `package.json` 与其各自 LICENSE 为准；本表登记「新增引用/借鉴」与内容级导入。
