# 经验库与标签系统 设计（experience-library）

状态：implemented（2026-08-22，X1-X4 批次；同轮全库清扫见 X4）

## 目标（两轮讨论定案）

任务终态反思产出的经验（LESSON/CRAFT）成为**可检索、可归因、可治理**的经验库：

1. **归因分类学**：每条经验带 `cause: model|method|context|tool`——错误是模型能力问题还是方法问题，去处完全不同（模型→执行器档位路由，方法→蓝图/人设，上下文→记忆/意图锚点，工具→能力管理装备请示）。带归因的经验是可路由的行动，不带归因只是故事。
2. **push/pull 分离**：作用域四域（project 锁项目/skill 挂人设/personal 用户/workspace 跨项目）+ 优势分继续决定"装配时注入什么"（零变化）；标签只服务"干活时按需搜什么"——查出来的用完即走，不占基础上下文。
3. **受控词表为主、自由标签为辅**：`cause` 是唯一受控字段；`tags` 自由标签由反思管线写入时自动建议（含域/任务类型词，cap 5），不给用户裸打标签负担。不设紧急度轴——优势分已编码"有用性"（YAGNI）。
4. **跨项目晋升阶梯**：project 经验在 ≥2 个不同项目独立出现且内容高重叠（同 cause + 词元 Jaccard ≥0.4）→ 产生 workspace 晋升**候选**（pending 走既有审核，不自动入库——守住 postmortem 自辩悖论边界：系统只建议，人拍板）。
5. 治理复用现有优势分：排序即淘汰（平庸记忆自然沉底），标签不另设生命周期能量。

## 不做

不动 push 路径（loadContextMemories 注入逻辑零变化）；不引入 embedding（挂观察清单不变）；不做标签同义词自动合并（一期由建议词收敛，观察后再议）；不做平台级 postmortem 自动化（既有"明确不做"）。

## 实施批次

- **X1 域层**：迁移 `20260822000200_memory_tags.sql`（memory_candidate/memory_entry 各加 `cause`+`tags_json`）；memory.ts 全链透传（createMemoryCandidate/approve/接口/行映射）；searchMemory 加 `tag`/`cause` 过滤。
- **X2 反思管线**：LESSON prompt 增两行可选契约 `<cause: …>` + `<tags: 词,词>`；解析校验（cause 不合法视为空不阻断）；drain 透传；`maybePromoteCrossProjectLessons`（同 cause + Jaccard ≥0.4 + ≥2 项目 → workspace 候选，每 tick cap 1）。
- **X3 API+UI**：GET /api/memory/search 增 `tag`/`cause` query；记忆面板条目显示 cause 徽章 + tags chips。
- **X4 全库清扫**：存量冒烟 2 处漂移修复；未用 import 清理；CLAUDE.md 已标死代码核验。

## 验证门

每批 typecheck 0 错 + 本批单测；末批 vitest 全量 + 冒烟 71/71 + e2e 30/30。
