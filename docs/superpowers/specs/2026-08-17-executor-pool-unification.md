# 执行器池统一技术方案（档位=档案 · 能力自动选脑）

> 规范文件路径：`docs/superpowers/specs/2026-08-17-executor-pool-unification.md`
> 状态：方案草案（2026-08-17 用户批准方向：一个选择框选 CLI/API；打标要省事；展示要有排列）
> 背景痛点：现状**两套档位系统并存**——执行器三级（primary/secondary/tertiary → 档案 id）与模型档位（modelTierEconomy/Premium → 模型名字符串，WP9）；档案逐个打标麻烦；列表无排列逻辑。

## 1. 核心决策

### D1 脑池与工具层分离（用户确认）
- **脑池（执行器池）= 会思考的执行体**：CLI agent 产品（claude code/codex/…）+ LLM API 档案。统一进一个池、一个选择框。
- **非 LLM API 不进池**：独立视频生成、语音合成等无对话思考能力的服务归**工具层**（与 image_generate 同规：内置工具或 MCP 插件，产物落 worktree）。判据：能否自主跑多轮工具循环。

### D2 档位 = 档案选择器（两套合一）
- 设置页「模型分级」改造：高档/低档各一个**档案下拉**（CLI+API 混排），替代 modelTierEconomy/Premium 模型字符串（两键退役，迁移：旧值若匹配某 API 档案的 model 则自动建档案）。
- `model-tier.ts` 任务档位判定保留（蜂群/辩手=低档，计划/验收/裁决/请示=高档，普通=标准），解析目标从「模型名覆盖」改为「档案选择」；API 档案被选中时档案自身 model 生效，CLI 档案被选中时走该 CLI。
- 员工绑定（钉死某档案）与消息显式选择（单次例外）保留为覆盖位，优先级：消息显式 > 人才定制 > 档位档案 > 员工绑定档案（绑定=执行器选择，档位=成本能力选择，两者冲突时档位换档案但保留绑定的并发/凭据特性——一期从简：档位命中即用档位档案）。

### D3 打标最省事（自动为主，人工只纠偏）
- **manifest 自描述默认**：内置 manifest 声明默认能力（claude/codex=长上下文+代码；gemini-api=视觉；…）。
- **探针自动补**：能力探针结果自动回写 capabilities（API 探 model 列表/vision 支持；CLI 探 --version 与已知特性表）。
- **人工入口唯一**：执行器中心档案卡一行能力 chips，点选增删——不做独立打标页。
- 能力词表（一期）：`vision`（识图）/`image-gen`（生图，工具型也可挂）/`video-gen`/`voice`/`long-context`/`code`。多模态生成类标签主要服务**工具推荐**，脑池过滤只看 vision/long-context/code。

### D4 展示排列（用户痛点）
执行器中心列表排序：**按档位分组**（高档/标准/低档/未分配）→ 组内 健康度（健康在前，⚠️ 不健康沉底）→ 能力数多者在前 → 名称。能力 chips 同时作筛选器（点 vision 只看带视觉的）。设置页档案下拉同序。

### D5 选择算法（用户零操作）
领取任务时三步：
1. **过滤**：任务必需能力 ∩ 档案 capabilities（识图任务只留 vision 档案；无特殊要求不滤）。
2. **排序**：档位匹配（model-tier 判定）＞ 健康度（executor-failover 标记复用）＞ 空闲并发。
3. **降级链**：首选不健康/失败 → 同能力次选 → 降一档 → 绑定档案 → legacy 兜底。

## 2. 改造面

- `setting.ts`/设置页：档位键换档案 id（`executorTierHighId`/`executorTierLowId`，兼容读旧三级键做初值）。
- `model-tier.ts`：`resolveModelForTier` → `resolveProfileForTier`（返回档案）。
- `engine.ts`：effectiveExecutor 组装改为档案级（模型链不再单独覆盖 tier 模型）。
- `manifests.ts`：补默认能力声明；`capability-probe`：结果回写 capabilities。
- `ExecutorCenterPage`：分组排序+能力 chips 筛选+打标入口。
- 迁移：无表结构变更（capabilities 已在 config_json 内）；modelTierEconomy/Premium 读取兼容一个版本后删。

## 3. 非目标

- 不做自动测速/价格抓取排序（成本标签一期仅展示用户手填或留空）。
- 不改蜂群派遣分级与审批体系。
- 多执行器并存原则不变（同名 CLI 不同二进制仍可建多档案）。
