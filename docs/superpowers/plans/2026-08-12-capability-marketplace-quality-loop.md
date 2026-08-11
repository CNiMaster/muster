# 能力商城与质量反馈闭环 Implementation Plan

> **For agentic workers:** 用 superpowers:executing-plans 逐任务执行。

**Goal:** 让能力推荐反映真实使用质量，并提供跨类型缺口检测，作为任务级能力供给的输入。
**Spec:** `docs/superpowers/specs/2026-08-12-capability-marketplace-quality-loop-design.md`
**Tech Stack:** TypeScript、better-sqlite3、vitest

## Global Constraints
- 不重写 Plugin 模型，只在其上加层。
- 推荐仍是"建议不是强制"；质量分仅用于排序/提示，不阻断。

## File Structure
- **Create:** `src/server/domain/capability-quality.ts`、迁移 `20260812152000_capability_usage_stat.sql`、`tests/integration/capability-quality.spec.ts`。
- **Modify:** `src/server/domain/tool-recommendation.ts`（推荐附质量 + 缺口检测）。

## Task B2：质量反馈闭环 ✅ 已实现并验证
- [x] `capability_usage_stat` 表（capability_id/tool_id/outcome/duration_ms/task_id/occurred_at）。
- [x] `recordCapabilityUsage` / `getCapabilityQuality`（成功率/次数/平均耗时）/ `getAllCapabilityQuality`。
- [x] `resolveToolRecommendations` 一次性取质量并附加到每条推荐（`quality: {successRate, totalCalls}`）。
- [x] 集成测试 5 项（记录+聚合、无数据 null、批量、缺口两种情形）。
- **待办（未在本轮）**：在 `registry.ts executeTool` 内对 MCP 工具调用埋点调用 `recordCapabilityUsage`——需要 capabilityId↔MCP 工具名映射，且属执行器热路径，留作后续集成。

## Task B3：跨类型缺口检测 ✅ 已实现并验证
- [x] `findCapabilityGaps(db, task)`：员工名下"声明能力但无任何已启用工具"的能力清单，供任务级预检消费。
- [x] 测试覆盖"有活跃工具不报缺口"与"引用不存在工具仍算缺口"。

## Task B1：策展注册表 + 一键装 ✅ 注册表已实现并验证（一键装复用既有端点）
- [x] `capability-registry.ts`：`DEFAULT_REGISTRY`（能力标签/安装描述/依赖/vetted 标记）+ `findRegistryCandidates`（缺口→候选，vetted 优先）+ `findRegistryCandidatesForGaps` + `isOneClickInstallable`。
- [x] 单测 6 项（清单完整性、vetted 排序、speech-to-text 命中且可一键装、未审核不可一键装、无匹配、批量映射）。
- **衔接**：vetted 条目的真实安装复用既有 `POST /api/plugins`（MCP）/ CLI 流式安装端点，不在本批重复实现安装链路（避免与既有能力平台重复）；「缺口→候选→既有端点安装」闭环已闭合。

## Self-Review Notes
- 质量分对"无数据"与"质量差"区分（successRate=null vs 低值），避免新能力被误判为差。
- 缺口检测复用现有 `listCapabilityBindings` + `getTool`，无新读侧模型，零迁移风险（仅新增 capability_usage_stat）。
