# 批次 H「过程可见性 + 会话交互」

状态：implemented（两段全部交付，2026-08-22）
来源：zcode 体验对标（用户逐件给 UI 形态）+ 多 agent 可观测性侦察（两轮代码核查）+ 用工模型定调讨论。

## 轮子边界（build vs reuse，长期原则）

执行层永远复用外部执行器（CLI/API 档案池），不建内置 agent 引擎；tool-loop 仅作 API 档薄实现不再加码；评估把 opencode/pi 作为新增执行器档案接入池（后续小批，多执行器原则——它们是引擎供应商不是竞品）。呈现层可借鉴交互形态（折叠条/胶囊/diff），数据模型必须是我们的任务树与派遣关系。组织治理层（用工/专家池/借调/盘点/发布门禁/验收）自建——muster 立足点。

## 用工模型定调（本批落地，后续沿用）

三层用工：
- **员工**：常驻，档案+记忆+可对话（员工页）。
- **专家**：池化复用（specialist-pool 全局池），人事岗唯一供给入口；三级阶梯 临时→项目→固定，晋升不清记忆；可被借调，借调进蜂群即"临时专家"。
- **工蜂=子 Agent**：纯临时执行单元，任何人可派（负责人/员工/专家/养蜂人），无档案无记忆，任务完即焚；产出与过程归任务树沉淀=自然回流（汇报/trace 归任务，收口总结归养蜂人汇总任务）。

配套决定：
- temp-worker 基建专属临时专家与 B2B 外包，普通工蜂不走（现状每蜂建 profile+AgentHome+员工行再全删=厚重 churn，且蜂用固定提示词档案白建）。
- 专家派工蜂走既有"自主额度"（额度内免请示直接孵化，超限才请示负责人）；养蜂人是放蜂基建提供者非审批人。
- 专家群：向人事借调（池匹配→无则 staffingPlan 生成入池→派遣；复用蜂群请示模式）——借调流不属本批。
- 记忆治理：无固定过期；项目归档触发人事"待处置清单"（晋升入池/归档/删除，用户拍板）+ 定期盘点长期未借调者；不自动删除（删错找不回）。实现排用工治理批。

## 第一段「可见性组」H0→H4 + H9

- **H0 工蜂轻量化**（中）：createWorkerBee 改轻量路径——不再建 agent_profile/Agent Home/员工行，提示词内联任务（按引擎对 assignee 实际依赖裁剪，权限 deny 档等执行必需项保留）；群关 dismiss 只清任务树；temp-worker 路径不动。
- **H1 流水线折叠条 + 轮末变更卡**（大）：对话流内嵌任务树 trace 聚合（思考/工具/输出折条实时滚动，执行者标签：员工名/专家名+借调徽标/工蜂名）；轮末变更卡钉消息末尾：收起态 `▸ 3个文件已更改 +28 −14 ——撤销`；展开每行=类型logo｜文件名｜相对地址｜+3−3｜审查｜打开｜⌄菜单（Finder/命令行/复制相对·绝对路径）。审查=单文件 diff；打开=右栏预览（F.3 复用）；撤销=git revert 本轮集成分支 commit（复用发布 rollback+确认弹窗）=回退的温和最小版。新 API：轮末变更摘要+单文件 diff+撤销端点。
- **H2 胶囊 + 工作现场面板（三段式）**（大）：右上角悬浮胶囊（不可拖动）——收缩态一句话摘要（如"张三正在重构登录页 · 3 个子任务"），点击展开成面板、可收缩回胶囊。面板三段：①计划段=项目任务列表+各自计划文件查看；②进程段=当前任务树进度"进程 3/5"，超 5 项自动折叠、滚动/点击展开；③执行者目录=派遣树（按派遣者分组"谁派谁"：负责人→张三、专家李四；张三→工蜂×3）+可切"任务扁平"视角；每项两行（工作名称+状态）+工作时长+完成标记+雇佣标签（员工/专家(借调)/工蜂，无转正入口）；点击→右侧分栏该任务完整 trace 看板（只读）。SwarmTreeCard 改造为通用任务树视图。
- **H3 接线 subagent-health**（小）：已建未接线的健康聚合（dispatcher 维度活跃/失败计数）上 API，进胶囊与"需要你关注"区。
- **H4 产物自动预览回流**（中）：任务运行中扫 worktree 新增媒体文件（png/jpg/svg/html）自动发 preview trace——CLI 执行器（codex 等）生图立刻可见；入产物库仍走发布白名单门禁。
- **H9 @引用扩展**（中）：现仅 @智能体；补 @文件（产物/仓库路径补全→引用附件）与 @任务（引用任务上下文/跳转）。

