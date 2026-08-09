# 临时工招募 + 员工去留交接 + 权限委托 + 员工评级设计

**日期**：2026-08-10（v2，纠正关键误解 + 补充权限/评级）
**状态**：设计文档（待实现）
**前置**：B2B 外包（`20260810100000`）已完成；本文档是其后续。

## 一、关键澄清：资料归属（必须先理清）

### 三种东西，三种归属，三个存储位置

| 东西 | 存哪里 | 归谁 | 离职影响 |
|------|--------|------|---------|
| **产物（artifact）**——文章、代码、设计文件等公司产出 | **公司项目目录** `{workspace}/companies/{公司}/projects/{项目}/` | **公司/项目** | 无影响，留在公司 |
| **素材（material）**——原始原料、需求文档 | **公司项目目录** `{project}/materials/` | **项目** | 无影响 |
| **记忆（memory）**——员工的经验、教训、对项目的理解 | **员工个人 Home** `~/.muster/agents/{profileId}/` | **个人（profile）** | 员工带走，但公司/项目分区可归档 |

**核心原则**：公司资料（产物+素材）在公司内部，不在个人手里。开除员工，公司资料完全不受影响。员工个人 Home 里只有"经验"（记忆），那是员工自己的本事。

**owner 指针的本质**：产物的 `owner_agent_id` 是数据库指针（"当前谁负责维护"），不是文件位置。员工走了，文件不动，只改指针。

### 现有权限系统（已实现，框架够用）

系统已有完善的权限模型（`permission.ts`）：
- `scope`（范围）：task/project/workspace/selected-directories —— 控制能碰哪些目录
- `approvalStrategy`（审批策略）：no-assignment/ask-by-rule/deny
- `permission_rule`（细粒度规则）：按 pathPrefix/fileExtension/action/commandPattern 放行或拦截
- `HIGH_RISK_ACTIONS`：删除/系统安装/凭据/git push 等**自动要审批**

**缺口**（本轮补齐）：
1. 审批由"上级员工"决定，而非用户本人逐个批（权限委托链）
2. 权限变更记录留在对应资料里（审计）
3. 按角色派生权限策略模板（经理/员工/临时工三档）
4. 写入审计日志（扩展现有 `publish_record`）

## 二、临时工模型

### 数据模型

`company_employee` 表加列（迁移 `20260811000000_temp_worker.sql`）：

```sql
ALTER TABLE company_employee ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'permanent'
  CHECK (employment_type IN ('permanent', 'temp'));
ALTER TABLE company_employee ADD COLUMN temp_status TEXT
  CHECK (temp_status IS NULL OR (employment_type='temp' AND temp_status IN ('active','greyed','dismissed')));
ALTER TABLE company_employee ADD COLUMN contracted_at TEXT;
ALTER TABLE company_employee ADD COLUMN source_contract_id TEXT REFERENCES outsourcing_contract(id);
```

`agent_profile` 表加列：

```sql
ALTER TABLE agent_profile ADD COLUMN is_temp_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_profile ADD COLUMN rating INTEGER NOT NULL DEFAULT 1 CHECK (rating BETWEEN 1 AND 5);
```

**状态语义**：

| employment_type | temp_status | 含义 |
|----------------|-------------|------|
| permanent | NULL | 正式员工 |
| temp | active | 临时工，工作中 |
| temp | greyed | 临时工，工作完成，灰色保留待人工决定 |
| temp | dismissed | 临时工，未转正被开除（过渡态） |

### 招聘触发器（决策树 recruit 路径落地）

**选拔优先级链**（用户明确要求，`selectTempForNeed` 实现）：
```
① 公司内部选人（hasInternalCapability → 决策树返回 internal 路径，外层处理）
② 复用 greyed 临时工（findGreyedTempForReuse + reactivateGreyedTemp，高星级优先）
③ 人才库选人（is_temp_only=0 的现成 profile，具备所需能力）
④ 创建新临时工（is_temp_only=1）
```
可跳过：无 greyed 临时工直接跳到 ③；无人才库匹配直接到 ④。

