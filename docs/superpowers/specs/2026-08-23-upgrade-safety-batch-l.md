# 批次 L：升级安全 + 数据治理 + 上下文治理（用户 2026-08-23 定调六项全补）

状态：proposed（用户：CLI 对齐、数据迁移、数据清理（用户想清过期信息）、数据压缩、对话内容压缩（谁控制？连续工作断不断？）、升级缺口——都需要补。**桌面版+自动更新（git 发布）上线前前置必修**——见 muster-desktop-lan-p2p-direction。本版合并原「升级安全」spec 并扩展。）

## 现状结论（2026-08-23 调研）

- 迁移无前置备份（重建类迁移中途失败=库损坏无退路）；备份中心=手动 JSON 导出；DB=WAL 模式三件套。
- runs/ 隔离目录有 14 天 TTL 自动清扫（run-housekeeping）；StoragePage 存储管理页已有；项目软删+回收站、清理走 mv 隔离区约定已有。
- **API 型执行器（openai-adapter/tool-loop）消息数组无限增长**——零截断零压缩，长任务必然顶到模型上下文上限。
- **CLI 型会话由 CLI 自管**：claude 上下文满时自动压缩为摘要，**session id 不变** → 我们 `--resume` 的连续性**不断**（压缩发生在会话内，不换会话文件）。结论：CLI 型「他们自己管=可以，我们连续工作不受影响」——本 spec 落观测锚点而非接管。
- 无 DB VACUUM/归档；trace/事件/审计表随使用线性增长；适配器失败报错笼统不带 CLI 升级诊断。

## 分段

### L1 迁移前自动快照（fail-closed 底线）

- `runMigrations`：有待应用迁移 → 先快照 `muster.db`+`-wal`+`-shm` 到 `MUSTER_HOME/backups/pre-migration/<ISO 时间戳>/`，自动滚动保留 5 份；**快照失败→拒绝启动**（宁可不起也不能带伤迁移）。
- 备份中心（设置页）展示自动快照清单+恢复指引（复制回+重启）。

### L2 破坏性迁移分级

- 迁移头注释 `-- safety: additive | rebuild | destructive`（缺省 additive）；rebuild/destructive 要求快照成功才执行；rebuild 固化「新表→INSERT SELECT→**行数一致校验**→才 DROP」。

### L3 升级后完整性自检（bootSelfCheck 扩展）

- 项目 rootDir 存在性抽样/活跃任务 worktree 可达/schema_migrations 与迁移文件数一致/关键表行数记录（upgrade_check 表）。异常分级 warn（照常起+设置页红点）/fail（拒起+恢复指引）。

### L4 CLI 对齐

- 执行器版本变化探测：detection 结果 vs 上次记录（复用健康记账）不一致 → UI 提醒+manifests limitations 链接。
- 适配器失败诊断文案统一附「CLI 版本可能已升级——设置→执行器重新探测」。

### L5 数据清理（用户想清过期信息——手动可控+预览+可恢复）

- 存储管理扩「过期信息清理」：分类列出（旧 trace 事件/审计日志/已终态任务 staging 残留/自动快照超额份/隔离区）+ 数量与体积 + 单类/全选（预览明细→确认→**mv 进隔离区不直接删**）。
- TTL 规则集中域单源 `retention.ts`：runs 14d（已有）/trace 事件 90d/审计 180d/快照 5 份；boot sweep 挂 coordinator。

### L6 数据压缩

- 清理动作完成后触发 `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM`（低频：清理时触发而非每次 boot）；归档优先：清理的 trace/事件先导出压缩 JSONL 到 `backups/archive/`（保留 TTL 两倍时长）可找回。

### L7 对话内容压缩（分层控制权，保连续）

