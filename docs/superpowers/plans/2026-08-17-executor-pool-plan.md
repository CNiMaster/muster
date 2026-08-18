# 实施计划：执行器池统一（档位=档案 · 能力自动选脑）

> 规范文件路径：`docs/superpowers/plans/2026-08-17-executor-pool-plan.md`
> 状态：已批准（2026-08-17），在 worktree `feat/staging-executor-pool` 分批实施
> 上游 spec：`docs/superpowers/specs/2026-08-17-executor-pool-unification.md`

## 关键事实（探查记录）

- 两套档位并存：执行器三级键（primary/secondary/tertiary → 档案 id；公司级三列**无人写**是死配置）与模型档位键（modelTierEconomy/Premium → 模型名字符串，WP9）。
- SettingsPage models tab 只暴露 tierPrimary 一个下拉（secondary/tertiary 无 UI）。
- manifest **无能力声明字段**；能力标签现状=profile.config.capabilities（用户勾选，候选硬编码仅 `['vision']`，ExecutorCenterPage.tsx:410）+ 探针 capability_json（真实能力矩阵，按 profile+model 缓存 24h）。
- **员工绑定执行器 UI 断链**：useBindEmployeeExecutor 全客户端零调用方；后端 bindEmployeeExecutorProfile 存在（要求工作台下班态）。
- **profile.credentialRef 运行时零消费**（悬空字段）；探针只拿平台默认 key（connection-probe.ts:44）——档案各自配 key 时探针失真。
- providerForManifest 双实现行为不一致（engine.ts:1800 vs executor-discovery.ts:17）。
- 引擎选择链：员工绑定(健康)→三级默认(健康过滤)→legacy；模型链=消息显式>人才定制>档位模型>档案 model（engine.ts:396-435）。

## 批次

### B1 档位=档案选择器（两套合一）
- 新设置键 `executorTierHighId/StandardId/LowId`（档案 id）；旧键迁移兼容（primary→high、secondary→standard、tertiary→low）；modelTierEconomy/Premium 读取兼容一个版本后退役。
- model-tier.ts：`resolveModelForTier`→`resolveProfileForTier`；任务分类器合并（吸收 executor-tier.tierForTask 的 REQUIRES_CLI_SKILLS→「需 cli kind」过滤条件、discussion/consult→low；蜂群/辩手→low，计划/验收/裁决/请示/返工→high，普通→standard）。
- engine.ts:396-435 重构：选择=绑定档案(健康)→档位档案→legacy；模型链简化=消息显式>人才定制>档案 config.model；WP9 composer 三档快捷项退役。
- SettingsPage models tab：三个档案下拉替换「模型分级」卡（顺带修 secondary/tertiary 无 UI 缺陷）。
- 单测：档位解析/降级/旧键迁移/引擎组装。

### B2 能力标签体系
- 词表：vision / image-gen / video-gen / voice / long-context / code；manifest 增 `defaultCapabilities`（claude-code/codex/antigravity→[code]、gemini-api→[vision,long-context]、openai-compatible→[]）。
- 创建/编辑档案自动预填 manifest 默认 + model 名启发式建议（gpt-4o/gemini/claude-3.5+→vision）；ExecutorCenter 勾选扩为全词表 chips。
- engine 能力过滤：任务带 userImages→要求 capabilities 含 vision（或 cli kind）；REQUIRES_CLI_SKILLS→要求 cli kind；不满足沿降级链 + capability-warning 事件。
- 单测：过滤/降级/启发式预填。

### B3 展示排列 + 绑定入口修复
- ExecutorCenter 档案列表按档位分组（高/标准/低/未分配）→组内 健康度>能力数>名称；能力 chips 兼筛选器。
- AgentProfilePage 任职区加「固定执行器」下拉（复活 useBindEmployeeExecutor；下班态约束 UI 提示）。
- 组件单测。

### B4 凭据接入与清理
- profile.credentialRef 接入解析链（员工>档案>工作台>平台）；能力/联通探针改用档案 credentialRef。
- providerForManifest 双实现去重统一。
- 清理：modelTier 两键、旧三级键兼容代码；公司级三列死配置只加注释指向退役 spec（不动表——公司改造在别处）。

### B5 全量验证 + 文档
tsc/vitest/e2e/smoke 全绿；CLAUDE.md 更新执行器池章节；spec 状态行改「已实施」。

## 验收标准
- 设置页一个选择框选 CLI/API；打标=manifest 默认+启发式+手动 chips 纠偏；列表有排列；员工可绑执行器；凭据按档案生效。
