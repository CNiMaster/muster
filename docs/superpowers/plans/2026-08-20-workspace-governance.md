# Workspace 治理 + 任务优先 IA + 双模式（2026-08-20 定案）

状态：批次1-4 已交付（implemented）；批次5（双模式）待做。2026-08-21 起在 main 直接开发（治理分支已合并删除）。

## 背景（问题实锤 2026-08-20）

`~/MusterWorkspace/projects` 实测 367 个目录、**0 个真实用户项目**、356 个带 `.git`——全部是测试残留，且 2026-08-18 e2e 隔离（MUSTER_HOME）合入后仍在每天新增。根因：MUSTER_HOME 只隔离 DB/worktrees/runs，workspace 根写死 `join(homedir(), 'MusterWorkspace')`（project.ts defaultRootDir 调用点），测试建项目全部落真实目录，而 DB 是一次性的 → 目录成永久孤儿。叠加：`removeProject` 铁律永不碰目录（保护用户数据，正确）+ 无任何孤儿对账 → 只进不出。

## 定案（用户拍板）

1. **定位**：开源大众+程序员通用软件，无管理员，软件自运转（治理引擎照常自动跑，简单模式不亮术语）。
2. **形态**：单应用双模式，默认简单模式，顶栏切换；项目类型只定首次默认。IA 任务优先——简单模式任务区在上/项目区在下，专家模式反之；手动调整持久化。
3. **磁盘规矩**：`projects/<纯名>`（仅撞名时后来者加 `-YYYYMMDD`，同日到 `-HHmm`，终极 `-2`；显示名永无后缀）；独立任务载体 `tasks/<YYYY-MM>/<MMDD-HHmm>-<截断≤8字>/` 懒创建；基础设施（收件箱/独立任务）迁 `.system/`；回收站 `.trash/`（批次2）。每目录写 `.muster/dir.json` marker。
4. **多目录绑定**：`project_dir` 表（system|external|attached）；新建项目三入口（默认位置/打开文件夹-系统选择器/远程连接-一期占位）；绑定即写授权；git 仓库自动作 worktree 锚点；非 git 直写+变更记录；附加目录永不进回收站、解绑不删盘。
5. **回收站两段式**：项目→软件回收站（可查/追踪/恢复/单删/批删）→系统废纸篓（trash 机制非 rm）。真删手打确认（单个=目录名，批量=「删除N项」一次）；「不再提醒」后单删直入系统废纸篓；不自动清理，超30天仅标记。
6. **明确不做**：不代删用户目录；两个界面/运行中自动切换；远程连接实现；非 git 附加目录任务级隔离；旧 id 后缀存量目录不迁移；上轮砍单 11 项维持（Eval Harness/忠实度 Verifier/coverage 门/ADR 迁移等，见同日会话记录）。

## 批次1 已交付（本 commit）

- **根因修复**：`workspace-layout.ts` 新模块=磁盘规矩唯一事实源；`defaultWorkspaceRoot()` 跟随 MUSTER_HOME（project.ts/muster-directories.ts/api/setup.ts 三处调用点切换）；真实用户未设该变量行为不变。
- **命名规矩**：`uniqueProjectSegment`（纯名→日期后缀→分钟→-2，撞名判定=磁盘+DB root_dir）；`sanitizeSegment` NFC 规范化+去尾部点（Windows 兼容）；独立任务 `standaloneTaskSegment`；基础设施 `infraDir(.system/inbox|standalone-tasks)`。
- **独立任务按载体分仓**：迁移 20260820000100 `project_task.repo_root_dir`；`task-repo.ts` `resolveTaskRepoRoot`（懒创建 mkdir+git init+task marker+记录；幂等；同分钟同标题 -2 递增）+ `peekTaskRepoRoot`（只读，看板/列表绝不触发落盘）；接线：engine.ts（worktree 源/权限根/发布链 6 处）、staging.ts（promote/看板按载体分组批量取 refs）、conflict-judge.ts、api/projects.ts（merge-status/discard）。同载体多轮共享一仓，pt-<ptid> 集成分支拓扑不变。
- **改名跟随**：updateProject 改名且未显式指定 rootDir 时，系统管理目录（workspace/projects/ 下且目录名吻合旧名形态）同卷 mv 跟随；迁移失败（活跃任务等安全阀）降级为只改名不抛错。
- **marker + 对账**：`ensureGitRepo` 落盘即写 `.muster/dir.json`（幂等保首录）；`workspace-audit.ts` 双向 diff（orphanMarked=带marker无记录 / unknown=无marker无记录 / ghostRecords=有记录无目录，只读绝不删）；`GET /api/workspaces/audit`；`scripts/workspace-audit.mts` dry-run 清单脚本（供人工清理 367 个残留参考，脚本不删任何东西）。
- **测试隔离根治**：`tests/setup-env.ts`（vitest setupFile 首位）默认 `MUSTER_HOME=mkdtemp`+同步放行 MUSTER_ALLOWED_ROOTS——单测/e2e/smoke 三类泄漏全部断根；显式设置者不受影响（??= 语义）。
- **验证**：tsc 0 错；vitest 212 文件 1356/1356（含新 workspace-governance.spec 10 例：命名/隔离/基础设施迁移/marker/载体分仓幂等+撞名/改名跟随+降级/对账三分）；e2e 24/24；**全量跑完后 `~/MusterWorkspace/projects` 前后 diff 零新增**。project.spec/workspace.spec 两处旧命名断言（`名-pr_` 后缀）随新规矩更新。

