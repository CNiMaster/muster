# 批次 G：快赢包（G0→G8 先简后难）

状态：proposed
日期：2026-08-22
来源：完整 changelog 收割计划 A 档全量 + 防休眠（桌面版定调转正）+ 版本号地基 + 两笔核销（评审 I5 symlink、F4 e2e 倒计时）。
约束：**零数据库迁移、零新依赖**（设置走 key-value 表；客户端偏好走 localStorage `muster:*:vN` 约定；保活用 macOS 内建 caffeinate）。
分工结论：本批全部主会话实现（约定密集，外包规格成本≈自写成本）；E1/C/F 大批次再试"小模型做可清单化件+逐行审"。

## G0 核销与地基

1. **版本号单源化**：/api/health version 现硬编码 '3.0.0'（health.ts:12）→ 启动读 package.json（readFileSync+JSON.parse，失败兜底 '0.0.0'）；SettingsPage 页脚显示版本（拉 /api/health）。
2. **路径校验收紧（核销评审 I5）**：resolveArtifactPath（artifact-content.ts:37 纯词法）对存在文件增加 realpath 归一后再判逃逸；/raw（api/artifacts.ts:64-82）与 /content 补 isPathAllowed（对齐 preview 双校验口径）。集成测试加 symlink fixture（指向库外文件 → 403）。
3. **e2e 倒计时用例（核销 F4）**：tests/e2e/task-auto-continue.spec.ts——测试进程 better-sqlite3 直写 /tmp/muster-e2e-run 库：任务置 waiting_input + 挂起行 backdate 11 分钟 + auto_continue_minutes=10 → 断言倒计时可见、可停止。锁冲突则降级记录已知限制。

## G1 输入草稿持久化

PromptComposer（:99 useState('') 切任务即丢）加 `draftKey?: string` prop；ProjectTaskWorkspace 传 `task:${task.id}`、HomePage 传 `'home'`。localStorage `muster:composer-draft:v1:<draftKey>`：挂载/key 变化读回，onChange 防抖 300ms 写，发送成功清除。仅文本，附件不持久化。

## G2 Markdown 增强

MarkdownPreview：①表格容器加悬浮「复制 TSV」「下载 CSV」（components override 从 children 提取文本）；②代码块「复制」按钮；③ZoomableImage 放大 Modal 加「下载」。

## G3 记忆面板过滤增强

MemoryReviewPanel（现仅 scope 下拉；服务端 /entries 已支持 tag/cause query）：加 cause 下拉（四值受控词表）+ tag chips 多选 + 项目维度（useProjects 映射 projectId→name，条目项目徽章 + 项目筛选）。

## G4 任务页分组折叠+排序

TasksPage（:78-90 员工列硬编码 seq 倒序+slice(0,10) 无控件）：列折叠 + 排序选择器（#seq 倒序|最近创建|最近更新）+「显示全部」；localStorage `muster:tasks-page:v1`。

## G5 防休眠

新模块 runtime/keepawake.ts：30s timer 评估；真→spawn `caffeinate -i -s` 持久子进程，假→SIGTERM；stop() 进优雅关停链。仅 darwin（其他平台 log.info 一次）。
条件（'active'）：countActiveTasks（coordinator.ts:173-176 六状态内联口径提成 domain/task.ts）>0 或 trigger next_run_at 5 分钟内。
设置三态 `prevent_sleep`：active（默认）|always|off，走 setting.ts→zod→SettingsPage→queries.ts 链。挂点 server.ts 启动链+startGracefulShutdownSequence onComplete。

## G6 设置页两层

settings-nav 分组：「常用」general+appearance+backup；「高级」models+swarm+network+credentials+tools。?tab= 机制不动。fontFamily/codeTheme 死 state（:50-54）视 useAppearance 支持情况渲染或删除。

## G7 ⌘K 升级（一期纯客户端）

WorkbenchShell 面板（:133/:177-187 已存在）：①当前项目任务组（经 commandOptions 注入，跳任务工作台）；②产物文件组（带 ?preview= 直开右栏预览）；③简单模式专业项灰态+「专业」小标（现直接隐藏）。子串过滤不引模糊库。

## G8 启动自检

coordinator.start()（:243-252 现 recoverStuckReflections+首 tick）加 bootSelfCheck：①显式再跑 recoverExpiredLeases（幂等）；②waiting_input 无未决挂起行→按 updated_at 补行（修 F4 等待起点漂移）；③log.info 汇总。只做这两类安全修复。

## 验证

单测/集成/e2e 逐件如上；终验四门跑在已提交状态：tsc -b --force → vitest 全量 → smoke 71 → e2e（30+新）。

## 不做

输入法/机器人/订阅/SSH 远程；⌘K 全局跨项目搜索（二期需新 API）；防休眠 Windows/Linux（桌面打包期）；HomePage 复活（F 档）。
