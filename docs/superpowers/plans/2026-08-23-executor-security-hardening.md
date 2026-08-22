# H9 实施计划：执行器安全加固（统一执行壳 + AI 审查员 + 四模式）

对应 spec：`docs/superpowers/specs/2026-08-23-executor-security-hardening.md`（七轮收敛终稿，fd97a31）。
worktree：`git worktree add ../muster-h9 -b feat-security-h9` + 软链接 node_modules（不 npm ci）；提交 `--no-verify`。
分三段独立交付（H9a→H9b→H9c），每段四门验证后合 main。

## 侦察结论（2026-08-23）

- **spawn 点盘点**：claude（已 detached+组信号，H8 落地）/codex（spawn app-server）/opencode（Runner execFile 形态）/custom（execFileAsync + **env 全量直通**）/registry run_command（spawn sh，API 型命令）/antigravity、gemini 待接入时侦察。
- **seatbelt 原语已验证**（本机探针过）：profile 用 `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath 真实路径))` ——注意①本机 macOS 不认 `file-read-data*`/`mach-lookup*` 等新操作名，用 `(allow default)` 兜底；②subpath 必须写**真实路径**（/tmp→/private/tmp 符号链接）。
- **模式药丸已有基建**：ComposerMode 现枚举 `'' | 'plan' | 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny'`——四模式=收敛重构而非新建；plan 模式（只读+计划+批准执行 approvePlanTask）已存在。
- **权限域已有**：permission_policy（approvalStrategy/scope/allowedRoots）+ permission_rule + permission_approval 表；claude 权限桥/codex onApproval/run_command permissionGuard 三条接线已通。
- **loopback 已有**：notify_host 工具+loopback 注入（H9c 依托）。

## H9a 统一执行壳（纯工程，先行）

### S1 壳模块 `src/server/executors/spawn-shell.ts`
- `buildSandboxProfile(writableRoots: string[])`：生成 profile 文本——真实路径归一（realpath 双侧，复用 sandbox.ts realpathOrDeepestAncestor）→ `(allow default)(deny file-write*)` + 每 root 一条 allow。profile 落临时文件（runTempDir）。
- `guardedArgv(bin, args, opts)`：`['sandbox-exec', '-f', profilePath, '--', bin, ...args]`——**argv 包装形态**，spawn/execFile 类 Runner 通用（不必换 spawn 实现）。
- `guardedSpawn(opts)`：detached:true（进程组）+ killGroup(-pid) 帮手 + sanitizeChildEnv + guardedArgv——claude 形态的统一版。
- 开关：`MUSTER_SANDBOX=off` 环境逃生门（调试/非 macOS 自动跳过 sandbox-exec，进程组与 env 清洗保留）。
- 白名单组成（按档位）：基础=worktree 真实路径+CLI 配置目录（~/.claude 等，按适配器注册）+系统 tmp 真实路径；宽档=授权目录/用户目录/无限制（profile 生成器参数化）。

### S2 适配器接入
- claude：spawn 换 guardedSpawn（保留 H8 组信号逻辑，killGroup 帮手复用）。
- custom：execFileAsync → guardedArgv 包装 + env 过 sanitizeChildEnv（**堵 env 直通洞**）+ signal 超时保留。
- opencode/antigravity/gemini：Runner 的 argv 过 guardedArgv + env 清洗。
- codex：app-server spawn 过 guardedSpawn（它自带 seatbelt，Muster 壳叠加不冲突——外层管它的越界写）。
- registry run_command（API 型）：spawn('sh',...) 换 guardedSpawn（此处是 Muster 全控命令路径，审查员 H9b 接线点）。

### S3 测试与交付
- 壳单测：profile 生成（真实路径归一/白名单构造/宽档参数化）；guardedArgv 形态；env 清洗（custom 洞回归）。
- **seatbelt 探针单测**（真实跑 sandbox-exec，非 mock）：白名单内写成功+白名单外被拒（探针已手工验证，测试化；MUSTER_SANDBOX=off 或非 darwin 跳过）。
- 进程组原语测试复用（H8 已有）；custom/opencode 急停杀干净（组信号生效）集成测试。
- 四门 → 合并。