- **API 型（我们控制）**：tool-loop 加上下文治理——消息数/估算 token 超阈值（设置项 `context_budget`，默认保守值）时，把最早 N 轮工具循环压缩为一条 checkpoint 摘要消息（economy 档 callLlm 生成「已完成步骤与结论」），后续消息接续——**内存内延续不换线程，连续工作不断**。
- **CLI 型（CLI 控制，我们观测）**：不接管 claude/codex/pi 自动压缩；每次 run 记录会话长度与用量进 trace；vendor_session_id 跨 run 断言已有，spec 记「压缩后 session 仍可 resume」结论锚点。
- 侧边对话 12 轮窗口（I-b）不动。

### L8 发布清单+升级演练

- `docs/RELEASE-CHECKLIST.md`；`scripts/upgrade-drill.mjs`（造旧库→跑迁移→自检→报告），可挂 gate 可选步。

## 测试（每段随实现补）

L1 快照触发/失败拒启/滚动保留；L2 行数校验失败不 DROP；L3 分级；L4 提醒与文案；L5 预览+隔离区+TTL；L6 checkpoint+VACUUM 触发；L7 阈值触发摘要压缩+后续工具循环可用+结果不丢；L8 drill 跑通。

## 边界与不做

不做自动回滚/云备份/CLI 版本锁定；不压缩产物文件本体；CLI 型不接管压缩（观测+提醒）。

## 实施记录

- **L1 迁移前快照**：snapshotDbBeforeMigration（三件套+manifest 恢复指引，滚动 5 份；失败抛错=拒启）挂 runMigrations pending>0 分支；备份中心新端点 GET /api/backup/pre-migration-snapshots。
- **L2 分级**：migrationSafety 解析头注释；历史 15 个表/列重建迁移全部补标 `-- safety: rebuild`（含测试断言防漏标）。**偏差**：SQL 内行数校验不可通用化（纯 SQL 无控制流）——落为 rebuild 模板规则+upgrade-drill 全链验证，spec 原案调整记录。
- **L4(a) 失败诊断**：五 CLI 适配器（antigravity/custom/codex/opencode/pi）失败文案统一拼 CLI_UPGRADE_HINT（「CLI 版本可能已升级→设置→执行器重新探测」）。
- **L5+L6 清理与压缩**：retention.ts TTL 单源（trace 90d/审计 180d）+previewCleanup 所见即所得+executeCleanup（**归档 JSONL.gz 可找回→删除→wal_checkpoint(TRUNCATE)+VACUUM**，归档滚动 20 份）；备份 API 两端点。
- **L8**：docs/RELEASE-CHECKLIST.md 六条+scripts/upgrade-drill.mjs（隔离 home 起服务→健康+快照断言，已真跑通过）。
- **L7 上下文治理**：tool-loop contextGovernance（默认 48 条阈值→确定性摘要保留系统+近 8 条，内存内延续不换线程；null 关闭）。**偏差**：v1 用确定性摘要（assistant 结论/工具名/输入首行截 4000 字）而非 callLlm 摘要——不引入 LLM 新失败面+确定性可测，LLM 摘要留 v2。
- **留 v2（偏差记录）**：L3 bootSelfCheck 完整性扩展、L4(b) 执行器版本变化主动提醒、清理 StoragePage UI 节、L7 设置项 context_budget、retention boot sweep 挂 coordinator。
- **追加轮（用户两问）**：①快照空间预算——滚动不止看份数（5 份），总量超 max(库 2 倍, 50MB) 即删最旧至少留最新 1 份（库大时份数让位于空间）；②**旧数据兼容回归**（用户点破真缺口：测试库全是新造的，从未验证旧数据跑新代码）——upgrade-compat.spec：只用前 N-3 迁移建库（模拟旧版本）+种旧数据（含旧形态 JSON）→跑完剩余迁移→断言行数不丢+pre-migration 快照生成+域函数可读+旧 JSON 容忍。RELEASE-CHECKLIST 增补第 7 条。
- **测试**：migration-safety 4（快照触发/滚动/幂等/分级+历史标注防漏）+tool-loop-context 3（摘要内容/压缩生效近尾部保留/null 关闭）+retention 2（预览+归档读回+VACUUM+滚动）；upgrade-drill 真跑通过。