## 第二段「交互组」H5-H7

- **H5 发送状态机 + 服务端排队条**（大）：运行中发送键变方块停止键（abort，任务回队列）；输入框提示语切换"继续输入以排队后续修改"；排队条服务端轻量表（新迁移，任务维度有序、刷新不丢）：拖动块调序｜内容单行截断｜↑立即（打断插话）｜✏️重编｜🗑️删除；设置加"插话模式/排队模式"两选项。
- **H6 划选上下文**（小）：划选浮出"添加到当前对话"，引用随下轮输入附上。
- **H7 消息复制角标 + 终端命令折条**（小）：替代已砍的编辑重发。
- H8 群聊颜色默认不做（要做只做头像+左缘细条版，届时单独说）。

## 交付与验证

worktree 纪律沿 F/G：spec 先行（本文件，开工时补 UI 验收截图/描述）、白名单提交（绝不 add -A）、每段独立四门验证（tsc -b --force 判真实退出码/vitest 全量/smoke/e2e）、终验跑在已提交状态、合并前 main 归因检查（并行会话 WIP）；第一段合并后再做第二段。

## 后续预告（不属本批）

- 批次 I：面板插件协议 v1（manifest+iframe 沙箱+受控 API：读/写文件、报预览、发消息；HTML 即 PPT 租户（skill 写 HTML→容器渲染→改码即时刷新）/画板/标记回传（划选写回任务上下文）；专家写插件为一等设计目标——manifest 足够简单让插件工匠专家照模板现写）+ 侧边辅助对话（协议第二租户，划选"在辅助对话提问"届时一并做）。
- 之后：专家群借调流与记忆治理盘点（人事+specialist-pool+归档盘点清单）；opencode/pi 执行器档案接入；回退历史树/分叉（分叉=从历史 commit 开新线不碰原线，比回退安全）。

## 不做（本批边界）

回退历史树（仅撤销最近轮）；专家群借调流与盘点清单；跨项目全局搜索；群聊颜色（默认）；输入回滚/编辑重发（已砍，换 H7 复制角标）。

## 第一段实施记录（H0-H4+H9，2026-08-22）

