# 0004 跨模块接线缺陷簇——chain-and-visibility 批次的高级审查发现

日期：2026-08-22 ｜ 批次：B1-B5（feat/chain-and-visibility，合并 c2b2d3f）｜ 审查轮发现 3 必修 + 开发轮返修 9 处

## 事实

高级审查轮（合并前）发现三处必修：

1. **观测口径污染**：B5 用裸 `listAgents({includeHidden:true})` 修报表/备份/驾驶舱，把活跃蜂群工蜂（swarm-worker）与辩手一起带入——报表被逐蜂条目灌爆、备份快照恢复后产生僵尸员工。
2. **@负责人 半接线**：服务端 `LEAD_MENTION_KEYWORDS` 展开逻辑完整且有测试，但前端 `extractMentions` 只认已知名字、丢弃未知 token——关键词永远到不了服务端。功能在单侧各自"完成"，端到端死亡。
3. **提示词双重携带**：`resolvedToolChain` 快照经 inputPacket JSON 进提示词，`# 装备决议` 段又渲染一遍（未对齐 userImages 先例）。

开发轮返修（每批 review-fix 记录在各自 commit）：B1 对象字面量语法错 + reason 键与系统约定撞名 + chainHistory 机器 ID 污染提示词；B2 钳后值未传入 createSwarmRun 群快照；B3 ESM 误用 require + capabilityId 误用展示标签当查询键；B5 同步函数误用 await import + contactAllow 种子漏读项目级负责人。

## 根因

按缺陷位置归类，**域内算法几乎零缺陷，错误全部落在"把两个已有系统接起来的那根线"上**：

- **数据流追踪不完整**（B2 钳制：一个值两个消费方只改一处；B5 种子：负责人概念两个存储位置只读一处）——改的是路径，没改的是路径的全部。
- **写前不查对端签名**（materializeSwarm 返回形状靠猜、postUserMessage 同步签名没看、require/await 习惯性写出）——凭记忆写代码而非读代码。
- **键名不做消费方检查**（reason 撞系统约定、'蓝图打法' 标签当 capabilityId 查询键）——字符串类型化契约天然邀请碰撞，引入新键前没有 grep 消费方的动作。
- **成对功能无端到端线程**（@负责人 前后端两半各自验收）——单侧测试绿 ≠ 系统活着。
- **计划散文直译代码**（"{ chainHistory }" 从计划文本原样进了代码）——计划语言与代码语言混淆。

## 为什么自检没拦住

- typecheck/vitest 是每批验证门，但它们验证**我意图写的行为**，不验证**我没想象的集成**——require-in-ESM、await-in-sync、半接线都不在任何测试射程内，只有通读对接双方才能看见。
- "写快审慢"的双模式让审查轮抓到了全部三处必修——但审查轮发现它们的成本（返工+复审）远高于写时慢十秒读一遍对端签名。
- Edit 大段替换两次截断 agent.ts（old_string 边界吞了不该吞的行）——替换后没有立即 Read 验证结构完整。

## 补强了什么

1. **新键入 inputProtocol 前必 grep 消费方**（10 秒防撞名，reason 教训）。
2. **跨模块接线前必读双方签名**：返回形状/同步异步/键语义（require/await/形状三类错误一次归零）。
3. **改一个值先列全消费方清单**：grep 所有读点再动手（双写点教训）。
4. **前后端成对功能必须留一条端到端线程**（集成测试或 e2e）才算完成——单侧完成不算完成。
5. **大段 Edit 后立即 Read 验证结构**（截断教训；同 0002"不凭记忆写列"同族——不凭记忆写边界）。
6. 装备决议快照对齐 userImages 先例 `delete inputPacket.resolvedToolChain`——**新的大对象进 inputProtocol 时同步决定"进不进提示词"**，写进 context.ts 就地注释。

> 本篇同时回填记忆索引中悬空的「复审盲区镜头清单」（七类查法），跨会话生效。