## 批次2 已交付：回收站域层+API

- **迁移 20260820000200** `project_trash` 表（project_id PK CASCADE/original_root_dir/trash_dir/size_bytes/paused_automation_ids_json/batch_id/trashed_at）。
- **`src/server/domain/project-trash.ts`**：
  - `precheckTrashProject` 人话阻塞清单：基础设施拒/active 拒（先暂停或完结）/进行中任务拒（防丢草稿）/未合并 pt-集成区拒（防悬空，数据源=待合并看板）。
  - `trashProject`：终态任务残留 worktree 先清（防指针悬空）→ 目录 rename 进 `.trash/<时间戳>-<名>/`（同卷原子）→ 绑定自动化 enabled=0 记账 → settings.trashed+removed 隐藏。幂等。ghost 项目（目录未落盘）允许入站（trash_dir=''）。
  - `listTrash`：可查/可追踪清单（原名/原路径/大小/入站时间/搁置天数/暂停的自动化/批次号）。
  - `restoreProject`：原位空闲回原位；被占（磁盘或 DB）→ 走同一撞名日期后缀规则换新目录；返回暂停过的自动化清单提示重开（不自动重开）。root_dir/settings 直写库（绕开 updateProject 的物理迁移校验——目录已搬好）。
  - `purgeFromTrash`：确认语义服务端强制——单个=手打**原目录名**、批量=手打「删除N项」一次；真删=移入系统废纸篓（MUSTER_TRASH_DIR 覆盖/darwin ~/.Trash/linux FreeDesktop，非 rm；废纸篓内撞名加时间戳）+ 删库（取消任务→归档载体→删 project 行，FK 级联，同 removeProject deleteRecords）。「不再提醒」偏好属 UI 层（批次4），系统废纸篓兜底常在。
- **API**：`GET /api/projects/trash`（清单）、`POST /api/projects/trash/purge {ids,confirm}`、`POST /api/projects/:id/trash`、`POST /api/projects/:id/restore`；`/api/projects?view=removed` 排除回收站项目（专属视图不混入）；生命周期事件 `project.trashed`/`project.restored`。
- **测试** `tests/integration/project-trash.spec.ts` 10 例：四类前置校验拒（active/进行中任务/未合并集成区含真实 pt-staging 提交/基础设施）/移入记账+幂等/自动化暂停+恢复提示/恢复撞名后缀/ghost 入站恢复/真删单批确认语义+库删净+目录进（测试注入的）系统废纸篓。
- **验证**：tsc 0 错；vitest 213 文件 1366/1366；e2e 24/24；真实 workspace 零新增。

## 批次3 已交付：project_dir 多目录绑定

