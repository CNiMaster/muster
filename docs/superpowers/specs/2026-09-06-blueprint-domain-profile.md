# 蓝图「打法档案」机制 + 小说蓝图章节生产流水线（inkos 理念对账）

- 日期：2026-09-06
- 状态：已定案（用户拍板：通用程序不预置领域答案；班底六人齐装）
- 来源：用户指路 https://github.com/Narcooo/inkos （AGPL-3.0，只借理念，不搬内容；已登记 THIRD_PARTY_NOTICES.md）

## 定调

muster 是通用程序，小说只是蓝图的一个用例。inkos 值得借的不是它的题材内容（那是人家的答案），而是它把「专业领域怎么组织生产」想清楚的方式。本批全部改动落在 muster 现有概念内：蓝图/阶段/门/人设/成果/维护派发/验收，不新增表、不新增机制名词。

## 概念对账结论

### 已有且更强（不重复建设）
| inkos 概念 | muster 对应 | 强在哪 |
|---|---|---|
| 章节工作区+原子落盘 | worktree+任务集成分支+promote 门禁 | 任务级分支与门禁，不止文件校验 |
| Observer/Reflector 结算 | MAINTENANCE_ROLES 章后维护 Task | 结算岗位常驻、可借调可盘点 |
| Reviser | 返工链+验收员 | 轮次上限+事件留痕 |
| 审计重试 | 阶段门（fail-open/连续 2 败放行） | 显式门+stage_stat 统计 |
| 素材按用途检索 | 知识库 project 级+FTS+knowledgeTargets | 机制已在 |
| author_intent/current_focus | 计划活文档+目标回灌+对话现场 | 方向调整发生在对话里 |
| — | 蓝图进化闭环（stage_stat→优化→版本链） | inkos 没有 |

### 欠一口气（本批融合升级）
1. **打法档案**：inkos 用程序员预置的题材档案+书规则驱动写作与审计；muster 有成果文件与人设知识但无「建档→消费→审计」闭环。补法=成果文件（planning/genre-rules.md，kind=genre_rules，可编辑）+蓝图第一阶段建档纪律；内容不预置，栏位+引导问题，用户自生长。任何蓝图可复制（软件蓝图建技术栈铁律、营销蓝图建渠道打法）。
2. **上下文分级**：inkos 分 protected/compressible；muster 阶段交接段（task-stage.ts stageContextSection）统一措辞。补法=交接段加一句通用纪律：设定/规则/档案类产物是既定约束先读再动，冲突显式提出不静默改写。
3. **章节意图冻结**：inkos 每章 intent 文件+精确落位=字面验收标准。补法=第一阶段产出意图文件（目标/必须发生/绝不允许/伏笔操作），落位要求由既有门与验收员核对。
4. **状态账本**：inkos 伏笔池带生命周期（状态/最近推进/预期回收/依赖/半衰期/陈旧诊断）。补法=canon/foreshadowing.md 模板账本化+半衰期约定；管线内结算阶段随章节同批回写（合并即原子），跨章盘点仍走章后维护 Task——两层结合。
5. **写/审工艺**：inkos 的场景工艺（目标-阻力-转折-后果）、信息释放纪律、章末收在实质变化、去AI味自查、审计「先逐条核对硬约束再评文风、结构性失败≠风格问题」→ 白话自写进人设正文。

### 真没有（后续立项）
- 剧情多线推演（推演任务→分支计划卡→择一写回大纲，不动正史）——需要任务类型与 UI，独立批次。
- 导入已有章节反推建档；去AI味独立技能包。

## 实施

1. 小说蓝图 4→5 阶段（现有 stage schema，gate/staffingPersonaIds）：设定与打法建档+本章意图（情节架构师+世界观架构师）→ 正文写作（主笔）→ 连续性与打法审计（审校，gate=self-check）→ 状态结算（情节架构师+人物设计师）→ 交付归档（主编）。班底 4→6 人；`MAX_STAFFING_SLOTS` 4→6（blueprint.ts，消费方=进化扩员闸+优化器提案校验）。
2. `planning/genre-rules.md` 空栏位模板（章节类型/节奏承诺/反馈与爽点/题材禁忌/疲劳词/读者承诺），kind=genre_rules 进 EDITABLE_KINDS（用户可随时改，下一章生效）。
3. task-stage.ts 交接段加「既定约束 vs 参考记忆」一句（通用，非领域性）。
4. novel-template.ts：foreshadowing/outline/style-profile 模板账本化栏位化；`GENRE_EXTENSION_PACKS` 退役删除（生产链路无消费方，仅测试脚手架引用），`MAINTENANCE_ROLES` 保留（triggers.ts 生产在用）。
5. 六人设工艺强化：主笔（场景工艺/落位硬标准/去AI味自查/档案遵守）、审校（意图与档案逐条核对先行）、架构师（建档访谈流程/意图冻结格式/伏笔账本半衰期）、主编（归档对账清单）、人物设计师与世界观架构师补齐领域专业知识节+借调场景。
6. 预制回填升级规则（blueprint-presets.ts）：source=preset 且 stages/staffing 与旧快照深相等（用户未改）→ 刷成新定义并同步快照；改过不碰。PRESET_DEF_VERSION bump 触发。
7. 测试：blueprint-presets.spec（5 阶段/门/六人/回填升级两分支）、batch7-gap.spec（去题材包断言，岗位测试改手工建岗）。

## 比它好的点（自评）

- 档案内容用户自生长，不预置任何题材答案；机制对任意蓝图可复制。
- 意图落位接进真门（阶段门+验收员），不靠 prompt 纪律。
- 结算两层：管线内轻结算保证账本与正文同批落库；常驻岗位异步重维护不加重每章任务。
- 打法本身会被战绩进化（stage_stat→优化对话），inkos 的管线是静态的。
