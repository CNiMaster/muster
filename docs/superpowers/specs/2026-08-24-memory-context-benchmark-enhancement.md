# 记忆与上下文增强专项：对标五篇文档的梳理评优与补足

状态：implemented（§6 标注 proposed 的条目除外）
日期：2026-08-24
检索路线定案（用户拍板）：**只做词法增强，不引入 embedding/向量（不排期）**
交付范围（用户拍板）：本 spec + P0 四件 + P1 三件 + 词法增强，一次交付

---

## 一、背景与对标来源

对标智谱 GLM Coding Plan 五篇学习资源（Claude Code 生态方法论的系统化表述）：

1. how-coding-agent-works（工作原理）
2. agentic-extension（Agentic 扩展组件）
3. memory-mechanism（记忆机制）
4. common-workflow（常用工作流）
5. best-practice（最佳实践）

本文档做的事：**逐机制梳理五篇内容 → 与 muster 现状逐一评优 → 找出"重要且不足"的缺口 → 补足实施**。

## 二、五篇文档机制级梳理

### 2.1 工作原理
- **Agent Loop**：获取上下文→执行操作→验证结果，全程交替；用户随时可中断/补充上下文/改思路——用户是循环的一部分。
- **模型职责**：读代码、推理、规划、按结果调整；**工具职责**：文件/搜索/命令/Web/代码分析五类。
- **上下文压缩两板斧**：删除旧的工具输出 + 总结历史对话；长期规则应写入项目配置文件而非依赖对话历史。
- **安全三件套**：变更回滚快照、权限控制（自动改代码/执行命令/人工确认三开关）。
- **高效实践四条**：清晰任务、可验证目标、复杂任务先规划、委托目标而非逐条指令。

### 2.2 Agentic 扩展组件
- **扩展组件层**：上下文文件（CLAUDE.md）/Skills/Subagents/Hooks/MCP/Plugins，是"Agent 循环之上的能力层"。
- **Skills 两类**：Reference（按需参考知识）/ Action（触发任务）；渐进加载（先 metadata 描述，命中才读全文）。
- **层级合并规则**：上下文文件叠加式（更具体优先）；Skills/Subagents 按名称覆盖（managed > user > project）；Hooks 合并执行；MCP 合并去重。
- **上下文成本治理**：每种扩展占上下文窗口；`disable-model-invocation` 让 Skill 只手动调用时加载（成本归零）。
- **Subagent 自动委派靠 description 字段**：描述性 description 是自动委派的开关；Subagent 自治上下文、受限工具、结果只回传结论。
- **Plugin**：能力打包 + 命名空间防冲突 + Marketplace 分发。

### 2.3 记忆机制（本轮对标核心）
- **五类记忆分类学**：Session（会话）/ Project（项目：CLAUDE.md 人工维护 + rules/ 自动积累 + 结构笔记）/ **Semantic（语义，依赖 RAG 检索）** / Episodic（情景："上次这么改挂了"，按项目+关键词召回）/ Procedural（程序性：怎么做事的流程策略）。
- **指令型 vs 学习型**：指令型必须执行（项目规则/安全策略），学习型有触发条件按需生效（团队偏好）。
- **学习循环**：新增 → 触发（满足条件时生效）→ **更新（正反馈循环：旧规则影响大则更新）** → **衰减（未使用衰减，影响大则保留）**。
- **写法军规**：≤200 行、格式一致、范围最小化、规则一致不重复不冲突、有明确触发条件。
- **分层五级**：项目/组织/用户/本地/角色——谁负责、谁共享、谁生效。
- **规则包复用**：@import、跨仓库规则包、团队 Git 协同 + PR 审查。

### 2.4 常用工作流
- 理解代码库/修 bug/重构/测试/PR/文档各流程手册；修 bug 四步：复现→根因→最小修复→验证。
- **Plan Mode**：只读分析→澄清问题→生成计划；可配置为默认模式。
- **@ 引用**：文件/目录/MCP 资源直接进上下文，跳过 agent 自找文件的开销。

