# Agent Personas Index

| Persona | 角色 | 用途 | 文件 |
|---------|------|------|------|
| code-reviewer | 资深工程师 | 五维度代码审查（正确性/安全性/性能/可维护性/风格） | code-reviewer.md |
| security-auditor | 安全工程师 | OWASP 漏洞审计、攻击面分析 | security-auditor.md |
| test-engineer | QA 工程师 | 测试策略、覆盖率分析、Prove-It 模式 | test-engineer.md |

## 使用方式

这些 persona 作为 Worker 的 system-prompt 注入，按需加载：

1. Leader 在 plan 阶段识别任务需要专家审查
2. 创建 subtask 时指定 `persona` 字段（如 `code-reviewer`）
3. Worker spawn 时加载对应 `.md` 文件作为 system-prompt 的一部分

## 编排规则

- Persona 不互相调用
- 唯一的多 persona 模式：并行 fan-out + merge（如同时跑 code-reviewer + security-auditor）
- 每个 persona 可以使用 skills 目录中的技能工作流
