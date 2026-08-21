# 变更大事记（按季度收敛，整节搬自 CLAUDE.md）

本文档为历史台账：按季度收敛的变更小传。CLAUDE.md 只留薄契约与当前 1-2 代默认行为；追溯时来此。

## 2026-Q3

### 2026-08-20 Workspace 治理（批次1-5，全部在 main 交付，2026-08-21 收口） — 见 `docs/superpowers/plans/2026-08-20-workspace-governance.md`

- **磁盘规矩（`src/server/domain/workspace-layout.ts`）**：`projects/<纯名>`（撞名再加 `-YYYYMMDD`/`-HHmm`/`-2`）；独立任务载体 `tasks/<YYYY-MM>/<MMDD-HHmm>-<截断≤8字>/`（`project_task.repo_root_dir`，同载体多轮共享，`pt-<ptid>` 集成拓扑不变）；基础设施（收件箱/独立任务）在 `.system/`；回收站 `.trash/`；每系统目录写 `.muster/dir.json` marker。
- **MUSTER_HOME 扩展**：`$MUSTER_HOME/MusterWorkspace`（`defaultWorkspaceRoot()`）。**测试三通道全隔离**：e2e / smoke / **vitest（`tests/setup-env.ts` 默认补 MUSTER_HOME+放行测试根，fork 内 `delete` 会击穿故加全局 `beforeEach` 自愈）**。
- **迁移重映射（修复轮）**：`migrateWorkspace`/`recoverInterruptedMigrations` 除 `project.root_dir` 外追加 `project_task.repo_root_dir` 与回收站/绑定目录三列前缀重映射，防载体路径分叉空仓库；`createProject` 显式目录增 `isAbsolute` + `assertPathNotCrossingOtherProjects` 交叉守卫。
- **回收站两段式（批次2）**：`project-trash.ts` —— 前置四拒；`GET /api/projects/trash`、`POST /:id/trash|/:id/restore|/trash/purge`；恢复撞名加日/时后缀；真删 = 系统废纸篓（非 rm）；单人手打目录名、批量「删除N项」、支持「不再提醒」后单删直入；`project_dir`External/attached、`resolveTaskRepoRoot` 外部锚点、`attachedPaths`。
- **存储管理 UI（批次4）**：`POST /api/system/pick-folder`（darwin `osascript`）+ `/storage`（回收站+对账）+ 项目设置工作目录卡 + `/projects/new?mode=open`。
- **双模式（批次5）**：`uiMode = simple|pro`（默认 simple，`POST /api/settings/ui-mode`）；顶栏「简单↔专业」钮；ModeGate 20 条专业路由；命令面板/导航工具项按模式过滤；任务/项目区先后=模式默认+手动偏好（`muster:nav-tasks-first`）；简单模式项目内减负（合并治理后台照常）。

### 2026-08-20 整改批次 1-8：流程闭环 + 自动化中心一期

见 `docs/superpowers/plans/2026-08-19-remediation-and-automation.md`。含发布白名单修复、看门狗、教训层级、memory CHECK 漂移、自动化管家 + GitHub Issues 链。

### 2026-08-19 合并治理大计划（批次 A-J + 修复轮）

计划 `docs/superpowers/plans/2026-08-19-merge-governance-and-blueprint-crews.md` + 修复 `…-merge-gov-fix-round.md`。A-J：运行环境信息（`assembleContext` `# 运行环境` 段）/ `context_window_tokens` 分层 / 任务级集成区 `muster/<pid>/pt-<ptid>`（任务=合并确认单位，promote 回主干才是门禁）/ 待合并看板（`ProjectMergesPage` 系统待合并+孤儿区）/ 冲突时间线加权裁决（`debateMinConfidence`，行协议 `SIDE/CONFIDENCE/RATIONALE`）/ 蓝图专家组合 + 修复轮对齐原计划未达项。

### 2026-08-19 组织与名词统一

详见 `docs/superpowers/specs/org-model.md`（四固定岗 + 隐形岗 + 记忆四体系）。

### 2026-08-18 公司概念退役 A+B+C+D | 项目/任务管理工作台（批1-4）

见 `docs/superpowers/plans/2026-08-20-workspace-governance.md` 与 `docs/superpowers/specs/architecture.md`。

### 2026-08-16 UI 重构 / 蓝图打法包 + 蜂群 | 六问 / 补缺 R1-R3 等早期批次 | staging / 执行器池

见同目录既有计划与 specs：`2026-08-17-executor-pool-*`、`2026-08-17-staging-*` 等。
