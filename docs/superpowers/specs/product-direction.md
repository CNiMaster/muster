# Product Direction: Local Agent Workbench（项目主导）

状态：implemented

Muster is a persistent, project-driven local Agent workbench. The former one-shot Leader → Worker → Verifier model is retained only as historical context.

旧 `docs/PRD-agent-company-workbench.md` 为公司时代 PRD，已废弃；当前以本文件与 `docs/superpowers/specs/2026-07-11-platform-workspace-agent-memory-templates-design.md` 等为权威。

## 约束（新增工作必须遵守）

1. 不保留或扩展旧 "quick task" 模式作为产品需求。
2. 复用低层能力：Claude Code 执行、streaming、sandboxing、scheduling、backups、path validation。
3. 域模型朝 Workspace / Agent Profile / Company Employee / Project / Task / Trigger / Artifact / Usage / Executor Profile / Permission / Memory 等演进。
4. 所有真实工作归属一个 Project；Agent Profile 可复用，公司任职等保持隔离。
5. 员工绑定固定执行器，上班后继承但不在任务中静默切换。
6. mirror 为项目内临时并行线程，不新增正式员工。
7. Task 是唯一运行抽象（队列/协作/澄清/反馈/触发/讨论）。
8. 平台拥有确定性基础设施；语义决策必须归属显式 Agent。
9. 并发操作不得静默覆盖或丢失项目文件。
10. 题材域保留小说（novel）预设；Multi-tenant SaaS / payments / 全量文档编辑不在本地成品边界。

详见 `docs/superpowers/specs/2026-07-11-platform-workspace-agent-memory-templates-design.md`、`docs/superpowers/plans/2026-07-11-vnext-guided-workspace-foundation.md` 等。
