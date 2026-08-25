# 能力分级与原生岗路线（2026-08-25 批次一）

状态：implemented（工具三档 v1 + 验收评审只读档已落地；路线图后续项待排期）

## 背景

用户观察到 ZCode 的 code-reviewer 子代理无 Bash——这是刻意的最小权限设计（评审者只读，事前就没有）。muster 现状：assembleTools 全员同一套工具，人设 tools_json 只是推荐文案（context.ts 人设工具段）不约束实际工具集；权限层已有工蜂 deny 策略但绑定失败不阻断（自愈兜底），且模型看得到写工具会反复尝试失败。

## 落地：工具三档 v1（bee / staff）

| 档 | 内置工具白名单 | MCP | 判定（零迁移，纯运行时） |
|---|---|---|---|
| bee 蜂档 | read_file / list_files / web_fetch / web_search / ask_colleague / notify_host / notify_colleague / submit_review / done | 不注册 | ① role==='swarm-worker'；② inputProtocol.consultation；③ inputProtocol.acceptanceReview 存在 |
| staff 员工档 | 全部内置（现状） | 注册 | 其余全部（fail-open 到现状） |

- 落点：`domain/tool-tier.ts`（白名单+判定）、registry `restrictTo()`（Map 级收紧，definitions/resolve 同步）、`assembleTools(db,{tier})`（bee 跳过 MCP）、engine pumpThread 接线、蜂档 systemPrompt 注入只读声明。
- 验收评审任务绑蜂档的理由：验收契约是纯判定（读产物→VERDICT 汇报），与既有「立场独立性」（exemptBlueprintMatch）配套——评审者不该自己动手改它正在审的东西。
- 排除项及理由：write/edit/run_command（写与命令）；spawn_tasks/cancel_child_task（蜂无子代）；start/conclude_discussion（诱导他人行动）；image_generate（付费 API）。
- 与权限层双网：deny 策略绑失败自愈的场景由工具层兜底；CLI 执行器不受影响（tier 只作用于 API 工具循环）。
- 测试：tests/integration/tool-tier.spec.ts 10 例（判定矩阵/restrictTo/assembleTools 档位/tool-loop 集成）。全量 vitest 1701 例，唯二抖动（swarm-W3、pre-merge-checks 探测）三轮漂移+单独跑全绿+与改动路径零交集，定性满载抖动非回归。

## 路线图盘点结论（本轮探明，未动代码）

1. **原生岗模板内置——已存在**：personas/ 库 15 域 300+ 人设，`engineering-code-reviewer.md` 等评审类模板本来就有；专家生成入口（系统按需生成+免确认入库）已有。缺的「打包」（人设+工具档+审批档）后续走人设 toolTier 元数据通道（见后续项）。
2. **skill 消费路径——已打通**（旧记忆作废）：plugin(kind=skill) → collectEffectivePluginSkills → resolveTaskSkills（声明优先/retrieved 补位/plugin 盖 bundled）→ systemPrompt 注入；CLI 下 reference 类技能走文件工具指路；skillRequiresCli 派发校验；loadedSkillIds 持久化去黑盒。无需新工程。
3. **能力包分发格式——待拍板**（本路线图唯一需要新设计的项）：独立 spec 另立。

## 后续项（待排期）

- 人设 toolTier 元数据：personas frontmatter / agent_definition 加档位声明，专家生成时继承（评审类人设 → bee 档）。
- 员工/负责人差异化档位（v1 同权零回归，后续按需收窄）。
- CLI 执行器侧蜂档 → 强制 deny 策略（权限桥已有机制，接线即可）。
- 能力包分发格式 spec。
