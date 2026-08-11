# 任务级调查与能力供给循环 Implementation Plan

> **For agentic workers:** 用 superpowers:executing-plans 逐任务执行。

**Goal:** 把"调研→装备"从项目级一次性提升为任务级：按任务内容检索相关 skill，让未显式声明的任务也能命中 skill 库。
**Spec:** `docs/superpowers/specs/2026-08-12-task-investigation-capability-provisioning-design.md`
**Tech Stack:** TypeScript、better-sqlite3、vitest

## Global Constraints
- 不替代项目级 onboarding；预检是其运行期延续。
- 推荐仍是建议；不强制安装。
- 不重写 `_pumpThread`。

## File Structure
- **Create:** `src/server/domain/skill-retrieval.ts`、`tests/unit/skill-retrieval.spec.ts`。
- **Modify:** `src/shared/types.ts`（ResolvedTaskSkill 增 `retrieved` source）、`src/server/domain/capability-binding.ts`（resolveTaskSkills 注入检索结果）。

## Task B1：内容检索 skill ✅ 已实现并验证
- [x] `skill-retrieval.ts`：`matchSkillsByContent`（纯函数，英文词级 + 中文 CJK 双字滑窗子串匹配）/ `loadSkillCatalog`（扫 skills/*/SKILL.md frontmatter）/ `retrieveSkillsByContent`。
- [x] `resolveTaskSkills` 新增 `retrieved` 来源（优先级 task>field>employee>retrieved>legacy）：按 task.title+summary 检索 Top-3 补位，显式声明覆盖之。
- [x] 单测 5 项（英文排序、中文 CJK 命中、空文本、limit、真实 skills/ 目录解析）。

## Task B2：缺口自愈闭环 ✅ 已实现并验证（预检门 + Researcher 自愈 + 原生联网 builtin）
- [x] **per-task 能力预检门**：`_pumpThread` claim 后、assembleContext 前调用 `performCapabilityPrecheck`（复用 `findCapabilityGaps`），落 `capability_precheck` task_event，并把缺口注入 systemPrompt（执行期可见、不阻断）。集成测试 2 项。
- [x] **自愈派 Researcher 子任务（opt-in）** `gap-research.ts`：缺口非空且公司章程 `contractJson.autoGapResearch===true` 时，派一个咨询子任务给在线研究员（无则第一负责人），带上注册表候选；同 task 节流不重复派；结论「只形成建议」不自动安装（对齐 PRD）。默认关 → 零行为变化。集成测试 4 项（opt-in 门控/派发+落事件/节流/无在线员）。
- [x] **原生 web builtin** `web-tools.ts` + `executeTool` network 守卫分支：注册 `web_fetch`/`web_search`（`permissionAction='network'`），在 executeTool 内统一过 permissionGuard（url 作 command 透传审批；与 MCP 联网工具同流，MCP 无 url→command undefined，行为不变）+ SSRF 基础防护（仅 http/https、拒内网/本机）。单测 11 项（SSRF/抓取/搜索/守卫拦截放行/注册可见）。
- **设计取舍**：自愈默认 opt-in 关（避免自动派单噪声/成本与 PRD 张力）；联网 builtin 复用既有 permissionGuard/审批流而非另开门禁，安全语义与 MCP 一致。

## Task B3：策略选择器 + SOP 模板库 ✅ 已实现并验证
- [x] **策略选择器** `strategy-recommender.ts`：任务形态（调试/UI/API/小说/图像/视频/社媒/文章）→ 推荐 skill + 角色原型 + playbook，数据驱动 `STRATEGY_RULES`，注入 systemPrompt（建议非强制）。单测 8 项（含中英文命中、多规则取最高分、无命中 null）。
- [x] **可复用工作流模板库** `workflow-template.ts` + 迁移 `20260812153000`：`saveWorkflowTemplate`/`getWorkflowTemplate`/`listWorkflowTemplates`/`instantiateWorkflowFromTemplate`（位置索引边、生成新 id 重连、org-lock 守卫、覆盖式实例化）。集成测试 5 项（存读、分类过滤、索引越界拒绝、多次实例化不冲突、覆盖）。补齐「唯独 workflow 无 template 注册表」缺口。

## Self-Review Notes
- `retrieved` 优先级低于所有显式声明来源，避免覆盖用户/模板意图。
- CJK 检索用双字滑窗子串，解决中文任务在英文正则下检索失效的问题。
- resolveTaskSkills 每次调用扫描 skills/（~20 个小文件），开销可接受；如需可后续加内存缓存。