### 2.5 最佳实践
- **成熟度阶梯：prompt → 项目规则 → Skill → Automation**（"被反复使用的提示词/流程应沉淀为 Skill"）。
- 任务输入结构化四要素：目标/上下文/约束/验收标准；**上下文文件 > 提示技巧**。
- **执行环境决定能力上限**；完整开发闭环：实现→测试→检查→审查；**会话管理 = 上下文治理**。

## 三、muster 记忆体系现状（2026-08-24 基线）

### 3.1 存储与分类
- **四域 scope**（memory.ts `MemoryScope`）：personal（用户画像，永远全量注入）/ workspace（跨项目跟员工）/ project（锁项目）/ skill（人设方法论，persona_key 全局召回）。
- **表族**：memory_candidate（审批入口）→ memory_entry（版本化生效）→ memory_version（历史）+ memory_fts（FTS5）+ memory_injection（注入记账）。
- **多主体**：每 agent 独立 profile 记忆 + persona_key 人设级全局 + 蜂群分身只读快照（800 字硬预算）+ Agent Home 文件单向镜像（DB→`~/.muster/agents/{id}/memory/`）。
- **反思产物四类**：LESSON/RULE/PREFERENCE/CRAFT（reflection.ts `reflectOnTask`）。

### 3.2 读写链路
- 写入：任务终态反思（coordinator 10s 排水，单轮 LLM）→ 候选 → 审批门（project/author=user/skill+personaKey 三类高置信自动批准）→ 生效。
- 注入：`assembleContext` → `loadContextMemories`（FTS+LIKE+中文二元组渐进命中，条数 limit 8-20）→ `# 已批准的相关记忆` 段。
- 治理：隔离扫描（注入攻击/密钥外泄必人审）、版本化、锁定、软删、优势分投票（注入记账→终态投票→收缩平均排序）、跨项目晋升（Jaccard≥0.4 人审）、专家盘点制。

## 四、评优对照（用户点名：看哪些方案更好）

| 维度 | 文档方案 | muster 方案 | 评优结论 |
|---|---|---|---|
| 记忆生命周期 | 新增→触发→更新→衰减（文字描述） | 审批→版本→优势分投票→盘点制（生产级实现） | **muster 胜** |
| 记忆归因 | 无此概念 | cause 四值 + fingerprint + tags | **muster 独有** |
| 质量排序 | 未使用衰减 | 注入记账 + 终态投票收缩平均（"老而准压过新而平庸"） | **muster 胜**（可量化） |
| 记忆更新 | "更新：旧规则影响大则更新" | superseded 状态死码、无替代机制 | **文档胜 → 本轮补（P1-①）** |
| 偏好衰减 | "未使用衰减" | personal 永远全量、无限累积 | **文档胜 → 本轮补（P0-③）** |
| 语义检索 | Semantic 记忆标配 RAG | 纯词法 FTS5+LIKE（刻意零向量） | 文档覆盖更强；**拍板不追向量，词法增强补（§6 A5-L）** |
| 上下文成本 | 反复强调窗口成本 + 按需加载开关 | 各段独立 cap，无全局预算；HR/养蜂人全量清单线性膨胀 | **文档胜 → 本轮补（P1-②）** |
| 项目上下文载体 | CLAUDE.md/AGENTS.md 生态标准 | 规则只在 systemPrompt，worktree 里无文件 | **文档胜 → 本轮补（P1-③）** |
| 组织层 | 仅 Subagents 委派 | 四岗+专家池+蜂群+分身+评审庭+验收链 | **muster 胜**（差异化优势） |
| 执行器层 | 三种运行环境一句话 | 8 适配器+档案档位+健康降级+seatbelt+审批桥 | **muster 胜** |
| 审查闭环 | checklist 式"实现→测试→审查" | staging 集成区+premium 审查+冲突法庭（机制化） | **muster 胜** |
| 会话保真/停止 | 未涉及 | 081f5cf session 保真 + 8f1812b 停止语义 + 进程组止损 | **muster 胜** |
| 任务结构化 | 四要素（目标/上下文/约束/验收） | acceptanceCriteria + 意图锚点 goal/constraints/nonGoals | 相当 |
| Plan 默认 | 可设默认 plan 模式 | composer 模式默认计划+localStorage | 相当（方向一致） |
| 自动委派 | description 字段驱动 | 精确能力词交集，无"何时用我"描述字段 | **文档胜 → 词法增强部分补，描述字段待拍板（B2）** |
| 分类学完备性 | 五类 + 指令/学习二分 | 四域（无显式 Episodic/Semantic 之分，LESSON 兼具 Episodic 属性） | 文档框架更全；muster 工程更深。**框架吸收进本文档词汇表（§7）** |

