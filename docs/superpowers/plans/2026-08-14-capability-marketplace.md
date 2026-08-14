# 能力商城（Marketplace）实施计划

> 日期：2026-08-14 ｜ 分支：`capability-marketplace`
> 设计：`docs/superpowers/specs/2026-08-14-capability-marketplace-design.md`

## 北极星

用户在能力中心「发现」区看到精选官方条目 → 一键安装 → 回管理面启用 → 用过后质量信号回流排序。同名条目永不并存：装前有状态、装时有冲突裁决、执行时有唯一 winner。

## 批次 0 — 文档先行（doc-first）

- [x] spec `docs/superpowers/specs/2026-08-14-capability-marketplace-design.md`（来源调研 + 分类体系 + 去重冲突 + 安全策略 + 执行原则 + 注入链缺口）
- [x] plan（本文件）
- [x] PRD line 377 商城概念段补 spec 指针（随 M4 提交）

## 批次 M1 — 预置策展目录 + 同名去重（后端核心） ✅ 已提交

- [x] `src/shared/marketplace-presets.ts`：10 条策展条目（7 skill anthropics/skills + 3 官方 MCP modelcontextprotocol/servers；Claude Code 插件包因其 bundle 结构映射复杂改列 M3 浏览源），每条含 kind/分类/来源+pin/描述/标签/权限清单/install 定位
- [x] domain `marketplace-presets.ts`（server）：`listMarketplacePresets(db)` —— 返回每条 + 「muster 已安装」状态（同名同源）/ muster 内部冲突标记（同名异源）
- [x] **打通注入链**：`resolveTaskSkills` skill 命中先查 plugin 表（公司生效且启用）再回退 bundled 目录
- [x] 安装路径：`installPreset` —— raw 拉取 SKILL.md（pin 版本 URL）/ mcp-command；**三层判定**：同源 409 / 异源「装新停旧」（写 company_plugin 禁用）/ 正常装
- [x] 执行侧兜底：`getEffectivePluginsForCompany` 按 (kind, normalize(name)) 去重（实体行 > 只读视图 + log.warn）
- [x] API：`GET /api/plugins/marketplace/presets` + `POST /api/plugins/marketplace/install-preset`
- [x] 测试：preset 数据校验 / 三层去重 / **安装的 skill 真实进入任务上下文** / 执行侧 winner 唯一

## 批次 M2 — 商城页（前端） ✅ 已提交

- [x] hooks：`useMarketplacePresets` / `useInstallPreset`
- [x] 页 `src/client/pages/MarketplacePage.tsx`（路由 `/marketplace`）：分类 tab（Skill/MCP Server）+ 二级分组 + 统一卡片（名称/来源徽章/描述/标签/权限/质量徽章/安装状态）+ 详情信息内联 + 冲突弹窗
- [x] 冲突弹窗：同名异源 → 对比两边 +「装新停旧」/ 取消
- [x] 能力中心 `CapabilityCenterPage` 加「管理 | 发现」双入口互链
- [x] e2e：浏览 → 一键安装 MCP → 卡片转「muster 已安装」→ 能力中心出现；Skill tab 文档分组

## 批次 M3 — 官方源接入（搜索） ✅ 已提交

- [x] migration：`marketplace_source` 表（kind official|manual / reviewed 未审核标记）
- [x] MCP Registry 客户端：`GET https://registry.modelcontextprotocol.io/v0/servers`（分页/搜索/超时降级）→ 归一化 MarketplaceSearchEntry（namespace 名）
- [x] 官方 repo 拉取：anthropics/skills 目录清单（claude-code marketplace.json 因网络抖动未实装——与 Claude Code 插件包同列后续，预置条目已覆盖其技能价值）
- [x] `GET /api/plugins/marketplace/catalog?q=`：返回来源分组（presets/registry/skillsCatalog）+ 已装/冲突标记
- [x] 手动添加来源 API：official 白名单常驻展示；manual 未审核只登记展示，**搜索层绝不自动抓取手动端点（防 SSRF）**
- [x] 商城页全局搜索框：策展命中可安装；Registry/skills 目录命中浏览型（来源链接，安装后续开放）
- [x] 测试：mock registry 响应 / 降级路径 / 归一化 / 手动来源未审核与去重

## 批次 M4 — 质量信号读侧（排序） ✅ 已提交

- [x] `getCapabilityQuality` 聚合进预置条目（成功率/次数/耗时徽章）
- [x] 排序权重 = 质量分（成功率 ×0.8 + 使用量 ×0.2），无信号保持策展目录顺序；仅影响展示，不自动装
- [x] 测试：有信号浮前 / 信号变化 → 排序反超

## 顺序与依赖

M1（数据+去重+装管道）→ M2（页面）→ M3（搜索来源）→ M4（排序）。每批独立提交、typecheck + 测试 + e2e 绿。

## 风险与边界

- 拉取上游失败（GitHub raw/registry 网络）→ 降级为「暂不可安装/空结果」，不阻塞商城浏览。
- pin 版本拉取：raw URL 带 commit sha；上游变化 → 安装报「来源已变更」而非静默装错。
- 不做（本轮）：智能体包（员工系统另议）、~/.zcode 插件缓存扫描（已拍板）、社区站镜像、插件卸载/更新 UI、非预置条目的商城安装（M3 仅浏览，安装管道已有，开放留后续）。
