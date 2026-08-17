# deepseek-harness 能力对照矩阵（WP7，2026-08-17）

> 对照对象：deepseek-ai/deepseek-harness（MIT，Cordis 插件化 monorepo，48 个插件包）。
> 用途：以团队维护的完整 agent harness 为参照系，逐包对照 muster 现状，得出「缺什么 / 值不值得补 / 怎么补」。
> 原则：不引 Cordis、不搬代码（组件深度耦合其插件框架）；借鉴设计 + 用现成开源/MCP 补缺。

## 结论先行

muster 与 dsh 的能力重合度约 70%，且强项互补：我们强在**组织与治理**（多 agent 组织/权限/发布管线/记忆/进化），dsh 强在**单会话工程深度**（终端、溢写、代码运行时、协议接入）。真正值得补的缺口按优先级：

1. **spill（上下文溢写）**——超长任务把上下文落盘按需回读，我们只有压缩（会丢细节）。补法：自研或借开源摘要/检索方案，挂 SessionManager。价值高（长任务质量）。
2. **bundle（能力包分发）**——与竞品分析结论一致：能力包做分发格式。补法：扩展现有 plugin/能力导出。价值高（分发生态）。
3. **plan/goal 阶段化**——我们蓝图 stages_json 已预留二期（阶段工作流+组合管线），方向一致，按既定路线走。
4. **code-runtime 深化**——run_command+黑名单可用但粗糙；可观察开源沙盒方案（如 dsh 的 sandbox 思路），非急迫。
5. **acp（编辑器接入）**——IDE 入口，等真实需要再做。

## 逐包对照（48 包）

| 包 | 什么 | muster 现状 | 缺口价值 | 补法 |
|----|------|------------|----------|------|
| acp | Agent Client Protocol（编辑器/客户端接入） | 无（Web/REST 单入口） | 低 | 等需要；开源协议实现 |
| api | REST API | ✅ 有（Express 全家桶+冒烟） | — | — |
| attachment | 附件 | ✅ 有（素材上传 64MB+消息附件+识图直读 WP10） | — | — |
| boot | 启动装配 | ✅ 有（server.ts+迁移恢复） | — | — |
| bundle | 能力打包分发 | ❌ 无（能力导出仅个人档案级） | **高** | 能力包分发格式（竞品分析既定方向） |
| client | 客户端 SDK | 无（REST 即用） | 低 | 暂不做 |
| code-runtime | 代码执行运行时 | ⚠️ 部分（run_command+沙盒黑名单+worktree） | 中 | 观察开源沙盒；非急迫 |
| compaction | 会话压缩 | ✅ 有（SessionManager 软/硬阈值+换代+恢复链） | — | — |
| context | 上下文装配 | ✅ 有（assembleContext 分层装配） | — | — |
| core | 核心框架 | ✅ 有 | — | — |
| credentials | 凭据管理 | ✅ 有（三层解析+平台凭据库） | — | — |
| e2b | 云沙盒集成 | 无 | 低 | 本地优先，观察 |
| extensions | 扩展机制 | ✅ 有（unified Plugin 体系） | — | — |
| feedback | 用户反馈回流 | ⚠️ 部分（capability_usage_stat 质量信号） | 低 | 已够用 |
| fs | 文件工具 | ✅ 有（worktree+file-tools+发布管线，强于 dsh） | — | — |
| goal | 目标树管理 | ⚠️ 弱（验收标准有；目标分解靠任务派发） | 低 | 蓝图 stages 覆盖 |
| guard | 安全守卫 | ✅ 有（权限档+loop protection+审批+沙盒） | — | — |
| hooks | 生命周期钩子 | ⚠️ 无用户级 hook | 低 | 暂不做 |
| host | 宿主互操作 | ✅ 有（Agent Bridge loopback） | — | — |
| identity | 身份 | ✅ 有（agent profile+人设+任职三层） | — | — |
| interaction | 交互收集 | ✅ 有（结构化追问/选项/审批/评审庭） | — | — |
| jobs | 后台作业 | ✅ 有（trigger scheduler+coordinator） | — | — |
| llm | 模型调用 | ✅ 有（6 执行器+模型档位 WP9+流式 WP5） | — | — |
| lsp | 语言服务协议 | 无 | 低 | 编码向，CLI 执行器原生覆盖大半 |
| mcp | MCP 接入 | ✅ 有（三 transport+插件启停，强） | — | — |
| plan | 计划管理 | ⚠️ 部分（project plan 版本；阶段化待 stages_json 二期） | 中 | 蓝图二期既定路线 |
| preset | 预置策展 | ✅ 有（商城预置 pin 版本+题材包） | — | — |
| runtime-diagnostics | 运行诊断 | ⚠️ 部分（probe/usage/cockpit） | 中 | 观察补齐 trace 聚合分析 |
| sandbox | 沙盒 | ✅ 有（黑名单+worktree 隔离+只读沙盒） | — | — |
| schedule | 定时调度 | ✅ 有（interval/daily+时区+防叠跑） | — | — |
| sdk | SDK | 无 | 低 | REST 即可 |
| session | 会话管理 | ✅ 有（压缩/换代/恢复） | — | — |
| session-query | 会话查询 | ⚠️ 部分（trace API+消息历史） | 低 | — |
| settings | 设置 | ✅ 有（四域+模型分级 WP9） | — | — |
| shell | Shell 工具 | ✅ 有（run_command+分类审批） | — | — |
| skill | 技能库 | ✅ 有（24 内置+检索+商城+karpathy WP2） | — | — |
| spill | 上下文溢写（超长落盘按需回读） | ❌ 无（只有压缩） | **高** | 自研挂 SessionManager；参考其思路 |
| storage | 存储 | ✅ 有（SQLite+worktree+Agent Home） | — | — |
| subagent | 子代理 | ✅ 有（蜂群/临时工/辩手+派遣分级，强于 dsh） | — | — |
| subprocess | 子进程 | ✅ 有（CLI adapters） | — | — |
| terminal | 终端形态 | 无（muster 无终端 UI） | 低 | 不做（产品形态不同） |
| test-support | 测试 | ✅ 有（vitest+playwright+77 冒烟） | — | — |
| todo | 任务 | ✅ 有（Task 状态机+依赖，强于 dsh） | — | — |
| typert | （内部类型工具） | 未知 | 低 | 观察 |
| util | 工具函数 | ✅ 有 | — | — |
| web | Web 工具 | ✅ 有（web_fetch/search builtin+playwright MCP 预置 WP6） | — | — |
| workflow | 工作流 | ✅ 有（条件边+受控回环；stages 二期） | — | — |
| workspace | 工作区 | ✅ 有（worktree 隔离+总工作区+素材/成品区） | — | — |

## 与 dsh 的架构启示（不搬代码）

- **插件化方向互相印证**：他们的 everything-is-a-plugin 与我们的 unified Plugin 体系同构；我们多了治理维度（权限/审批/发布）。
- **UI 不借**：其前端长在 Cordis 上下文上，摘除成本高于自研；对话渲染/流式我们已用标准库自研完成（WP4/WP5）。
- **值得抄的是交互细节**：终端态输出、溢写的渐进披露——等做对应能力时读其实现当参考。
