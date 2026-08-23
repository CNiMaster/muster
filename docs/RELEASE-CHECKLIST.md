# 发布清单（每次发版必过）

1. **迁移**：新迁移是否标 `-- safety:` 等级（rebuild/destructive 必标）？本地真跑一次升级路径（`node scripts/upgrade-drill.mjs`）确认 pre-migration 快照生成、服务健康启动。
2. **路径布局**：有无 MUSTER_HOME/工作区目录结构变更？有则必须带迁移+旧路径 fallback 探测，并在此登记。
3. **语义变更**：行为语义（停止/权限/模式/派遣）变了吗？给存量状态留兜底了吗（先例：H8 stop_requested 遗留兜底）？
4. **CLI 兼容**：manifests limitations 更新了吗？五个 CLI 适配器失败文案带升级诊断提示（L4）验证一次。
5. **四门**：`npm run gate`（全量，不用 --fast）真退出码 0。
6. **升级安全专项回归**：migration-safety.spec / retention.spec / tool-loop-context.spec 全绿。
