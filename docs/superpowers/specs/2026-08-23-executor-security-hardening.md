# 执行器安全加固：统一执行壳 + AI 安全审查员

状态：proposed（2026-08-23 与用户对齐方向；用户核心输入=AI 审查员按策略判定「什么是安全」/越界合法操作需授权通道/用户可选权限档位但 OS 围栏为不可关底座）
来源：H8 停止语义收口后用户问询「命令审核现状/沙盒靠谱吗/rm 防得住吗」+ 三轮收敛（安全盘点 → ①②③候选评估 → 审查员+接管+越界机制）。

## 背景与现状缺口（2026-08-23 盘点）

- 文件工具（write_file/edit_file）有硬围栏（isWithinWorkspace+realpath 双侧解析防符号链接逃逸）。
- bash/命令路径只有软防线：黑名单 60+ 正则（可绕）+ 高危 8 类人工审批（git-push/system-install/credential-access/deploy/delete-outside-project/external-message/account-action/paid-action）。
- CLI 逐命令接管能力各家不一：claude 权限桥（PreToolUse，已上线）/codex onApproval（已上线）/opencode 仅配置层 deny/自定义 CLI **零防线**（env 全量直通、无黑名单无围栏无进程组）。
- OS 级沙箱仅 codex 自带（macOS seatbelt）；rm 绝对路径删 worktree 外文件**默认放行**（不匹配黑名单、非高危类）。
- H8 已落：进程组隔离（detached+组信号）——仅 claude 适配器。

## 用户定稿方向

1. **防线位置上移**：不信任每家 CLI 的自觉（没法逐家完善、逐家测试），信任操作系统——Muster 是所有 CLI 的宿主，在 spawn 处统一设防，现在/未来/自定义 CLI 一视同仁。
2. **AI 审查员**：用户可选开全部权限（免打扰），但越界命令由审查员按策略判定是否安全——策略定义「什么是安全」：不能对大量文件造成损失/删除/格式化等；可制定策略。拿不准升级用户。
3. **越界合法操作**（装全局依赖/改外部目录）：不是一刀切死——逐命令授权、逐命令放行（受托通道），CLI 进程本身始终窄围栏。
4. **先审再执行**：有 hook 的 CLI 走 hook（claude/codex 已有）；无 hook 的靠 OS 围栏兜底。

## 分层架构（自下而上）

```
L0 OS 硬围栏（底座，不可关）：seatbelt 文件写围栏——所有适配器统一执行壳
L1 廉价过滤（现有保留）：黑名单正则 + 高危 8 类
L2 AI 安全审查员（新）：越界/高危命令语义判定，按策略三态输出
L3 人工审批（升级兜底）：审查员拿不准/超策略/用户选全审时
```

### L0 统一执行壳（工程层，H9a）

所有适配器（claude/codex/opencode/custom/未来）统一过同一个 spawn 壳，四件套：
1. **进程组隔离**：detached+组信号 kill(-pgid)（H8 已在 claude 落地，推广全部适配器——custom/opencode 现在没有，急停对它们杀不干净）。
2. **环境变量清洗**：sanitizeChildEnv 推广（custom 现在宿主 env 全量直通，凭据暴露）。
3. **seatbelt 文件写围栏**（macOS sandbox-exec，codex 同款先例）：
   - 默认 profile：worktree + CLI 自身配置目录（~/.claude 等，按适配器注册）+ /tmp 可写，**其余全系统拒绝写入**（读不限制——读敏感由 L2 凭据类审查管）。
   - 网络/进程不限制（第一版；限网会破 API 型 CLI 自身的模型调用）。
   - Linux 等价物（bubblewrap）与 Windows 后置——桌面版 macOS 先行。
4. **统一超时/中止**（stopSignal 语义推广）。

测试：壳层探针单测（包 seatbelt 起 sleep/写文件探针 → 断言 worktree 外写被 OS 拒绝）——**不依赖任何真实 CLI**，回应「没法真实测试」。

