# 选择闭环专项（S 系列）：意图 → 能力匹配 → 结算 → 越用越准

**日期**：2026-08-27
**动机**：通用 agent 的"工具选择最后一公里"存在三层不确定性叠加——需求不确定（用户没说给谁看/要不要改）、工具不确定（同域几十种方案各有失败模式）、偏好不确定（用户看到成品才知道喜不喜欢）。不存在一次到位的银弹，本专项把不确定性用最低用户成本逐步消解，并把消解过程沉淀为数据资产。
**边界声明**：讨论虽由"做 PPT 有几十种工具"引出，但本专项做的是**通用服务架构**（意图路由/能力画像/偏好沉淀/使用结算），不为任何单一场景（含 PPT）做特化优化。

## 北极星

> 用户每一次选择、每一次纠偏、每一次工具成败，都自动沉淀；下一次同类任务，问得更少、选得更准、执行更对路。**判断体系成熟的标准：第二轮问询比第一轮短，第三轮不问。**

## 定案原则（讨论收敛，实施期间不再重议）

1. **条件偏好，不是全局偏好**。偏好必须以 (用户 × 意图类型 × 路线) 三元组落库，禁止裸 (用户, 工具)。召回先判"这次任务和哪条历史同类"，不同类宁可当没有记忆——宁可不用，不可误用（防"需求变了被误读成偏好变了"导致的绕远路）。
2. **偏好记忆的输出是带置信度的先验，不是决定**。三态消费：高置信静默走 / 中置信确认式默认值（预填答案的封闭问题，用户点一下即纠偏）/ 低置信展开问。"懒不懒"每次按本次意图信号质量动态算，不写死策略。
3. **偏好永远不能跳过意图识别**，只能加速"意图确定之后"的能力匹配。纠偏信号进库前先分类：**需求声明**（"我这次要上台讲"→ 更新条件 intent_tag，不否定既有偏好）vs **路线不满**（"改字还得改代码"→ 更新偏好）。两类混写会越学越脏。
4. **口碑 > 静态标注 > 实时调研**。工具画像随真实使用结果自动生长；发行方只维护 schema、意图槽位默认路线、最小可信工具集的出厂种子（静态标注只是冷启动种子，排行榜三个月洗牌是活证据）。画像更新用增量/衰减，不一票否决（任务失败可能是需求烂，不全是工具的锅）。
5. **热-温-冷三层成本结构**：
   - 热结算（任务收尾趁热）：结构化为主不进 LLM（纯 SQL）；语义部分对 CLI 执行器走同会话 resume 追加（免上下文重建是大头，缓存命中是锦上添花）。机会主义：失败静默降级到温层。
   - 温反思（现有白日梦 enqueue→drain 管道原样保留）：接重活（跨任务归纳、失败根因、技能/专家合成）。
   - 冷调研（仅任务内联网）：**禁止后台默认联网搜索维护——用户禁忌**。联网只发生在用户任务的执行路径内。
6. **skill 选用的用户意向边界**：任务开始时检查"有没有合适的专业 skill"（本地能力库画像匹配），但是否启用看**需求复杂度 + 用户意向**——建议式问询，不自动装、不自动用。光靠模型智慧不如专业优质 skill，但替用户做决定越界。
7. **记忆三层节奏 + 两档开关**：写时只碰 top-k 邻域（O(top-k) 不扫库）/ 读时顺手打脏标记（零额外成本哨兵）/ 条件触发摊销压实（只压脏分区，攒批摊薄）。**内务（默认开、预算封顶、空闲让路）与白日梦反思（默认关）拆成两档开关**——数据库 vacuum 不需要用户批准，"AI 主动复盘"才需要；塞同一个开关会让关复盘的用户误关扫地。
8. **记忆住中心 DB，永不进项目文件夹**。项目身份是 `project.id` 不是路径；多目录项目（主目录+attached）没法归属到文件夹；personal/craft/口碑等跨层记忆不属于任何单项目；FTS/审批/压实基础设施在库内；外部项目零侵入（铁律：永不写 marker）。`.muster` 是程序数据根不是项目记忆容器，marker 保持对账用途。导出面（按项目导出/bundle）是**视图不是事实源**。
9. **不做清单**：后台自动联网调研维护；默认多方案/样张竞争（**用户明确要求才触发**——未付费不先烧钱；将来做也必须是通用机制）；任何单一场景专项优化。

## 现状地基（已探查确认，全部可复用）