**临时工小范围关系**：临时工的工作关系仅限发起需求的员工（`contactAllow=[requesterAgentId]`），对其他人隐形——临时工的存在不影响公司其他人正常工作。其他人完成手头工作后才软通知新员工加入（后续优化）。

**招聘豁免**：temp 招聘允许公司 online 态进行（`assertUnlocked` 对 temp 招聘放行）——**临时工招聘绝不导致公司离线**。正式员工增删才需下班。

### 临时工完成工作 → greyed

外包承接任务完成后（`onOutsourcedTaskCompleted`）：
- temp + active → 自动置 greyed
- greyed 员工不进派工候选（`claimNextTask` 排除 temp_status!='active'），但保留在公司员工列表（灰色标记 + 转正/开除按钮）

### 转正（`convertTempToPermanent`）

```
1. UPDATE company_employee SET employment_type='permanent', temp_status=NULL
2. 若 is_temp_only=1 → 置 0（正式进入人才市场）
3. 发 employee.converted 事件
```

### 开除（区分两种）

```
dismissTempWorker(companyId, employeeId):
  1. 触发离职交接（按人整体交接，见第四节）
  2. 交接完成后：
     - is_temp_only=1（新建临时工未转正）：
       deleteAgent + DELETE agent_profile + rmSync Agent Home（唯一删 Home 场景）
     - is_temp_only=0（人才市场来的）：
       deleteAgent + 清理该公司记忆分区（companies/{companyId}/）；profile + Home 保留
```

## 三、权限委托链 + 变更审计

### 设计：组织架构驱动的审批链

复用现有 `relationship` 表（org 边：负责人→员工）。**不新建审批关系**。

```
员工操作超出权限时：
  1. 系统查该员工的直接负责人（relationship 表 org 边的 source）
  2. 向负责人发审批请求（permission_approval）
  3. 负责人决定：allow / deny
  4. 若负责人也不在线/无响应 → 上溯到公司第一负责人 → 最终用户
```

**权限变更申请**（下级申请、上级审批）：

```sql
CREATE TABLE permission_change_request (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  requester_employee_id TEXT NOT NULL,      -- 申请人
  target_path_prefix TEXT,                   -- 针对哪个目录/资料
  requested_scope TEXT,                      -- temp/project/permanent
  requested_action TEXT,                     -- read/write/delete
  reason TEXT,                               -- 申请原因
  approver_employee_id TEXT,                 -- 审批人（直接负责人）
  state TEXT NOT NULL DEFAULT 'pending'      -- pending/approved/rejected
    CHECK (state IN ('pending','approved','rejected')),
  valid_until TEXT,                          -- temp/project 期的到期时间
  created_at TEXT, updated_at TEXT
);
```

**变更记录留资料内**：产物的 `props_json` 加 `permission_history` 数组，记录每次权限变更（谁申请、谁批、何时、temp/project/permanent）。用户可在资料详情页查看变更记录。

**用户委托**：用户可让直接负责人调整下属权限（撤销/增加，可选 temp/project/permanent），走同一审批流。

### 按角色派生权限模板

预设三档（`permission_policy` 种子数据）：
- **经理**：scope=project, approvalStrategy=no-approval（项目内自由，高危动作除外）
- **员工**：scope=task, approvalStrategy=ask-by-rule（任务内自由，越界要上级批）
- **临时工**：scope=task, approvalStrategy=deny（默认拒绝，全部要上级批）+ 限定 deliverable_dir

公司创建员工时按角色自动绑定对应模板。

### 写入审计日志

扩展现有 `publish_record`（已记 task/thread/commit），新增 `artifact_change_log`：

```sql
CREATE TABLE artifact_change_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  agent_id TEXT,                  -- 操作人
  action TEXT NOT NULL,           -- create/update/delete
  task_id TEXT,                   -- 来源任务
  detail TEXT,                    -- 变更摘要
  created_at TEXT NOT NULL
);
```