- **H0 方案改定**：company_employee.profile_id NOT NULL（FK RESTRICT）使"蜂零档案"在现 schema 不可行——改**共享单例档案** ap_worker_bee_shared（固定 id，is_temp_only=0）：N 蜂一份档案，Agent Home 天然一份；createAgent 复用（tempRecruit 豁免）；引擎评级跳过蜂防污染共享档案；dismissWorkerBee 只删 agent 行（级联任职/线程）。上下文装配零改动（共享档案 soul=BEE_PROMPT 与 agent.system_prompt 一致）。
- **H4 双挂点改单挂点**：codex/自定义 CLI 无 onToolCall 路径回调——统一为 15s 周期扫描 + finally 收尾兜底（removeWorktree 前），单一机制覆盖全部执行器；runId 用外提可变绑定（executionRun 声明在 try 块内）。新增任务级文件端点 /api/tasks/:id/files/*path（防线与 /raw 同口径），preview trace payload.origin='worktree' 分流。
- **H1 撤销目录语义**：带 projectTaskId 的发布 commit 在任务集成分支——revert 必须在其 staging worktree 执行（publish_record.project_root 是身份键不是落盘位置）；undo 端点按 task.projectTaskId 定位 staging worktree。numstat 封装在主仓库根即可执行（对象库共享）。
- **H9 token 设计**：refs 新字段带类型前缀（agent:/file:/task:），不动旧 mentions 语义；mention 候选 display→token 映射存组件 ref Map，发送时反查；服务端 file→路径注入、task→#seq/标题/状态/摘要注入、agent→recipients 并集扇出（每收件人一任务）。
- **H2 面板挂点**：?panel=live URL 驱动（与 ?preview= 同模式）挂 inspector 顶部；胶囊 fixed 右上（workbench-guide 先例 z-70）不可拖动，有事才出现；二级看板复用 ExecutionTraceCard（useTaskOnce 取 Task）。
- 测试口径：健康/派遣树等纯读聚合用 SQL 直置状态（状态机仪式无关）；realtime.spec 精确清单断言两处补新键（project-health/dispatch-tree）。

## 第二段实施记录（H5-H7，2026-08-22）

- **H5 interruptTask 安全组合**：先 UPDATE state='queued' 再 engine.abortTask——裸 abort 会被 runTask catch 按 AbortError 判 permanent 失败；置 queued 后 abort 走"让位重跑"分支。engine 经 app.locals 注入 REST（API 层此前无引擎引用）。flush（↑立即）打断用同语义（SQL 直置+abort，单任务失败不阻断送出）。
- **H5 drain 挂点**：coordinator tick auto-continue 之后独立 try/catch；项目判定 running/claimed 为忙；单条送出失败自动 cancel 防死循环重试。排队表 position 全列重写实现拖动调序；partial index 只索引 pending。
- **H6 启用范围**：onSelectQuote 可选 prop——仅任务工作台传入启用；群聊/员工页旧面板不动。引用随发送以 "> 引用：…" 前缀进 content（服务端零改动）；仅引用无输入也可发送（disabled 条件含 quotedContext）。
- **H7 终端折条**：不加新 trace kind，按工具名（Bash/bash/terminal/shell/zsh）前端判别覆盖样式（icon ▶_+等宽+左缘线）；isTerminalItem 导出供测试。
- **测试口径**：clockIn 后不能建员工——worker 预建于 beforeEach；queued INSERT 占位符与列数对齐是初版 bug（11/10）。

## 评审轮（2026-08-22，独立代理审 83df89a..78aefcc）

Critical×2 全修：
- **C1 排队重编全链 404**：客户端 PUT vs 服务端 PATCH——客户端改 PATCH；补排队六端点 HTTP 级测试（此前只有域层测试拦不住方法不匹配）。
- **C2 排队模式静默丢 refs/附件**：迁移 20260822214500 加 refs_json 列；enqueue zod/域/flush 全链透传；客户端 enqueue 分支补传 refs+attachments。

Important×6：
- I1 首扫假预览：run 启动基线扫描（baselineOnly 只填 Set 不发 trace）——checkout 自带的既有媒体不再被当"生成文件"。
- I2 worktree 预览裂图：img onError 回落项目产物端点（已发布则可见）。
- I3 locate 副作用：新 peekTaskStagingWorktree 只读窥探，locate 不再 materialize staging worktree；副作用只留给 undo。
- I4 查询放大：useRoundChanges staleTime 5min（发布记录不可变）；变更卡只挂最新一条 assistant 消息。
- I5 插话双跑语义（打断后旧任务完整重跑+新任务并行）——**已知边界，H8 停止语义轮收敛**（软停=paused 而非回队列，见对话定稿设计）。
- I6 flush 内联 SQL：复用 interruptTask 域函数（nowIso 口径统一）。

Minor 顺手修×9：死 filter/mention Escape 重置/LiveProcessBar 活跃口径补 paused·blocked/releaseSwarmBees 过期注释/共享蜂档案不进档案列表（listAgentProfiles 排除固定 id）/划选锚点归属容器/恒真断言/HTTP 测试含 refs 展开语义。
Minor 记录不改×5：dispatch-tree O(n²)（规模可忍）/跨项目借调专家标签/派遣树无嵌套层级/Finder reveal 的 staging 语义（与 locate 对齐留后续）/灰化蜂最终回收无人做+findGreyedTempWorker 可复用蜂（遗留问题记后续批——养蜂人盘点）。
Spec 偏差记录：③停止键形态（额外加键 vs 合一）——**H8 将按三态合一重建，届时消解**；①SwarmTreeCard 未改造（新建 WorkLivePanel 达成目标）；②LiveProcessBar 无雇佣徽标（徽标在面板内）。

## 已知问题（非本批引入）：new-task-signal e2e 时序竞态

- 现象：群聊 fill 后 ≤500ms 输入值被回滚为空（同一 DOM 节点、无重挂载、URL/视图恒定、无网络请求），消息未发出——间歇 ~40%。
- 证据链：探针三轮（DOM tag 持续=节点复用；inputValue 回弹；REQS_AFTER_FILL 空窗口）；二分证实 pre-H（83df89a）同机同样复现——环境放大（新主电脑时序）非代码回归。
- 已排除：worktree 重挂载/URL 闪切/Suspense 全树回滚（QueryClient 无 suspense）/安全弹窗（授权后仍复现）。
- 处置：playwright retries=1 收口；根因（疑 React 18 并发渲染下的受控值回滚，需最小复现仓库专项排查）留待独立任务。
