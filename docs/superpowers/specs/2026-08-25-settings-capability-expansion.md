# 设置与能力扩展批次计划：五项确认项 + 能力管理岗 Skill 管线

状态：proposed（批次拆解待拍板排期）
日期：2026-08-25
背景：对照 ZCode 单 agent 设置全景逐项判断后，用户确认五个缺口需要做；同时为能力管理岗扩展"Skill 沉淀 / 在线检索 / 择优引入"职责定方向。已完成部分见 §5。

## 一、开源合规条款（所有批次的前置约束，不可绕过）

- 引入任何第三方代码/技能/配置模板前，**先查 LICENSE**：MIT / Apache-2.0 / BSD 可商用可直接用；GPL/LGPL/AGPL 类需隔离评估（作为独立进程/外部工具调用可接受，代码合并不可）；无协议=不可引入。
- 每次引入登记 `THIRD_PARTY_NOTICES.md`（名称 + 地址 + 协议 + 用途），沿用既有机制。
- 外部技能市场（ClawHub / awesome-openclaw-skills 等）只作**货源目录**参考：其中每个 SKILL.md 协议各异，逐个查证后方可引入；优先官方 registry 高星项。
- 用户提供的样例（awesome-openclaw-skills）未经调研对比不得直接采用。

## 二、五个已确认项的方案骨架与批次建议

### 批次一（小）：API 格式选择
- 问题：openai-compatible 适配器固定一种调用形态，遇到只支持另一种的服务商会失败。
- 方案：档案 config 加 `apiFormat: 'chat-completions' | 'responses'`（默认 chat-completions，向后兼容零迁移）；openai-adapter 按值分派请求构造；接入表单「高级选项」加一行 Select。
- 规模：适配器分支 + 表单一行 + 探针跟随。半天级。

### 批次二（中）：任务自动归档
- 借鉴对方"超保留期自动归档"思路，作用于 project_task 载体。
- 方案：设置键 `archiveTaskAfterDays`（0=关，默认 30）；coordinator 低频扫描（并入现有 30 分钟卫生定时器）：completed 且 updated_at 早于保留期且无未读关联 → `archived_at` 标记（软状态不删除，回收站语义沿用 Workspace 治理）；任务列表默认过滤已归档、可切换查看。
- 规模：1 迁移（archived_at 列）+ 扫描函数 + 过滤参数 + 设置行。一天级。

### 批次三（中大）：供应商卡片 + 模型列表
- 现状：一个 API 档案只有一个 model 字段，多模型=建多档案。
- 方案：`config.models: Array<{ model, contextWindowTokens?, note? }>` 向后兼容（旧单 model 键读取时包装成单元素数组）；接入表单支持添加多个模型行（每行标注上下文窗口）；引擎选模型按任务档位在列表内挑选；「已就绪的工具」列表展示供应商卡片（名称 + 模型 chips）。
- 依赖：批次一（同一张表单）。两天级。

### 批次四（大）：能力管理 UI
- skills/ 目录目前只读无界面。方案：
  - 能力中心新增「技能」页签：列表（名称/描述/来源 bundled|user|synthesized|plugin/启用停用）+ 新建 SKILL.md 表单（frontmatter 自动生成）+ 从 URL 导入；
  - 启停复用 plugin opt-out 治理表；写入走用户根 `~/.muster/skills/`（双根扫描即生效）。
- 依赖：无硬依赖，但与 Skill 管线（§三）共享存储与治理，建议同期做。三天级。

### 已完成（本轮）
- 字体清晰度：默认 --font-sans 改 system-ui 中文优先栈；外观字体改预设下拉（苹方/微软雅黑/思源黑体等一键切换）+ 自定义保留。
- 代码显示：代码字号独立设置（--code-font-size 注入 mu-md-code）、长行自动换行开关（--code-wrap）。
- （上一轮）用量花费面板、任务桌面通知。