| 挂点 | 位置 | 说明 |
|---|---|---|
| 热结算挂点 | `src/server/task-engine/engine.ts:1270` | task_end 钩子 + `hook.ts` HOOK_EVENTS，收尾段同步内联 |
| 异步结算模板 | `src/server/domain/reflection.ts:180` | drain（coordinator 10s 定时器，maxPerTick 3，UPDATE...RETURNING 原子领取，drainInFlight 互斥） |
| CLI 会话恢复 | engine.ts:856/895 vendorSessionId | 引擎已用同机制做 `/compact`，resume 追加结算调用技术可行 |
| API 会话即焚 | `src/server/executors/tool-loop.ts:583` clearLoopProgress | 成功收口即清消息快照——**语义结算执行器不对称，API 侧挂清理前或降级** |
| 工具遥测 | `capability_usage_stat` 表（capability-quality.ts:33 写入） | **只埋了 API 工具环**（tool-loop.ts:540 finally）；CLI 原生工具只进 execution_trace，待补录 |
| 任务技能快照 | `task.inputProtocol.resolvedSkillIds`（engine.ts:753） | 任务加载了哪些 skill 的现成事实源 |
| 偏好事件范式 | `decision_record` 表 + recordDecisionFromClarify（task.ts:1152） | 已区分 source user/auto 防污染，已带 options_json/chosen |
| 确认式问询 UI | questionOptions + answerClarification + WaitingQuestionReply | A/B/C 结构化选项全链路现成（ConversationPanel.tsx:378），选 option 自动沉淀决策 |
| 画像字段通道 | SkillManifest.frontmatter 开放字典（plugin-adapter.ts:50 透传任意键） | name-zh 先例：加键零代码风险；读取侧模板 skillZhMeta（CapabilityCenterPage.tsx:89） |
| 开关三件套模板 | setting.ts:140/226 + SettingsPage.tsx:282 + coordinator 门控 | `autonomous_reflection_enabled` 全链路可仿写 |
| 压实雏形 | maybeConsolidatePreferences（reflection.ts:798） | personal ≥3 同域合并已存在，扩展为分区压实主体 |
| 写时局部去重先例 | skill-synthesis.ts Jaccard ≥0.4 | 结算写前 top-k 相似检索的既有做法 |
| personal 注入痛点 | loadContextMemories（memory.ts:454） | personal 层**永远全量注入**（limit 8 钳 1..20）——膨胀直接伤每次注入，S4 优先级依据 |

## 核心数据模型（S1 落地草案）

### preference_event（新表，仿 decision_record）

```sql
CREATE TABLE preference_event (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL,            -- 归属员工/用户画像
  intent_tag    TEXT NOT NULL,            -- 意图槽位（条件偏好的"条件"，如 deliverable/presentation/interactive）
  route         TEXT NOT NULL,            -- 被选中路线（plugin id 或能力路线名）
  alternatives_json TEXT NOT NULL DEFAULT '[]',  -- 当时展示过的候选（含未选的）
  source        TEXT NOT NULL CHECK (source IN ('user','auto')),  -- user=用户显式选择；auto=三态高置信静默
  kind          TEXT NOT NULL DEFAULT 'route-choice'
                CHECK (kind IN ('route-choice','need-statement','route-complaint')),
                -- need-statement=需求声明（只更新条件画像）；route-complaint=路线不满（影响口碑）
  task_id       TEXT,
  created_at    TEXT NOT NULL
);
```

召回查询 = 先按 intent_tag 匹配本次意图分类，再取该槽位下 user 优先、近期加权的路线分布；分布集中=高置信，分裂=低置信。

### 工具口碑（扩展现有表，不新建）

`capability_usage_stat` 已有 (capability_id, outcome, task_id, occurred_at)。补两件：
- CLI 埋点补齐（execution_trace 的 tool_call 补录，统一遥测口径）；
- 口碑聚合视图或轻表：按 capability_id × intent_tag 聚合成功率和采纳率，带衰减时间窗（近期样本权重高），连挂 N 次才降权——不一票否决。

### skill 画像 frontmatter（通用维度，非场景特化）

沿用 name-zh 模式加开放键：`use-cases`（适合场景，列表）、`output-format`（输出物形态）、`editability`（可后续编辑程度）、`complexity`（适用需求复杂度）。发行方种子只标最小可信集，其余靠 S2 结算生长。

## 批次设计（S1→S5 按依赖排序，每批独立验证交付）

### S1：数据地基
- skill frontmatter 画像键落地（解析侧 plugin-adapter 已透传，读取侧仿 skillZhMeta；先给内置 24 件技能补种子标注）。
- `preference_event` 表 + migration（官方时间戳命名）。
- capability_usage_stat 补 CLI 埋点（execution_trace 补录路径）。
- 验证门：migration 单测 + domain 单测 + `tsc -b --force` 0 错。

