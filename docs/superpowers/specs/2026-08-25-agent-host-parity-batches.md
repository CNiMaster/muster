# Agent 宿主能力对齐批次计划（capability parity）

- 日期：2026-08-25（08-26 二轮拍板更新）
- 状态：**已全部实施**（2026-08-26；0/A/B/C/D/E/G/H+尾批各一 commit，F 核查已存在收口；全量 1822/1822 绿）
- 背景：对照 ZCode/Claude Code 内置能力清单（命令/钩子/技能/子智能体/插件）盘点 muster 缺口。
  根因一句话：CLI 执行器把「宿主标配工具」内置在宿主进程里；muster 的 API 自研执行器
  要把这一层全部自己背，目前只补了联网（web-tools.ts），其余仍缺。
  证据：`src/server/executors/context.ts:33-48` REQUIRES_CLI_SKILLS 列 8 个技能注明
  「API 型执行器无法真正执行」——技能库 21 件约三分之一在 API 型上是纸上谈兵。

## 〇、已拍板决策（08-26）

1. **Ralph 式 stop-hook 循环确认不做**：它本质是 goal 驱动续跑（承诺未完成就续），
   muster 的任务状态机+循环任务+checkpoint 续跑是同一目标的更强实现（跨进程断点续跑
   vs 单会话硬顶），已覆盖。
2. **自控桥安全边界**：改设置/装插件=事事确认；知识库写入=编辑自动。
3. **知识库结构**：平台通用库（可选，用户建）+ 每项目一库（用户不建就没有）。
   项目库可独立修改/删除，不连累其他项目。添加归属默认规则：项目上下文内添加→项目库；
   明示「通用」或从通用库页添加→通用库，用户不必每次选。
4. **执行器首启引导**：做，但可跳过不强制。
5. **记忆看板不做审批队列**：沉淀闭环后台自动（settleMemoryVotes 已有），
   看板=查看/筛选/编辑/删除，不给人加活。
6. **市场重定义**：市场页=优质内容推荐+一键安装+已安装管理（启用/停用/卸载）三合一，
   「装一个显示一个」只是管理页不是市场。
7. **技能预置原则**：工程方法论=muster 自研库预置（正文可控+中文化+与流程内建对齐）；
   外部生态能力（文档格式/浏览器/图像）=市场按需装。superpowers 14 件对照后仅补
   verification-before-completion 一件（差集分析见 §三）。

## 一、现状盘点（结论表）

| 能力 | 现状 | 判定 |
|---|---|---|
| 子智能体 | spawn_tasks 蜂群+固定岗+专家团+能力分级 | 已覆盖，不做 |
| 技能库+管线 | 双根技能库+沉淀/检索/评优 | 已覆盖（补 1 件，§三） |
| 循环续跑 | 循环任务/自动调度+checkpoint(loop_progress) | 已覆盖，不做 |
| 网页搜索 | web_search/web_fetch builtin（SSRF+权限流） | 已覆盖 |
| Review | submit_review+验收庭+staging premium 审查 | 组织级够；工具层缺 search_files |
| 代码搜索 | **无**（仅 list_files+read_file） | 批次 A |
| 对话压缩 | L7 compactMessagesToDigest 机械摘要（tool-loop.ts:139） | 批次 A |
| 循环内 Todo | 无（任务树=业务级） | 批次 A |
| 自控桥 | Agent Bridge 6 动作，plugin kind 已含 'bridge-action' | 批次 B |
| 知识库 | material 素材区（存）+memory（经验）+archive（跨项目档） | 批次 C |
| 记忆看板 | memory.ts 已有 4 维 scope（personal/workspace/project/skill）+全套 API，无专门页 | 批次 D |
| 命令/钩子管理页 | 能力商城只有 Skill/MCP 两类 tab；钩子/命令无页面无消费 | 批次 D |
| 计划流 | plan 模式默认+ProjectPlansPage 存在；无意图自动进模式、无侧栏看计划 | 批次 G |
| 侧边栏 | 单面板（DiscussionPanel 等），无多标签/自动收起 | 批次 H |
| 文档生产 | 无 docx/xlsx/pdf 工具 | 批次 E |
| 执行器分发 | manifests.ts officialInstall 数据齐，无一键安装 UI | 批次 F |

## 二、批次设计

### 批次 A：API 执行器工具层补齐（最优先）

