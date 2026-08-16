# 基础设置补齐（网络代理 / 外观 / 生成参数 / 并发）设计

**日期**：2026-08-12
**状态**：✅ 已实现（2026-08-12 起，随公司退场同步更新）
**关联 PRD**：`docs/PRD-agent-company-workbench.md` — Execution and Capability Model（新增 System Settings 概念段）
**关联代码**：`src/server/domain/setting.ts`、`src/server/api/settings.ts`、`src/client/pages/SettingsPage.tsx`、`src/server/executors/*-adapter.ts`、`src/server/domain/capability-probe.ts`

## 背景

muster 的设置体系非常薄：`system_setting` 键值表 + `SystemSettings` 接口只有 11 个 key（claudeBin/model/skipPermissions/timeoutMs/maxToolCalls/defaultProvider/openaiBaseURL/openaiModel/geminiModel/executorTier×3），无任何网络/外观/生成参数/并发配置。对照主流 agent 客户端（Claude Code 的 `settings.json`、Codex 的 `config.toml`、OpenCode 的 `opencode.json`），基础程序功能缺失明显：

- **网络**：5 个出口全用 Node 裸 `fetch`，**无代理、无证书、无超时配置**（`openai-adapter.ts:77`、`gemini-adapter.ts:73`、`llm-call.ts:42`、`web-tools.ts`、`capability-probe.ts:97`），包依赖里没有 `undici`/`proxy-agent`。
- **外观**：无主题/字体/字号/语言/代码主题设置。
- **生成参数**：无思考深度（各家：Anthropic thinking / Codex reasoning_effort / Gemini thinkingBudget / o-series reasoning_effort）、无上下文缓存开关。
- **并发**：无按执行器的并发上限与自适应控制。

用户确认"有必要的做"：代理、主题、字号、字体切换、中英文、代码块主题（简单）、思考深度（按模型自动识别）、上下文缓存（按模型）、并发（自适应 + 可锁定）。不做：温度（按模型默认）、行距/密度（保留默认）。

## 用户需求

1. 网络：HTTP 代理（留空=直连且不读系统 env）、代理例外（逐主机直连）、自定义 CA 证书（PEM 路径→NODE_EXTRA_CA_CERTS 语义）、出口超时。修改后重启生效。
2. 外观：主题（深/浅/跟随系统）、字体族（可切换）、字号、语言（中/英）、代码块主题。
3. 生成：思考深度归一化档位（关/低/中/高），**按模型自动识别**（不支持的模型隐藏）；上下文缓存开关（auto/on/off，按 provider 实现）。
4. 并发：按执行器/连接的最大并发 + 锁定开关；智能自适应（连续失败自动降、健康自动升），锁定后不越界不上调。

## 核心设计

### 数据模型

`system_setting` 新增 key（`SystemSettings` 接口同步扩展）：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `proxyUrl` | string | '' | HTTP 代理；空=直连（不读系统 env） |
| `proxyBypass` | string | '' | 例外主机，逗号分隔（`localhost,127.0.0.1,.example.com`） |
| `caCertPath` | string | '' | PEM 根证书路径 |
| `egressTimeoutMs` | number | 30_000 | 出口请求超时 |
| `theme` | 'dark'\|'light'\|'system' | 'system' | 外观主题 |
| `fontFamily` | string | 'system-ui' | 界面字体 |
| `fontSize` | number | 14 | 界面字号（px） |
| `locale` | 'zh'\|'en' | 'zh' | 界面语言 |
| `codeTheme` | string | 'default' | 代码块高亮主题 |

`executor_profile` 新增列（B4）：

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `max_concurrency` | INTEGER | 4 | 硬上限 |
| `concurrency_locked` | INTEGER | 0 | 锁定：自适应不越界不上调 |
| `effective_concurrency` | INTEGER | 4 | 自适应维护的实际并发 |

`executor_profile` 新增列（B3）：`thinking_depth` TEXT DEFAULT 'off'、`context_cache` TEXT DEFAULT 'auto'。

### B1 网络出口（egress）

- 新增依赖 `undici`。
- 新建 `src/server/runtime/egress.ts`：`buildEgressDispatcher(settings)` 构造全局 Dispatcher：
  - `proxyUrl` 为空 → 直连 `Agent`（**不读环境变量**——与常见工具不同，是用户明确规格）。
  - `proxyUrl` 非空 → 按 `proxyBypass` 逐主机分流：命中例外 → 直连 `Agent`；否则 `ProxyAgent`。
  - `caCertPath` → `connect.ca` 注入（Agent 与 ProxyAgent 的 TLS 配置）。