**总评**：muster 的记忆**工程化治理**领先文档一代（归因/投票/盘点/隔离均无对标）；文档胜出的集中在**概念框架完备性**（更新闭环、衰减、上下文成本、生态文件载体）——本轮全部补齐或明确不做的理由。

## 五、不足清单（按根因聚类，实施前证据）

1. **检索纯词法**：expandMatchTokens 只有 bigram（memory.ts）；findBestAssignee 精确交集（agent-router.ts `normalizeCapability` 仅 trim+lowercase）；借调 specialty `includes`（specialist-pool.ts `findStaffBorrowCandidate`）；能力词写法稍异即静默 miss→fallback 负责人，且 miss 无痕。
2. **无全局上下文预算**：assembleContext 无整体上限；HR/养蜂人的人设库索引+专家池清单全量逐条注入（context.ts），随库线性膨胀。
3. **记忆无更新闭环**：`superseded` 状态定义后全库零赋值（死码）；反思去重只靠 prompt 喂旧记忆让 LLM 自觉。
4. **personal 无收敛**：personal 永远全量注入（memory.ts `loadContextMemories`）、无条数上限、同 domain 无限累积；单条 content 无长度上限（API 手写/压缩摘要不设限）。
5. **协作断链**：conclude_discussion 的 memory_notes 只落 conclusion_json 不进记忆表（工具描述与实现漂移）；低置信候选 pending 无提醒；软删/过期数据只增不减。
6. **上下文文件缺失**：章程/说明/协作规则只在 systemPrompt——CLI 在 worktree 用文件工具查不到规则，人工进 worktree 也看不到。

## 六、增强方案（A=记忆体系 / B=上下文与组织）

### 已实施（本轮）