1. **builtin `search_files`**：内容 grep（pattern+文件名过滤+路径范围→`文件:行号:匹配行`）。
   完全照 `tools/web-tools.ts` 模式：builtin 定义+permissionAction='read' 只读权限+
   忽略 node_modules/dist/.git+结果截断。可加 `glob_files`（按名找文件）。
2. **语义压缩**：溢出时用便宜档模型把旧历史总结成语义摘要（决策理由/结论/未竟事项），
   机械摘要降为兜底；消息流加手动「压缩上下文」动作。入口在 tool-loop.ts:210 slice 处。
3. **builtin `todo` 工具**：循环内轻量任务清单（read/write），长任务自锚。
   与业务任务树解耦——模型的草稿纸，不是任务卡。

### 批次 B：自控桥扩展（self-MCP）

1. **bridge action 扩到管理域**：settings 读写、插件安装/启停、技能库管理、
   知识库查询/写入、模式切换。安全边界按拍板：改设置/装插件=事事确认；
   知识库写入=编辑自动。
2. **双形态暴露**：HTTP bridge 保持（CLI 型 curl 通用）+ 包一层标准 MCP server
   （API 型挂现有 mcp/adapter.ts 即成原生工具）。
3. **负责人岗快捷操作**：负责人 systemPrompt 注入管理域动作清单，
   用户说「帮我装 xx/改设置」→ 负责人走桥完成 → trace 留痕。

### 批次 C：知识库管道（两级库 + 词法 + agent 改写）

结构（已拍板）：平台通用库（可选）+ 每项目一库（默认不建）。

管道：导入（PDF/docx/网页/markdown/纯文本全收）→ 文本抽取（开源库，登记
THIRD_PARTY_NOTICES；抽取是系统能力不是「装技能」，技能只做使用指引）→ 纯文本上
做词法索引（复用 expandMatchTokens/lexicon；**向量不排期，维持定案**）→ 检索 →
assembleContext 按需注入（受全局软预算约束）。

**词法检索能力边界（写给用户的产品说明）**：
- 能解决：用户说得出关键词的场景——找 API 名/错误码/命令/配置项；FAQ 问答
  （问句与文档用词一致）；中文同义词命中（lexicon：登录↔登陆、鉴权↔auth）。
- 解决不了：语义模糊查询（问「登录那块怎么设计的」但文档写「统一身份认证模块」，
  词面零重叠）；跨语言同义（问「支付」文档写「扣款/结算」）；长文档内部段落级定位。
- 补法（不引向量）：①agent 两步检索——先把口语 query 改写成关键词组合再查
  （muster 有 agent，天然适合）；②标题/首段/tag 加权；③返回多片段让模型自选。
- 一句话判断：用户知道自己在找什么（能说出词）→词法够；只知道自己想要什么
  （说不清词）→agent 改写救一半。
- 第三方知识库不自研替代：市场可装 MCP 检索类连接器（Notion/外部库）作补充，
  我们自己做组织+ingestion+词法层。
- 建库时不让用户选技术方案（词法/向量不是用户该懂的事）：只选名字+范围（通用/项目），
  检索策略系统默认；库高级设置留检索模式开关，将来真要向量再开档。

### 批次 D：管理面收口

1. **能力市场（重定义）**：推荐内容+一键安装+已安装管理（启用/停用/卸载）三合一。
   冷启动=curated 官方目录（Skill/MCP/命令/钩子/面板五类），后续能力包格式
   （见 2026-08-25-capability-pack-format.md）。
2. **记忆看板**：按 4 维 scope 筛选——personal=用户偏好（跨员工全局共享，批次 F 定案 #8）/
   workspace=平台跨项目/project=项目/craft=人设手艺（persona_key 非空=人设 CRAFT 池，
   含固定岗与隐形人员，同款人设共享一池；空=员工个人手艺按 profile 隔离）；
   另加沉淀者/项目过滤+打开查看+编辑/删除；每条可见来源（谁/何时/哪任务沉淀、被引用几次）
   以及注入策略（personal 永远全量/craft 按穿戴人设/workspace+project 按任务相关性渐进命中）。
   无审批队列——沉淀闭环后台自动。
   **前置：scope 'skill' 更名 'craft'，一次性改净不留兼容双值**（消除与技能库/能力商城
   kind='skill' 的概念撞名；本地单机无外部契约消费者，保留双读=歧义永久化）。
   实施：一条 migration（官方时间戳命名，UPDATE memory_entry/memory_candidate 的
   scope 值替换）+ 源码引用面约 7 文件（memory.ts 12 处字面量/SQL、api/memory.ts
   zod 校验、reflection/agent-home/specialist-snapshot/capability-binding/client types）
   + 4 个测试文件；赶在看板 UI 定名前改，改完跑记忆增强专项测试兜底。
