# 公司概念退役技术方案（company retirement）

> 规范文件路径：`docs/superpowers/specs/2026-08-17-company-retirement.md`
> 状态：**已全量实施 A+B+C+D（2026-08-18，分支 feat/company-drop）**。
> 背景锚点：2026-08-16 UI 重构已完成「公司 UI 退场」（CLAUDE.md「UI 重构」章）；本方案完成数据层与 API 层的全链物理退役。

> 【落地注记 A+B+C+D，2026-08-18】实际耦合面实测为 **12 个挂载点 + 6 个散落文件**。批次 D（物理去列）已完成：
> 1. 迁移 A（20260819000000_company_drop_org.sql）：重构 11 张组织/对话/关系表去 company_id。
> 2. 迁移 B（20260819000100_company_drop_assets.sql）：重构 10 张任务/知识资产表去 company_id。
> 3. 迁移 C（20260819000200_company_drop_satellites.sql）：重构 5 张能力卫星表去 company_id，退役 b2b 契约死表与死流。
> 4. 迁移 D（20260819000300_company_rename_workbench.sql）：company 表瘦身并 RENAME 为 workbench 单例表。
> 5. 契约清扫：Shared DTO、Client API、Realtime 事件全链剥除 companyId，company.state 演进为 workbench.state。
>
> 【终审修复轮，2026-08-18】验收终审发现迁移链从未在有数据的库上跑过（空库测试全绿属假阳性），修复后批次 D 才真正落地：
> 1. **runner 外键规程**：runMigrations 逐文件事务外 `foreign_keys=OFF` + 文件内 `foreign_key_check` 违规即回滚（SQLite 官方表重建规程）。原实现 FK=ON 下 `DROP TABLE agent_definition` 被未重建子表外键直接拒绝——任何有数据的库上迁移 A 第一步即炸。
> 2. **迁移 B closeout 形状无关重建**：真实库 task_closeout_summary 是历史漂移旧形状（无 blueprint_id/sections_json 等 6 列），按仓库链形状写的 INSERT SELECT 必炸 `no such column`；改为仅抄两形状共同列（真实库该表 0 行，无损）。
> 3. **迁移 E（20260819000400_company_drop_leftovers.sql）**：plugin 表 CHECK 的 'company' 档→'workbench'（存量 13 行 CASE 映射）；补删漏网列 permission_rule.company_id（D4-3 承诺未兑现）与 task_reflection.company_id（reflection 域在用）。
> 4. **plugin 契约 workbench 化**：PluginScope/PluginSource 'company' 成员改 'workbench'（无 id 载荷），plugins API/marketplace/skill-author/plugin-adapter 全链去 `companyId:''` 空串占位。
> 5. **运行时换域**：engine/context/projects/tasks 的 getCompany import 换 domain/workbench；company.ts 仅存测试夹具壳（103 文件依赖，删除另开微批）。
> 6. **真实库清理与迁移已执行**（脚本 `scripts/company-drop-migrate-real-db.mts` 留档）：备份至 ~/.muster-backups/ → 清理 103 家冒烟垃圾公司（留 co_default_workspace，组织数据完整）→ 迁移 A-E → 断言全过（foreign_key_check 空、workbench 单行）。
> 7. **测试隔离结构修复**：setup-dom.ts 给 MUSTER_HOME 兜底临时目录——此前部分单测裸调 getDb() 直写真实库（104 家垃圾公司的来源），2026-08-18 曾因此在全量测试中把迁移误跑到真实库（WAL 未 checkpoint，主文件回退+隔离 WAL 无损恢复）。
> 验证口径：tsc 0 错误；vitest 全量除 web-tools 3 例（本地沙箱 DNS 环境性失败）全过、2 skipped（多公司隔离语义过时）；迁移演练以「真实库副本 + FK 规程」为准，空库全绿不再作为迁移验收依据。

## 1. 现状与耦合面

- **数据模型**：86 张表中涉及 `company_id` 的全部表均已通过迁移 A/B/C 重建去列；`company` 表已通过迁移 D RENAME 为 `workbench` 单例表。
- **服务端**：`companyId` 核心领域映射已全面退场，相关接口全部收敛为单例工作台。
- **API**：`/api/companies/*` 彻底下线，统一收敛至 `/api/workbench/*` 与扁平资源路径。
- **真实数据**：单例 `workbench` 表，零多公司冗余。

## 2. 核心决策

### D1：公司不并入蓝图，两者正交
蓝图=打法包（任务侧知识资产），公司=租户锚点（数据分组）。公司退役后蓝图转**全局**，不是「蓝图吸收公司」。`blueprint.company_id` 列已物理删除，蓝图匹配/进化不再按公司分区。

### D2：替代物 = 隐式单例工作台（workbench 单例表）
`company` 表瘦身并重命名为 `workbench` 单例表（保留 first_agent_id/review_mode 活列与 shutdown_paused 关机标记）：
- 启动时 `ensureWorkbench()`：无则建（名「默认工作台」）。
- 服务端核心领域统一读写 `workbench` 表。

### D3：API 路径收敛
`/api/companies/:companyId/X` → `/api/X` 与 `/api/workbench/*`。

### D4：三级解析降为两级
凭据/权限/执行器配置的平台>公司>员工三级 → 平台>员工两级；数据迁移靠 SQL 回填。

### D5：多公司入口彻底下线
`/api/companies` CRUD、公司列表/切换 UI、`useDefaultCompanyId()` hook 彻底删除；上下班（online/clockout）生命周期归入「工作台」单例。

## 3. 分批实施

| 批次 | 内容 | 风险 | 状态 |
|------|------|------|------|
| A | `ensureDefaultCompany` 单例 + 12 挂载点/6 散落文件新路径双挂（`companyIdOf` 读侧解析） | 低（纯增量） | ✅ 2026-08-18 |
| B | 前端 hooks/页面切新路径；删 `useDefaultCompanyId` 与公司感知残留 | 中（改动面广，tsc 兜底） | ✅ 2026-08-18 |
| C | 删旧路径挂载；companies CRUD 下线；smoke/e2e 断言更新 + smoke/e2e 隔离 | 中 | ✅ 2026-08-18 |
| D4 | 三级解析降两级（见 spec §2 D4） | 中 | ✅ 2026-08-18（D4-1 凭据 / D4-2 执行器档位 / D4-3 权限，数据迁移靠 SQL 回填） |
| D | 物理去列：迁移 A/B/C/D 剥离 `company_id`，company 表瘦身 RENAME 为 workbench 单例表 | 高（全库重写，列级对账） | ✅ 2026-08-18（feat/company-drop） |

每批完成跑全量验证（单测/e2e/smoke），批次间可独立发布。

## 4. 数据与测试治理

- ✅ 2026-08-17 已清理：209 个测试垃圾公司级联删除（备份 `~/.muster-backups/muster-before-company-cleanup-20260817193147.db`），真实库仅存星河软件（启动改名「默认工作台」于批次 A 落地）。
- ✅ 防再污染（批次 C 落地）：
  - smoke：`run-all.mjs` 无 `MUSTER_API` 时自起隔离服务器（`MUSTER_HOME` 临时目录 + 随机端口），跑完 kill + 清目录；并屏蔽模块级 `process.exit` 连坐。
  - e2e：`playwright.config` 固定 `MUSTER_HOME=/tmp/muster-e2e-run` + `global-setup` 每次清理；探针打到 `/api/workbench`（触发完整冷启动）；零项目态用例前移至 `00-bootstrap.spec.ts` 按序最先执行。