| # | 方案 | 对标 | 落点 | 验收 |
|---|---|---|---|---|
| A1 | **superseded 替代闭环**：候选可声明 supersedes_entry_id；批准时旧条目退场+清 FTS，新条目继承 hit/vote/adv 战绩；skill 按 persona_key 放宽 profile 归属 | 记忆"更新"环节 | 迁移 `20260824100000`；memory.ts `applySupersede`/`validateSupersedeTarget`；反思 prompt 加 `<supersedes: id>` 行、existing 清单带 id；UI 徽章"已被替代/将替代" | memory-supersede.spec.ts 3 用例 |
| A2 | **personal 收敛**：注入条数上限 12 + 同 domain ≥3 条触发 LLM 合并提案（无矛盾自动批准+批量替代；有矛盾 pending 用户裁决；7 天限频） | 偏好"衰减"的 muster 变体 | memory.ts `MEMORY_INJECT_PERSONAL_*` + `applyInjectBudget`；reflection.ts `maybeConsolidatePreferences` | preference-consolidation.spec.ts 3 用例 |
| A3 | **讨论记忆断链修复**：memoryNotes 逐条转 project 候选（[讨论] 前缀、与 LESSON 同权自动批准） | 协作闭环 | discussion.ts `concludeDiscussion` | discussion.spec.ts +2 用例 |
| A4 | **写入/注入配额**：content 硬 cap 2000 字符；注入字符预算（personal ≤2000、其余 ≤4000，保序截断） | 上下文成本 | memory.ts `createMemoryCandidate`/`applyInjectBudget` | memory-supersede.spec.ts 配额段 |
| A5-L | **词法增强（检索路线定案）**：别名归一层 `matching/lexicon.ts`（内置 ~36 组中英别名 + `~/.muster/lexicon.json` 用户扩展），四处接入（记忆词元扩展/能力路由/借调匹配/技能检索）+ **routing_miss 信号**（路由 miss 落事件→expert-synthesis 第四类沉淀信号） | Semantic 检索的零向量替代；description 驱动委派的部分替代 | lexicon.ts；agent-router/specialist-pool/skill-retrieval/memory 四处；task.ts 落事件；迁移 `20260824110000`（expert_candidate.source 词表） | lexicon-matching.spec.ts 6 用例 |
| A6 | **库卫生**：pending >20 条或最老 >7 天 → 工作台系统消息提醒（24h 节流）；软删 >90 天/过期 >30 天物理清理（连带 version/fts/injection） | "衰减"的收尾半环 | memory.ts `sweepMemoryBacklogNotice`/`purgeStaleMemory`；coordinator 30 分钟卫生定时器 | memory-hygiene.spec.ts 4 用例 |
| B1 | **清单 top-k + 全局软预算**：人设库索引/专家池清单 >15 条时词法 top-k（8/10）+计数提示；systemPrompt 超软预算（窗口 tokens/4，夹 [16k,48k]）按低优先段序压缩（旧档→素材→目录段），身份/人设/职责/验收/契约永不动 | 上下文成本治理 | context.ts `selectRelevantPersonaDomains`/`trimPromptSections`/`clampSoftPromptBudget`；engine.ts 传 contextWindowTokens | trim-prompt-sections.spec.ts 4 用例 |
| B2' | **worktree 上下文文件物化**：章程+项目说明+协作规则记忆+发布规则 → worktree 根 AGENTS.md（codex/pi/opencode）与 CLAUDE.md（claude）标记段（`<!-- muster:context:start/end -->`）；用户已有文件追加不覆盖；含标记段者在 no-approval 全量发布与 cleanup 守护中排除（不合回主干） | 项目级配置文件生态惯例 | domain/context-file.ts；engine.ts 挂点×3 | context-file-materialization.spec.ts 4 用例 |

### 第二轮落地（2026-08-24 review 后，均已实施）

复审 44c2c31 结论：checkpoint→promote 主链路无泄漏（发布是文件级拷贝非 merge）；抓到 2 个 P1 与 5 个 P2，全部修复。

| 项 | 内容 | 落点 |
|---|---|---|
| R-P1-1 | 偏好合并竞态：drain 重入锁（drainInFlight）+ 组级 in-flight 锁 + LLM 异常落占位退避 7 天 | reflection.ts |
| R-P1-2 | 声明产物旁路：agent 把 CLAUDE.md 声明为 artifact 时，发布前剥离标记段（保留 agent 对用户内容的修改；纯投影文件移出清单）——物化变更困死任务分支（不被 merge），此为唯一堵口 | engine.ts + context-file.ts `stripContextSection` |
| R-P2 | pickTop 先物化 keyOf（防 N×M 重复查库）；purgeStaleMemory 分批 500+单次 cap 5000；借调匹配 specialty toLowerCase；截断后总长严格 ≤ cap | context.ts / memory.ts / specialist-pool.ts |
| smoke 4 项 | 非本专项 bug：`isOrgLocked` 已按 2026-08-23"锁只在任务执行中生效"定调改造，smoke 断言停留在"上班即锁"旧语义——断言对齐定调后 77/77 全绿 | scripts/smoke/smoke-1-core.mjs、smoke-4-plugins.mjs |
| A7 | 分身快照补【人设方法论】段：persona_key 命中的 skill/CRAFT top3（按优势分排序，每条 100 字，方法论段最优先、截断保底） | specialist-snapshot.ts（签名加 personaId）+ swarm.ts 传参 |
| B2 轻版 | 路由评分加职责文本词法命中 +2（skills 交集仍是硬门槛；responsibilities 此前完全不参与路由） | agent-router.ts |
| B3 铺机制 | SKILL.md frontmatter `kind: reference|action` 解析 + 注入分流：reference 且 CLI 执行器 → 只注入一行路径提示（正文零成本，需要时自读文件）；API 执行器保底注入正文；缺省 action 零变化 | capability-binding.ts / shared/types.ts / context.ts |
| B5 | spawn_tasks 工具描述加四要素教学（目标/上下文/约束/验收标准） | registry.ts |
| 指令/学习二分 | 记忆注入行显式区分：`【协作规则】`→`·规则-必须遵守`，其余→`·经验-参考` | context.ts |