3. **命令管理页**：自定义斜杠命令（$ARGUMENTS 模板+可选绑定技能/模式/档位），
   存储复用 user-skills 库结构；养蜂人可把常用工作流沉淀成命令。
4. **钩子管理页+钩子消费**：定义 muster 生命周期事件集
   （任务启动/工具调用前后/任务结束/会话装配），插件可注册钩子；钩子过权限档。
5. **能力商城扩类**：marketplace 从 Skill/MCP 扩到命令/钩子/面板。

### 批次 E：文档生产（必做，已提级）

docx/xlsx/pdf 生成：开源库选型（docx/exceljs/pdf-lib 级，开源优先）+ skill 正文
+ 产物走 artifact 审批流。API 型 builtin 工具（document_create/update）。

### 批次 F：执行器引导安装（不捆绑，一键装）

- 不捆绑二进制：合规+体积+更新负担；且 CLI 的工具是给 CLI 进程的，
  muster 的工具层安全/能力分级/审批照样自建，两条线并行。
- officialInstall 变产品能力：执行器中心「一键安装」（执行安装命令+装后自动探测注册
  +引导 login）。首启检测无任何 CLI 时引导页，**可跳过不强制**（接 setup-assistant）。

### 批次 G：计划流闭环（新）

1. **意图进模式**：用户输入「帮我做个计划/规划一下」类意图 → 自动切 plan 模式
   （模式就是为计划建的，该比手动切做得更好）。
2. **计划产物**：落项目计划（ProjectPlansPage 已有页面），侧边栏可查看。
3. **执行审批**：计划确认后转执行，执行计划需要审批（衔接现有审批档）。

### 批次 H：侧边栏标签化（新）

右侧栏统一多标签容器：
- 打开的文档以标签展示，单标签可关闭，全关后右栏自动收起。
- 空态（刚打开）展示默认建议项目，可点击打开。
- 打开的工具同样以标签展示：手动关闭，或再次点击工具入口关闭对应标签；
  无标签自动收起右栏。
- 计划查看（批次 G）作为标签类型之一。

## 三、技能预置差集分析（superpowers 14 件 vs muster skills/ 21 件）

| superpowers | muster 对应 | 结论 |
|---|---|---|
| brainstorming | idea-refine | 已有 |
| test-driven-development | test-driven-development | 已有 |
| systematic-debugging | debugging-and-error-recovery | 已有 |
| writing-skills | skill-author/skill-synthesis 管线 | 已有（管线形态） |
| requesting/receiving-code-review | code-review-and-quality+验收庭 | 已有 |
| using-git-worktrees | 任务级 worktree 架构 | 流程已内建，不需要技能 |
| subagent-driven-development / dispatching-parallel-agents | 蜂群 spawn_tasks | 流程已内建 |
| finishing-a-development-branch | 白名单文件合并流 | 流程已内建 |
| writing-plans / executing-plans | plan 模式+任务树（批次 G 补闭环） | 流程已内建 |
| using-superpowers | assembleContext 装配+技能自动挂链 | 流程已内建 |
| **verification-before-completion** | **无** | **补一件（唯一真差集）** |

预置原则（已拍板§〇-7）：一半 superpowers 技能在 muster 是平台机制而非提示词纪律，
平台机制比提示词纪律可靠——不全盘照搬是对的。其他 ZCode 生态技能评估结论：
文档四件套=批次 E 必做；frontend-design↔frontend-ui-engineering 已有；
浏览器↔browser-testing-with-devtools 已有；skill-creator↔skill-author 已有。

## 四、实施顺序建议

A → B → C → D → E → F；G/H 为 UI+流程批，可与 C/D 并行插空。
A 最小成本最大收益先做；B 是自控方向地基；C 依赖 A 的 builtin 模式；
D 的命令页可搭 B 桥动作；E/F 独立。