`upsertPublishedArtifact` 时写入日志。用户可在资料详情页查看"谁在什么时候改了什么"。

## 四、离职交接工作流（按人整体交接）

### 交接范围（用户已明确）

**按人交接，不是按项目**。一份交接记录覆盖该员工在公司的**全部工作**（跨所有项目）：
- 工作履历（参与过哪些项目、角色）
- 经验教训（各项目遇到的问题、怎么解决）—— 从记忆导出
- 当前进行中的工作 + 待办
- 注意事项
- 产物清单（按项目分组展示，便于理解归属，但工作目录不单独调整）

**原则**：前员工应在日常工作中整理好工作目录（系统应通过权限+审计约束这一点），离职交接是"整体移交"，不是"整理残局"。

### 交接记录

```sql
CREATE TABLE handover_record (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  departing_employee_id TEXT NOT NULL,
  departing_profile_id TEXT NOT NULL,
  receiver_employee_id TEXT,
  state TEXT NOT NULL DEFAULT 'drafting'
    CHECK (state IN ('drafting','awaiting','receiving','completed','cancelled')),
  handover_note TEXT,                         -- 交接记录（工作履历+经验+进行中工作+注意事项）
  work_history_json TEXT NOT NULL DEFAULT '[]',  -- [{projectId, role, period, summary}]
  lessons_json TEXT NOT NULL DEFAULT '[]',       -- 经验教训（从记忆导出）
  pending_work_json TEXT NOT NULL DEFAULT '[]',  -- 进行中的工作 + 待办
  artifact_inventory_json TEXT NOT NULL DEFAULT '[]', -- 产物清单（按项目分组）
  receiver_acknowledgement TEXT,
  created_at TEXT, completed_at TEXT, updated_at TEXT
);
```

### 交接四阶段

```
drafting（系统 + 离职员工整理）
  系统自动汇总：工作履历（参与项目）、产物清单（按项目分组）、经验教训（从记忆导出）
  离职员工补充：交接记录、进行中工作、待办、注意事项
awaiting（用户选接手人）
  用户从公司员工列表选接手人（或"暂存待招"）
receiving（接手人接收）
  接手人查看交接清单，逐项确认
  系统把产物 owner 指针从离职员工改为接手人（单一指针，不叠加）
  接手人在 Agent Home 生成交接索引（HANDOVER.md）
completed（交接完成）
  离职生效，产物留项目原路径（owner 已转交），交接记录归档
```

### 解决连环交接（归属爆炸）

**产物 current_owner 始终唯一**：`owner_agent_id` 单一指针，每次交接只更新这一个值（A→B→C，最终 owner=C，不是 A+B+C）。`handover_record` 形成 `previous_handover_id` 链表可追溯历史，但归属不叠加。

### 解决检索遗漏

产物检索是项目级（`listArtifacts WHERE project_id=?`，不看 owner），交接后产物留在项目里 → 检索不遗漏。接手人通过 HANDOVER.md 索引知道交接来的产物，主动纳入工作视野。

## 五、员工评级（五颗星）

### 设计

`agent_profile.rating`（1-5 星），反映员工经验丰富度。Agent Home 存经验，经验越多星级越高。

### 评级计算（多维度自动，可用户手动调整）

```
calculateRating(profileId):
  任务完成数（task WHERE assignee=该 profile 的任职 AND state=completed）
  + 记忆条数（memory_entry WHERE profile_id）
  + 任职时长（company_employee 跨所有任职的累计天数）
  + 交接被采纳次数（handover_record WHERE departing_profile_id AND completed）
  + 外包交付验收通过次数（outsourcing_contract WHERE vendor AND state=completed）
  → 按阈值映射到 1-5 星
```

用户可手动调整（`adjustRating`）—— 体现用户认可度。

### 评级作用（可调整，建议三项）