- **迁移 20260820000300** `project_dir` 表（project_id CASCADE/path/role=external|attached/label/is_anchor；`UNIQUE(project_id,path)` + 单锚点部分唯一索引）。**表只记 external/attached**——系统主目录仍走 `project.root_dir`（合成行，零双写漂移）。
- **`src/server/domain/project-dirs.ts`**：
  - `attachProjectDir`：绝对路径/存在/目录/同项目重复拒/**与任何项目的目录（含本项目主目录与已绑目录）祖先-后代交叉拒**（防跨项目误写）/基础设施项目拒。绑定永不写 marker、永不 git init（铁律：不动用户数据）。
  - `listProjectDirs`：主目录合成行（role 按 workspace 内外判 system/external，isAnchor=无绑定锚点时主目录即锚点）+ 绑定行；`attachedPaths` 供授权消费。
  - `setProjectAnchor`（仅 git 仓库；事务清旧设新）/`resetProjectAnchor`/`peekAnchorPath`（只读）。
  - `detachProjectDir`：只删行不动盘。
- **接线**：`resolveTaskRepoRoot` 业务项目优先外部锚点（锚点在=从锚点仓库切 worktree；standalone 载体逻辑不变）；engine 权限 `scope=project` 的 allowedRoots=[repoRoot, ...attachedPaths]（绑定即写授权，CLI 适配器 --add-dir 消费）；`createProject` 显式 rootDir 且在 workspace 外 → INSERT 后记 external 行（顺序修复 FK；workspace 内含 .system 不记）。
- **API**：`GET /api/projects/:id/dirs`（含 isGitRepo 探测）、`POST /dirs {path,label}`、`DELETE /dirs/:dirId`、`POST /dirs/:dirId/anchor`、`POST /dirs/anchor/reset`。
- **测试** `tests/integration/project-dirs.spec.ts` 7 例：绑定四类拒+交叉（跨项目/本项目主目录）+铁律（无 marker 不 init）/清单角色判定+解绑不动盘+external 幂等/锚点全链路（非 git 拒→设锚→resolveTaskRepoRoot=锚点→worktree 分支真实落锚点仓库→复位回主目录）。
- **验证**：tsc 0 错；vitest 214 文件 1373/1373；e2e 24/24；真实 workspace 零新增。

## 批次4 已交付（2026-08-21）：存储管理 UI 全链路

- **系统文件夹选择器**：`POST /api/system/pick-folder`（darwin osascript `choose folder` 返回 POSIX 绝对路径，取消识别为 cancelled，非 darwin 501 回落手填）——浏览器沙盒拿不到绝对路径，原生窗口由本地服务进程代起。新建项目 openMode 与项目设置绑目录处的「选择…」共用。
- **存储管理页 `/storage`**（导航工具区💾+命令面板入口）：回收站（清单含原名/原位置/大小/搁置天数/被暂停的自动化数；恢复提示重开自动化；彻底删除手打确认——单个=原目录名、批量=「删除N项」；「不再提醒」偏好后单删直入系统废纸篓兜底仍在）+ 磁盘对账只读清单（孤儿/未知分类、未知标"勿自动删"、明确"本页只出清单不代删"）。
- **项目设置**：工作目录卡（主目录合成行+绑定行；角色/git/⚓锚点标记；设锚仅 git；解绑人话"文件夹未做任何改动"；绑定新目录=路径输入+选择器+备注名）；危险区「移入回收站…」（前置校验失败拆人话阻塞清单逐条展示）。
- **e2e** storage-management.spec 4 例：页可达+对账渲染/工作目录管理渲染/回收站全链路（移入→存储页恢复）/彻底删除手打确认（错字禁用→正确放行）。

## 批次5 待做（双模式骨架+简单模式）

批次4：新建项目对话框（三入口+系统文件夹选择器）+存储管理页+回收站 UI（手打确认交互）+项目设置目录管理+删除入口统一+任务/项目分区顺序（模式默认+手动持久化）。
批次5：双模式骨架（settings uiMode/路由白名单/命令面板过滤）+简单模式首页接线（HomePage 复活：快速输入默认建独立任务；项目内 view=task 隐藏 mode/branch/model/thinking 药丸；TaskTopBar 简化）。spec 文档 `docs/superpowers/specs/2026-08-20-simple-pro-mode-design.md`。

## 存量清理（用户手动）

367 个残留目录由用户人工删除（用户明确要求不代删）；辅助：`npx tsx scripts/workspace-audit.mts` 出孤儿/未知清单（unknown 类多为 marker 机制之前的存量泄漏，同样可人工确认后删）。