- `server.ts` 启动时 `setGlobalDispatcher(...)`；设置保存后前端提示"重启生效"，不热更。
- 5 个出口确认走全局 dispatcher（裸 `fetch` 自动生效，逐一核对无独立 agent）。
- CLI/MCP 子进程注入 `NODE_EXTRA_CA_CERTS`；MCP http/sse 传 TLS 选项。

### B2 外观

- 前端 CSS 变量（`--theme-*`、`--font-family`、`--font-size`）由设置驱动，挂在 `:root`/`data-theme`；`<html lang>` 按 locale；i18n 字典（zh/en 首版覆盖设置页与主壳）；代码块 CodeMirror 主题映射。
- 后端仅持久化。

### B3 生成参数

- `capability-probe.ts` 扩展：探测模型思考支持（按 provider 判断 + 实测），结果落 `capability_probe` 已有表（或内存）。
- 归一化 `thinkingDepth: 'off'|'low'|'medium'|'high'` → 各家参数翻译（adapter 内）：
  - Anthropic：`thinking: {type:'enabled', budget_tokens: N}`（low=8k/medium=16k/high=32k）。
  - Codex/OpenAI o 系：`reasoning_effort: 'low'|'medium'|'high'`。
  - Gemini：`thinkingConfig: {thinkingBudget: N}`。
  - 不支持 → 忽略并隐藏 UI。
- 上下文缓存：`contextCache='on'|'auto'` 时按 provider 开启（Anthropic `cache_control`、OpenAI 前缀缓存默认即开则不做额外事、Gemini 无需显式）。'off' 时禁用。

### B4 并发

- 引擎领取门：`claimNextTask`/`_pumpThread` 前按"该执行器在跑数 < effectiveConcurrency"放行。
- 自适应（新模块 `src/server/domain/executor-concurrency.ts`）：
  - 事件输入：Spec1 的失败分类。连续 transient 失败（疑似限流/过载）→ `effective_concurrency` 下调（≥1）。
  - 健康窗口（如 30min 无失败）→ 试探 +1，封顶 `max_concurrency`。
  - `concurrency_locked=1` → 冻结在 `max_concurrency`，不越界不上调。
- 前端：执行器档案"最大并发 + 锁定"。

## 变更点（带 file:line）

- `src/server/domain/setting.ts:7-25` — SystemSettings 接口扩展 + 默认值。
- `src/server/runtime/egress.ts`（新）— dispatcher 构造。
- `src/server/server.ts` — 启动 setGlobalDispatcher + NODE_EXTRA_CA_CERTS。
- `src/server/api/settings.ts` — 校验 + 保存（保存后返回需重启标记）。
- `src/client/pages/SettingsPage.tsx` + `src/client/components/settings/` — 网络/外观段。
- `src/server/executors/*-adapter.ts`（openai/gemini/llm-call）— 思考/缓存参数翻译。
- `src/server/domain/capability-probe.ts` — 思考支持探测。
- `src/server/domain/executor-concurrency.ts`（新）— 自适应。
- `src/server/task-engine/engine.ts` — 领取门。
- 迁移：`YYYYMMDDHHMMSS_settings_overhaul.sql`（executor_profile 新列）。

## 实现批次

- **B1 网络代理 + 证书**（undici/egress/设置段/5 出口核对/子进程 env/测试）。
- **B2 外观**（CSS 变量/i18n/设置段/测试）。
- **B3 生成参数**（探测/归一化翻译/缓存/测试）。
- **B4 并发**（领取门/自适应/锁定/测试）。

## 验收标准

1. `egress.ts` 单测：代理分流、例外直连、无代理直连且不读 env、CA 注入。
2. 设置保存后提示重启；重启后生效。
3. 主题/字体/字号/语言切换在 jsdom 渲染生效。
4. 思考深度映射各家参数正确；不支持模型隐藏。
5. 并发：在跑数受 effective 限制；失败下调、健康上调、锁定不越界。
6. 每批 `tsc -b` 绿 + 相关 vitest 绿 + 全量回归无退化。

## 不在本轮范围

温度参数、行距/密度控件、遥测/数据共享、更新渠道、浏览器连接（待用户提供其他客户端参考设置后评估）。

## 与其他 spec 的衔接

- 并发自适应用的失败分类来自 [[2026-08-12-subagent-observability-design]]（`FailureCategory`）。
- 出口超时/重试与 [[2026-08-12-subagent-observability-design]] 的 transient 分类配合。