### 待拍板排期（proposed，剩余）

- **A5-E 向量检索**：拍板**不排期**。理由：保持 memory.ts "不引入 embedding"的零向量依赖定调（本地单用户、无外部服务依赖、词法增强已覆盖高频 miss 场景）。若未来词法增强实测命中率不足，再评估本地 ONNX（bge-small-zh + sqlite-vec）方案。
- **B2 完整版**：agent_profile 加独立"何时用我"（whenToUse）字段参与路由（轻版已用 responsibilities 兜住，独立字段供人事匹配与养蜂人选人设复用）。
- **分身收口回写**：已有专项定案（502e010 注释），A7 快照增强与其衔接。
- **B5 完整版**：任务模板/PRD 模板按四要素做必填校验（当前为工具描述教学级）。

## 七、词汇表对齐（muster ↔ 文档五类）

| 文档概念 | muster 对应 |
|---|---|
| Session 记忆 | compaction_summary + project_task_thread（阈值 30/45 run、rotate+恢复阶梯，超出文档描述） |
| Project 记忆 | project scope + 工作台章程 + 项目说明 + 【协作规则】RULE；物化文件（B2'）对齐 CLAUDE.md 载体 |
| Semantic 记忆 | 无（词法替代，A5-L；向量不排期） |
| Episodic 记忆 | LESSON（带 cause 归因+优势分，强于文档） |
| Procedural 记忆 | 三载体：CRAFT（方法论文本）+ 蓝图（组织形状：班底/工具/战绩）+ skills/（可复用流程）。边界：CRAFT=怎么想，蓝图=配谁干，SKILL=怎么一步步干 |
| 指令型/学习型 | locked/RULE ≈ 指令型；其余 ≈ 学习型（触发条件=注入相关性） |
| 分层五级 | personal(用户)/workspace(组织)/project(项目)/skill+persona_key(角色)；无显式"本地级"（本地单用户不需要） |

## 八、验证记录

- 第一轮新增测试 7 个文件 28 用例；第二轮新增 A7/B2 用例 2 个并修 1 处断言（截断严格 ≤ cap）。
- 第二轮全量门：`vitest run` **1667/1667 全绿**（273 文件）；`tsc -b --force` 0 错；**smoke 77/77**（断言对齐 org-lock 定调后）。
- 第一轮全量门：vitest 1665/1665、tsc 0 错、smoke 73/77（4 项失败为 main 既有 org-lock 断言过时，第二轮对齐定调修复）。
- 跑 vitest 注意：不能带 `MUSTER_KEEPAWAKE=off`——keepawake.spec 读该变量会 4 项假失败（off 只用于 e2e/长跑/smoke）。
- 实施中发现并修复的连带问题：物化文件混入安全停 interrupted 事件的文件清单（fileCount 期望 1 实际 3）——`finalizeSafeStop` 文件收集排除 `isMusterManagedContextFile`。
- 迁移 2 个：`20260824100000_memory_candidate_supersedes.sql`、`20260824110000_expert_candidate_routing_miss.sql`（后者为 CHECK 词表重建表，已按 20260819000100 DROP company_id 后的真实结构对齐）。