### L2 AI 安全审查员（产品层，H9b）

- **新隐形中央岗**「安全审查员」（security-reviewer）：权限桥/onApproval/run_command 的 guard 从「规则引擎」升级为「规则引擎（L1 快速通道）→ 未命中→ 审查员语义判定」。
- **判定输入**：命令文本 + 目标路径解析（worktree 内外）+ 任务上下文（正在干什么）。
- **策略**（可配置，默认版）：
  - 拒绝：大量文件影响的删除/改写（递归、通配大范围）、格式化类（mkfs/dd/format）、系统区域（/System、/Users 根层级、/etc）、凭据访问、不可逆且无 git 兜底。
  - 放行：worktree 内任意操作（含删除）、小范围明确目标、可逆（git 管理）、已授权目录。
  - 升级用户：拿不准、影响面大但目的不明、策略未覆盖。
- **留档**：permission_audit（命令/判定/依据/审查会话）——复盘可追责。
- **权限档位**（用户可选，设置+任务级可覆盖）：`ai-review`（默认：L1→L2→升级）/ `ask-all`（全问用户）/ `permissive`（放宽围栏，见下）。**修订（用户问询后）**：原「L0 任何档位不可关」与「permissive=开全部权限」自相矛盾——若围栏不可关，permissive 退化为「不问+越界全失败」名不副实。定稿：**L0 profile 分级、默认最窄**——worktree 窄（默认）/ 授权目录 / 用户目录宽 / 无限制，档位=选 profile 的快捷方式；permissive=宽 profile+设置项醒目警告（拿流畅换风险，用户是机主有最终裁量权，产品责任是把代价说明白而非替用户锁死）。
- **无 hook 的 CLI**（custom 等）：L2 只能审 loopback 申请（见 L-越界）与 run_command（API 型）；纯 CLI 内部命令无 hook 就看不到——L0 兜底。
- **三档位对照**（用户问「ai-review 和 permissive 都不被打扰，区别在哪」后定稿）：
  | | ask-all | ai-review（默认） | permissive |
  |---|---|---|---|
  | 越界命令 | 问你，批了受托执行 | 审查员按策略放行→受托执行；拿不准升级问你 | 围栏放宽（宽 profile）直接执行，不用申请不用审 |
  | 打扰 | 每条都问 | 偶尔问 | 永不问 |
  | 追溯 | 批准记录 | 审查留档（命令/依据） | 仅执行日志 |
  | 适用 | 敏感项目 | 日常默认 | 明确信任的员工/任务，拿流畅换风险 |

### 越界受托通道（H9c，后置分期）

- loopback 新端点 `request_elevated_command`：CLI 在围栏内写外部目录失败 → agent 经 loopback 申请越界（命令+目标目录+理由）。
- 判定走 L2/L3；批准后由 **Muster 受托执行**（spawn 带临时扩展 seatbelt profile——只开批准目录），结果回 CLI——CLI 进程本身始终窄围栏，逐命令授权≠全开后门。
- 第一版降级：越界被拒+提示用户手动处理（不做受托执行），H9c 再补闭环。

## 分期

- **H9a 统一执行壳**（纯工程）：四件套+探针单测+custom/opencode 补洞（env 清洗/进程组）。先行。
- **H9b AI 审查员**：岗+策略+三态判定+权限桥/run_command 接线+留档+档位设置。
- **H9c 受托越界通道**：loopback 申请+临时 profile 受托执行。
- 顺带小修（随 H9a）：custom-cli env 直通、②worktree 外删除分级降级为日志提醒（不做拦截）、③claude Bash 审批收紧不做。

## 边界与不做

- 不做每家 CLI 的专属安全适配（正解是壳统一设防）；不限制网络（第一版）；Linux/Windows 沙箱后置；CLI 内部防线（各家 hook 质量）不审计不依赖。
