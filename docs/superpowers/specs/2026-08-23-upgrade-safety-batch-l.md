# 批次 L：升级安全（用户数据零损失防线）——修软件不能伤用户

状态：proposed（2026-08-23；用户关切：软件发布后用户本地有任务/项目/产物，修复与更新可能导致数据损失、连接不上、找不回来、错误删除；外部 CLI 升级也可能让功能失效。**桌面版+自动更新（git 发布）上线前这是前置必修**——见 muster-desktop-lan-p2p-direction。）

## 现状盘点（2026-08-23 调研）

| 面 | 现状 | 风险 |
|---|---|---|
| DB 迁移 | 按文件名顺序幂等应用（db/client.ts runMigrations）；破坏性重建（DROP+RENAME 表）已有先例（plugin/scope/conversation 三次） | **迁移前无自动备份**——重建类迁移中途失败=库损坏且无退路 |
| 备份 | 设置页备份中心：结构化配置 JSON 导出/导入 + 目录指引（哪些目录要用户自行备份） | 手动、易忘；JSON 只含结构化配置不含产物文件 |
| 文件布局 | 项目在 `MUSTER_HOME/MusterWorkspace/projects/`；任务 worktree/集成分支散布；改名有同卷 mv 迁移（migrateProjectRootDir） | 布局变更无统一登记与回退；worktree 断链后"连接不上/找不回来" |
| 语义变更 | 停止语义/模式收敛等行为变更靠 spec 记录 | 旧状态任务在新版下的行为无自检（H8 做过 stop_requested 遗留兜底=好先例，未成规则） |
| CLI 兼容 | manifests 有 detection/minVersion/limitations；执行器健康记账 | 无版本变化提醒；适配器解析失败报错笼统（"执行失败: ..."不带「CLI 可能已升级」诊断） |
| 回收安全 | 项目软删+回收站（project_trash）；用户目录清理走 mv 隔离区（约定） | 无升级路径上的"误删"防线要求 |

## 模型（五道防线）

### L1 迁移前自动快照（核心底线）

- `runMigrations` 应用前：若有**待应用迁移**，先做 DB 文件快照（`muster.db` + WAL/SHM 三件套 copy 到 `MUSTER_HOME/backups/pre-migration/<时间戳>/`，保留最近 5 份自动滚动）。
- 快照失败 → **拒绝启动**（fail-closed：宁可不起也不能带伤迁移）。
- 快照成功后正常迁移；迁移完成写一行 boot 日志（备份位置），设置页备份中心展示自动快照清单（可手动恢复=复制回 + 重启）。

### L2 破坏性迁移分级标记 + 事务

- 迁移文件头注释约定等级：`-- safety: additive | rebuild | destructive`（无标记默认 additive）。`rebuild/destructive` 必须：①L1 快照已在 ②单文件内自洽（SQLite 无真跨文件事务，rebuild 模式=新表建好→INSERT SELECT→验行数一致→才 DROP——已有先例的做法固化）。
- `runMigrations` 解析标记：rebuild/destructive 且快照失败→拒绝（双保险）。

### L3 升级后完整性自检（bootSelfCheck 扩展）

- 已有 bootSelfCheck（G8）扩「数据完整性」节：启动后核对——项目数>0 时抽样项目 rootDir 存在性、活跃任务 worktree 可达性、schema_migrations 与迁移文件数一致、上版→新版结构 diff 关键表行数（存 `upgrade_check` 表一行记录）。
- 异常分级：warn（照常起+设置页亮红点）/ fail（拒绝起+指引：恢复路径=备份中心自动快照）。

### L4 CLI 升级防线

- 版本变化探测：执行器 detection 结果与上次记录（新 `executor_version_log` 表或复用健康表）不一致 → UI 提醒「pi 已从 0.73 → 0.80，如遇执行失败可能需要重新认证/查看兼容说明」。
- 适配器失败诊断升级：解析失败/非零退出的错误文案统一附「可能原因：CLI 版本升级导致输出格式变化——到设置→执行器重新探测」+ limitations 链接。

### L5 发布清单（流程，非代码）

- `docs/RELEASE-CHECKLIST.md`：每次发版过一遍——迁移是否标注等级/自动快照是否生效（本地真测一次升级路径）/路径布局变更是否登记+旧路径 fallback/语义变更是否给存量状态留兜底/CLI 兼容矩阵（manifests limitations）是否更新。
- **升级路径真测**：用旧版数据目录跑新版（脚本 `scripts/upgrade-drill.mjs`：造一份带历史数据的老库→跑迁移→自检→报告），进 gate 可选步。

## 测试

- L1/L2：集成——待迁移库触发快照（文件存在+内容一致）；快照失败拒启；rebuild 迁移行数校验失败不 DROP。
- L3：自检各分支（正常/项目目录被手动移走 warn/库不一致 fail）。
- L4：版本变化→提醒事件；适配器失败文案含诊断。
- upgrade-drill：脚本跑通一个「旧版库→新版」全流程。

## 边界与不做

- 不做自动回滚（自动快照+手动恢复指引足够，自动回滚在 WAL/文件布局上复杂度不成比例）；不做产物文件的自动云备份；不做 CLI 自动安装/锁定版本（只提醒不接管）。

## 实施记录

（待实施——等用户拍板排期）