1. **人才市场推荐**：外包决策树 `findVendorCompany` 优先选高星级公司的员工
2. **派工优先级**：重要任务（priority 高）优先匹配高星级员工
3. **权限范围**：高星级自动获得更大写入权 / 更少审批（如 4 星以上 ask-by-rule → no-approval）

### 评级展示

- 员工库 / 人才市场显示星级
- Agent Home 的 `profile/` 下生成 `RATING.md`（星级 + 计算依据 + 历史调整记录）

## 六、目录与资料管理策略（总结）

```
公司资料（产物+素材）→ 公司项目目录 → 归公司 → 离职不影响
员工经验（记忆）→ Agent Home → 归个人 → 离职带走，公司分区归档
权限 → permission_policy + rule → 按角色模板 + 委托链 → 超权找上级批
审计 → artifact_change_log + permission_change_request → 留资料内可查
交接 → 按人整体交接 → owner 指针转移（单一，不叠加）→ 产物不动
```

### 离职清理矩阵

| 场景 | Agent Home | profile | 产物 owner | 记忆分区 |
|------|-----------|---------|-----------|---------|
| 正式员工离职 | 保留 | 保留（永恒） | 转交接手人 | 归档 archive/ |
| 临时工（人才市场来）开除 | 保留 | 保留 | 转交或 NULL | 清理该公司分区 |
| 临时工（新建）未转正开除 | **删除** | **删除** | 转交或 NULL | 随 Home 删 |

## 七、实施路线图（全部已实现）

### 批次 A：临时工模型 + 招聘触发器 + 评级基础 ✅ 已实现
- 迁移：company_employee 加 employment_type/temp_status 等；agent_profile 加 is_temp_only/rating（`20260811000000`）
- 招聘触发器（决策树 recruit 落地，`selectTempForNeed` 选拔优先级链）
- convertTempToPermanent / dismissTempWorker / markTempGreyed / reactivateGreyedTemp
- claimNextTask 排除非 active temp
- rating 计算 + 任务完成时异步 applyRating
- API + 前端 hooks

### 批次 B：权限委托链 + 审计 ✅ 已实现
- permission_change_request 表 + 审批流（复用 org 架构，`findDirectManager` 上溯）（`20260812000000`）
- artifact_change_log 表 + 写入日志（扩展 upsertPublishedArtifact）
- 按角色权限模板（经理/员工/临时工三档种子，`ensureRolePermissionTemplates`）
- transferArtifactOwnership / transferAllArtifactsOfOwner（owner 指针转移）
- API：permission-changes / audit-log / permission-templates/seed

### 批次 C：离职交接 + 清理 ✅ 已实现
- handover_record 表 + 四阶段工作流（`20260812010000`）
- transferArtifactOwnership（owner 指针转移，单一不叠加）
- offboardEmployee（正式员工离职，带交接）+ Agent Home 记忆分区归档 archive/
- completeHandover 处理 first_agent 转移（防 FK 冲突）
- API：handover CRUD + assign/receive/transfer/complete
- offboardEmployee / Agent Home 归档与删除
- 前端交接向导

## 八、与现有架构衔接

- **B2B 外包**：临时工是 recruit 路径落地；temp 的 source_contract_id 关联契约；星级影响外包推荐
- **opt-out 插件治理**：temp 任职自动继承公司 effective 插件
- **三层员工模型**：employment_type 在 company_employee（任职层）；rating/is_temp_only 在 agent_profile（人才层）
- **Agent Home**：复用 profile 级 Home，仅加 archive/ 归档约定
- **现有权限系统**：permission_policy/rule 框架不变，加委托链 + 模板 + 审计

## 八.5、与 CLI 执行器的兼容性（关键澄清）

### 核心结论：本设计与 CLI 执行器完全兼容

Muster 是 CLI 的"老板"，CLI 只是受控的执行层。Muster 通过四个机制彻底控制 CLI，使其不持有任何公司资料：