## 三、能力管理岗职责扩展 v2：Skill 沉淀 / 在线检索 / 择优引入

定位：能力管理岗从"装备供给（被动响应 [装备请示]）"升级为"能力的策展人"——主动沉淀、按需检索、评优引入。

### 3.1 Skill 沉淀管线（什么时候把常用工作总结成 skill）
信号收集（纯查询，同构 expert-synthesis 三信号模式）：
- 同类任务聚类：taskType 相同且 completed 且 rework=0 的任务 ≥3 次；
- CRAFT 记忆聚类：同 fingerprint 前缀的 skill 记忆 ≥3 条且优势分为正；
- 工具组合复现：capability_binding 同一组推荐工具连续成功 ≥5 次（capability_usage_stat 已有此记账）。
起草：economy 档 LLM 按 AgentSkills 规范生成 SKILL.md（name/description frontmatter + 步骤正文），source: 'synthesized' 标注来源任务。
入库：`~/.muster/skills/<slug>/`（用户根，双根扫描即生效）；进能力管理盘点清单供用户查改删（沿专家盘点制"系统只建议、人可否决"）。
去重：与新老 skill 的 description 词元 Jaccard ≥0.4 视为重复，跳过或走 supersede 提案。

### 3.2 在线检索（需要工具时不局限于本地）
触发：skill-retrieval 本地 miss 或低分（<阈值）且任务进入执行前装配阶段。
货源白名单（首批）：ClawHub registry（13k+，官方）、awesome-openclaw-skills（5.4k+，VoltAgent 维护的过滤视图）。两者均为 AgentSkills 兼容 SKILL.md——**与 muster 技能格式零转换成本**（这是选择它们而非自造格式的决定性理由）。
流程：本地 miss → 白名单源搜索（关键词取任务标题词元）→ 拉 Top-N 候选卡（名称/描述/星标/最近更新）→ 进择优流程。

### 3.3 可信度评级框架（哪些更可信）
四维打分，输出 0-1 综合置信度：
1. 来源权威：官方 registry 内置认证 > 高星（≥100 星加权）> 普通仓库 > 无星个人；
2. 协议合规：有 LICENSE 且可商用 = 1；无协议直接淘汰（§一条款）；
3. 内容安全：跑既有隔离扫描正则（prompt 注入/密钥外传模式，memory.ts scanMemoryContent 同款）+ SKILL.md 中 shell 命令人工可见摘要；
4. 战绩回填：引入后经 capability_usage_stat 记录真实任务成功率，动态修正评级（用得越多越准）。

### 3.4 择优引入流程
候选对比卡（≥2 个同类候选时并列展示评分依据）→ 高置信（≥0.8）自动引入（沿专家合成免确认定案）并留痕；低置信列清单待用户点选。引入后立即进 3.1 的战绩回填循环。

### 3.5 索引库（腾讯云文章所指）结论
CodeGraph / Understand-Anything 类工具解决的是"Agent 不知道该看哪里"——对仓库建符号图/可追问图谱。muster 的判断：**不自研索引**。理由：执行层搜索发生在 CLI 侧的 worktree 内，CLI 自带 grep/glob 已覆盖中小仓库；平台层的正确姿势是把这类图谱 MCP 作为**装备**纳入能力中心推荐链（大仓库任务由能力管理岗推荐挂载 CodeGraph MCP），而非平台内置第二套索引。若未来实测 CLI 检索成为瓶颈再评估内置。

## 四、不做清单（延续上轮判断）
Chrome 硬件加速 / 内置浏览器系列 / 更新通道 / 终端 Profile 暴露 / 平台层索引 / 遥测——理由见对话定稿，桌面版专项出来再议前三者。

## 五、验证口径
每批次照常 tsc + vitest 全量 + smoke 77；涉及 skills 写入的批次补双根扫描回归；涉及外部抓取的批次 mock 网络不真实出网。
