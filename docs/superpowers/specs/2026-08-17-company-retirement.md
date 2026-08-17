# 公司概念退役技术方案（company retirement）

> 规范文件路径：`docs/superpowers/specs/2026-08-17-company-retirement.md`
> 状态：草案（2026-08-17 用户定案「companies 就不应该存在」，待确认后分批实施）
> 背景锚点：2026-08-16 UI 重构已完成「公司 UI 退场」（CLAUDE.md「UI 重构」章）；本方案处理数据层与 API 层的最终退役。

## 1. 现状与耦合面

- **数据模型**：86 张表中 54 个迁移文件涉及 `company_id`；`company` 表本体在 `0001_init.sql`。
- **服务端**：`companyId` 出现 786 处——`matchBlueprint`/`findBestAssignee`/凭据三级解析（平台>公司>员工）/权限档/执行器档案/蓝图进化记账全按公司分组。
- **API**：9 组路由挂 `/api/companies/:companyId/*`（blueprints、expert-candidates、credentials、events 等）；前端一律用 `useDefaultCompanyId()`（取第一个未归档公司）拼 URL——公司早已不是用户概念，纯锚点。
- **真实数据**：2026-08-17 清理后仅 1 个真实公司（星河软件）。

## 2. 核心决策（待确认）

### D1：公司不并入蓝图，两者正交
蓝图=打法包（任务侧知识资产），公司=租户锚点（数据分组）。公司退役后蓝图转**全局**，不是「蓝图吸收公司」。`blueprint.company_id` 语义变为恒定默认值，蓝图匹配/进化不再按公司分区。

### D2：替代物 = 隐式单例工作台（语义坍缩，不动表结构）
保留 `company` 表与各表 `company_id` 列**不动**，但语义坍缩为「永远恰好一个默认工作台」：
- 启动时 `ensureDefaultCompany()`：无则建（名「默认工作台」），多于 1 个归并进默认（迁移工具一次性处理）。
- 所有服务端函数签名中的 `companyId` 参数改为内部解析默认值，**逐批删除参数**而非一次全改（786 处引用一次拆完风险不可控）。
- 理由：零迁移风险拿到 95% 收益（用户/API/前端彻底不再感知公司）；物理去列（DROP COLUMN + 全表迁移）留远期可选批次。

### D3：API 路径收敛
`/api/companies/:companyId/X` → `/api/X`（blueprints、expert-candidates、credentials、events、messages、blueprint-optimization 等 9 组）。实施期新旧路径双挂（别名），前端全切后再删旧路径。

### D4：三级解析降为两级
凭据/权限/执行器配置的平台>公司>员工三级 → 平台>员工两级；公司级覆盖一次性迁移到平台级（如有数据）后废弃该层。

### D5：多公司入口彻底下线
`/api/companies` CRUD、公司列表/切换 UI（已无）、`useDefaultCompanyId()` hook 删除；`company_employees`/上下班（online/clockout）语义并入「工作台」单例。

## 3. 分批实施

| 批次 | 内容 | 风险 |
|------|------|------|
| A | `ensureDefaultCompany` 单例 + 9 组路由双挂（新路径内部解析默认公司） | 低（纯增量） |
| B | 前端 hooks/页面切新路径；删 `useDefaultCompanyId` 调用点 | 中（改动面广，tsc 兜底） |
| C | 删旧路径挂载；companies CRUD 下线；smoke/e2e 断言更新 | 中 |
| D（远期可选） | 物理去列：迁移剥 `company_id`、DROP company 表 | 高（全库重写，收益仅洁癖） |

每批完成跑全量验证（单测/e2e/smoke），批次间可独立发布。

## 4. 数据与测试治理

- ✅ 2026-08-17 已清理：209 个测试垃圾公司级联删除（备份 `~/.muster-backups/muster-before-company-cleanup-20260817193147.db`），真实库仅存星河软件（更名「默认工作台」随批次 A）。
- 防再污染：smoke（run-all.mjs 打真实 dev）夹具改用独立 `MUSTER_HOME` 或用后清理；integration 夹具核查一遍隔离性。