| 控制点 | 机制 | 代码位置 |
|--------|------|---------|
| **工作目录** | Muster 每次指定 cwd = 任务级 worktree（非公司/项目级常驻） | engine.ts:250,253；manager.ts:60 |
| **Skill** | Muster 把 skill 内容注入系统提示词（`--system-prompt`），不用 CLI 自己的 skill 发现 | context.ts:93-101；claude-code-adapter.ts:223 |
| **权限** | Muster 接管 CLI 权限（`--settings` + PreToolUse Hook），CLI 原生交互提示禁用 | claude-permission-bridge.ts；claude-code-adapter.ts:234-241 |
| **记忆** | Muster 的经验记忆在 Agent Home；CLI 的对话上下文按 worktree 路径分区 | agent-home.ts；project-task-thread.ts |

### 工作目录是"任务级临时隔离"，不是公司/项目级常驻

每个任务在 `~/.muster/worktrees/<taskId>/` 创建临时 git 工作区 → CLI 在此干活 → 完成后产物三方合并回项目正式目录 → 工作区删除（或中断时保留）。真正的公司资料在项目目录（公司内部），worktree 只是临时台面。

### 中断/恢复的连续性保障（已实现，四层）

| 层 | 机制 | 存哪 |
|----|------|------|
| 工作进度 | `preserveWorktree` + `commitAll`（git 存档） | `~/.muster/worktrees/<taskId>/` |
| 对话上下文 | `vendorSessionId` 持久化 + `--resume`（Claude）/`thread/resume`（Codex） | `project_task_thread.vendor_session_id` + CLI 全局 |
| 经验记忆 | Agent Home memory 分区 | `~/.muster/agents/{profileId}/` |
| 能力/skill | 每次任务按需注入系统提示词 | Muster 服务端 `skills/` |

### 交接/权限变更对 CLI 无感

CLI 不持有公司资料（资料在项目目录），交接只改 Muster 数据库指针（owner_agent_id、permission_policy_id）。下次任务 spawn 时，CLI 自动用新 cwd + 新 skill + 新权限策略。**换人/改权限即时生效，无需动 CLI**。

### CLI 全局能力共享 = 正向设计（不隔离）

CLI 的原生全局配置目录（`~/.claude/`、`~/.codex/`）是**全主机共享**的——所有员工共用同一 Claude 登录、全局 MCP、全局 skill 增强。

**这是特性而非缺陷**：一个员工或 CLI 自身增强了能力（安装新 skill、配置新 MCP），**全员被动受益**。这正是我们使用 CLI 的原因——它们甚至可以自己增强自己的能力，只要不影响公司目录，装 skill 越多越好。

- ✅ 不影响公司资料安全（资料在项目目录，CLI 配置不含公司资料）
- ✅ 不影响工作隔离（每任务 worktree 独立，对话按 worktree 路径分区）
- ✅ 能力共享 = 全员增强（CLI 增强 = 所有员工增强）
- ✅ 用户可自行装 skill（不隔离，装了大家都受益）

**不做隔离**：不设 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 按员工隔离。全局能力池是正向设计。

## 九、风险与未决问题

1. **临时工默认 executor/permission**：公司没配默认时用系统默认 + 提示（建议）
2. **评级计算权重**：任务数 vs 记忆数 vs 任职时长 vs 交接采纳的权重待定（建议初版均分，迭代调整）
3. **评级影响权限的安全边界**：高星自动放宽权限可能误授权（建议：评级仅影响审批策略档位，不绕过高危动作审批）
4. **权限委托链的循环风险**：A 的负责人是 B，B 的负责人是 A（组织架构环）。建议：禁止组织架构成环（addRelationship 校验）
5. **Agent Home 删除不可逆**：临时工未转正开除删 Home 前，归档交接记录到公司目录 + 二次确认
6. **CLI 原生全局配置隔离**：批次 B 通过 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 环境变量实现按员工隔离（见八.5）