## H9b AI 审查员 + 四模式收敛

### S4 审查员岗（system-agents.ts）
- `SECURITY_REVIEWER_ROLE='security-reviewer'` + ensureSecurityReviewerAgentId（ensureOne 模式，visibleIn central）。
- SYSTEM_PROMPT 契约：输入命令+目标路径+任务上下文+档位 → 输出 JSON `{verdict: 'allow'|'deny'|'escalate', reason, impact: {files?: number, irreversible?: boolean, outsideProject?: boolean}}`。

### S5 判定域 `src/server/domain/security-review.ts`
- `evaluateCommand(db, {command, cwd, projectId, taskId, mode})`：
  1. L1 快速通道：黑名单→直接 deny（附理由）；classifyCommand 高危类→escalate。
  2. 档位分流：`变更前确认`/`自动编辑`→命令一律 escalate（自动编辑档审查员只做**风险分析**附在审批卡上，无放行权——用户三次纠正点）；`完全访问`→项目内影响小→allow；超项目目录/外溢/红线→escalate。
  3. 审查员调用：callModel 直连（系统默认模型，超时 10s 失败兜底=escalate）；契约解析失败=escalate。
- 留档：`permission_audit` 表迁移（id/task_id/command/mode/verdict/reason/impact_json/created_at）+ 查询端点。

### S6 接线
- run_command（registry）：permissionGuard 前插 evaluateCommand；escalate→审批卡（现有 permission_approval 流）。
- claude 权限桥 guard / codex onApproval：evaluateCliToolRequest 内接 evaluateCommand（guard 回调升级，异步兼容已有 Promise 形态）。
- 风险说明卡 UI：审批卡升级版——审查员分析文案（影响面/不可逆性）+ 显式「我了解风险，仍然执行」按钮（**禁回车禁默认聚焦**：不设 autoFocus+keydown 拦 Enter+两段式（先点「查看风险」再点确认））。

### S7 四模式收敛
- ComposerMode 枚举收敛：`'confirm-edits'（变更前确认）| 'auto-edit'（自动编辑，默认）| 'plan'（计划模式，已有语义不变）| 'full-access'（完全访问）`；旧值映射（ask-always→confirm-edits、ask-by-rule/no-approval→auto-edit、deny→confirm-edits、plan→plan）——服务端 postUserMessage mode 归一+客户端枚举重写+药丸 UI 文案。
- 存储：system_setting 全局默认档（设置页四选一）+ task.inputProtocol.mode 任务级覆盖（透传链已有）。
- 文件编辑联动：变更前确认档→CLI 权限桥对 Edit/Write 也 escalate（现有 approval 流）；自动编辑及以上→worktree 内自动（现状）。
- 测试：判定域单测（三档分流/契约解析/超时兜底/L1 短路）；接线集成（run_command 各档行为/权限桥升级）；UI（四档药丸渲染/风险卡禁回车）；HTTP（audit 查询）。四门 → 合并。

## H9c 受托越界通道（后置）

### S8
- loopback 端点 `POST /loopback/request_elevated_command` {command, targetDirs, reason} → evaluateCommand → 审批卡 → 批准后受托执行：guardedSpawn 临时 profile（基础+targetDirs 白名单）→ 结果返回 CLI。
- systemPrompt 注入提示：越界写失败时走 loopback 申请（不要反复重试）。
- 集成测试：申请→审批→受托执行（白名单只开 targetDirs）→ 结果回传。
- 四门 → 合并。

## 边界与不做

不限制网络（第一版）；Linux（bubblewrap）/Windows 沙箱后置；不做每家 CLI 专属安全适配；②worktree 外删除分级降级为日志；③claude Bash 审批策略收紧不做（四模式统一管）。spec 全程同步实施记录。

## 验证与合并

每段已提交状态跑四门（tsc -b --force 真实退出码/vitest 全量/smoke/e2e，MUSTER_KEEPAWAKE=off 仅 e2e）→ main 归因检查 → merge → 复验 → 清 worktree → 记忆更新。