### S2：热结算（趁热结算钩子）
- 挂 task_end（engine.ts:1270 收尾段）：
  - **结构化结算（全执行器，纯 SQL 不进 LLM）**：resolvedSkillIds × capability_usage_stat 聚合、返工轮次、验收通过与否 → 口碑增量 + preference_event（kind 按纠偏语义分类）。
  - **语义结算（按执行器分叉）**：CLI 走 vendorSessionId resume 追加一次结算指令，吐结构化 JSON（用户抱怨性质归类、失败归因初判），输出走 stream-json 解析**不进用户可见消息流**；API 挂 clearLoopProgress 前复用 loop_progress 快照，不可行则降级 enqueueReflection。
  - **机会主义**：任何结算失败静默降级到现有温反思队列，绝不卡收尾。
- 护栏：失败任务衰减系数、成功增量；影响路由的口碑更新可审计（S7b 控制面口径，走审计/通知链）。
- 验证门：真实任务跑通结算落库 + 单测（含降级路径）+ tsc。

### S3：读侧消费（三态偏好 + 能力适配检查）
- 意图置信度判定：信号 = 用户原话词元 / 附件类型 / 该用户此槽位历史分歧度。输出三态：
  - 高置信 → 静默走（decision_record source=auto 落痕）；
  - 中置信 → 确认式默认值：questionOptions 带默认徽章，复用 answerClarification + recordDecisionFromClarify 全链路，WaitingQuestionReply 渲染"推荐"标记；
  - 低置信 → 展开问（结构化选项，不问开放题）。
- **任务开始的 skill 适配检查**：意图槽位匹配本地能力库（画像字段 + tool-streak 惯用信号），命中专业 skill 时按需求复杂度 + 用户意向建议式问询（"这活有个专业技能，用不用？"），不自动启用。
- 全程本地，无后台联网。
- 验证门：意图→路由单测 + 浏览器实测问询交互（确认式问题点击即沉淀 preference_event）。

### S4：记忆内务
- 读时脏标记：loadContextMemories 检索时顺手观察 top-k 相似扎堆 / 长期低 can_influence → 打待压实标记，当时不处理。
- 条件触发分区压实（扩展现有 maybeConsolidatePreferences 为主体）：触发 = 脏标记 ≥20 或新增 ≥50 或 7 天兜底；只压脏分区（scope × 类目）；economy 路径（结构化能算的不进 LLM）。
- 两档开关：`memory_housekeeping_enabled` 默认开（setting 三件套仿写；每 tick 条数 + token 双上限；空闲让路）。
- 健康度可视化：设置页/记忆看板展示膨胀率/重复率/命中率，让关掉内务的代价可见。
- 验证门：压实幂等单测 + 健康度口径单测 + tsc。

### S5：可见性与迁移（瘦身后，最后做）
- 按项目导出：project scope 记忆 → Markdown/JSON（视图非事实源，backup-export 哲学沿用）。
- bundle 导入导出协议：换机/移交同事；精确裁剪 scope 层（只带 project，不带 personal——用户偏好不随包误送）。
- 可选：市场安装后本地异步补画像（economy LLM，不联网）。
- **明确不做**：后台自动联网调研触发器。

## 风险与约束

1. **执行器不对称**：API 侧语义结算可能只能降级（结构化部分不受影响）。S2 顺序：先结构化全量 → CLI 语义先行 → API 视快照可行性。
2. **CLI resume 结算勿污染会话**：结算指令输出独立解析，绝不写进用户可见消息流；结算调用本身要在预算治理线内。
3. **personal 全量注入**：S4 未上线前 personal 层膨胀持续伤每次注入质量——S4 优先级不应低于 S3。
4. 每批次验证门：`tsc -b --force` 0 错 + 定向 vitest 全绿（核对 Tests passed 总数防管道吃失败信号）+ 关键交互浏览器实测。
5. 工作环境：本专项在 worktree（muster-selection-loop）实施，白名单文件合回 main，绝不 `add -A`；不在 worktree 跑 npm install（软链 node_modules）。

## 讨论关键转折留痕（为什么是这些设计）

- 全量生成（40 选 1）/固定预制/先问再选三策略均被否：成本爆炸/丧失通用性/填表负担；收敛为"渐进 + 三态 + 反馈闭环"。
- "零询问启动"被用户反例修正（需求变了≠偏好变了）→ 条件偏好 + 先验三态。
- "白日梦阶段维护工具库"被修正为拆两件事：结算（每次、趁热、便宜）vs 调研（低频、仅任务内）；并发现缓存经济学（免重建+缓存命中）只对 CLI 执行器成立。
- "每任务后整理记忆"被否（O(N×T) 冗余）→ 三层节奏 + 摊销压实。
- 后台联网调研、默认样张竞争被用户划为禁忌/越界 → 进不做清单。
