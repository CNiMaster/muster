# 复盘：会话压缩上下文丢失与 LLM 经济摘要延续

**日期**：2026-08-19  
**影响范围**：执行器线程轮换（`SessionManager` / `rotateSession`）、压缩摘要注入（`compaction_summary`）  
**状态**：已修复并建立 LLM 经济摘要延续机制  

---

## 1. 现象与问题回顾

在长时间运行的重度任务中，当干员上下文到达 Token 限制或轮换阈值时，非原生支持会话压缩的执行器（如 Claude-code-cli 等）会直接降级走 `rotate` 逻辑清空 session。
导致以下问题：
1. **上下文断崖丢失**：降级 rotate 时 `compaction_summary` 为空，干员在新会话中丢失所有过往执行结论与关键状态。
2. **重复提问与幻觉**：干员遗忘已完成的工作项，重新执行已交付子任务或产生上下文脱节。

---

## 2. 根因分析

- **压缩摘要无自动化管道**：早期仅支持手动输入摘要或使用无意义固定占位文案，未利用轻量大模型做自动化上下文提炼。
- **降级路径无摘要落库**：当 vendor-native `compactSession` 不可用时，直接 rotate 裸丢上下文，未生成 handoff 摘要并同步至 `project_agent_thread`。

---

## 3. 改进措施与长效机制

1. **Economy 档 LLM 自动摘要（`generateCompactionSummary`）**：
   - 聚合 Thread 最近已完成任务、工作交接 handoff 及近期讨论，调用 economy 档 LLM 提炼 ≤400 字结构化中文摘要。
   - 包含失败/超时降级兜底，不阻断压缩与轮换。
2. **全覆盖三路径接入**：
   - 阈值触发压缩、手动压缩、rotate 降级路径均自动落库 `compaction_summary`。
   - 消费侧 `context.ts` 自动将过往摘要注入为 `# 过往会话摘要（已压缩）`，实现平滑无缝延续。
