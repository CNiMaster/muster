# 能力商城（Marketplace）实施计划

> 日期：2026-08-14 ｜ 分支：`capability-marketplace`
> 设计：`docs/superpowers/specs/2026-08-14-capability-marketplace-design.md`

## 北极星

用户在能力中心「发现」区看到精选官方条目 → 一键安装 → 回管理面启用 → 用过后质量信号回流排序。同名条目永不并存：装前有状态、装时有冲突裁决、执行时有唯一 winner。

## 批次 0 — 文档先行（doc-first）

- [x] spec `docs/superpowers/specs/2026-08-14-capability-marketplace-design.md`（来源调研 + 分类体系 + 去重冲突 + 安全策略）
- [ ] plan（本文件）
- [ ] PRD line 377 商城概念段补一句 spec 指针（随 M1 提交）

## 批次 M1 — 预置策展目录 + 同名去重（后端核心）

- [ ] `src/shared/marketplace-presets.ts`：10 条策展条目（4 文档技能 anthropics/skills + 4 官方 MCP modelcontextprotocol/servers + 2 Claude Code 官方插件），每条含 kind/分类/来源+pin/描述/标签/权限清单/install 定位
- [ ] domain `marketplace-presets.ts`（server）：`listMarketplacePresets(db)` —— 返回每条 + 「muster 已安装」状态（同名同源）/ muster 内部冲突标记（同名异源）
- [ ] **打通注入链**：`resolveTaskSkills` skill 命中先查 plugin 表（公司生效且启用）再回退 bundled 目录——否则商城装的 skill 永远不进任务上下文（capability-binding.ts:100 现状只读 skills/ 目录）
- [ ] 安装路径：扩展 `installMarketplaceEntry` 支持 preset —— raw 拉取 SKILL.md（pin 版本 URL）/ plugin.json / mcp-command；**三层判定**：同源 409 / 异源「装新停旧」（写 company_plugin 禁用）/ 正常装
- [ ] 执行侧兜底：`getEffectivePluginsForCompany` 按 (kind, normalize(name)) 去重（实体行 > 只读视图；实体间取 updated_at 最新 + log.warn）
- [ ] API：`GET /api/plugins/marketplace/presets` + `POST /api/plugins/marketplace/install`（接受 preset id + scope）
- [ ] 测试：preset 数据校验 / 白名单校验 / pin 拉取 / 同源 409 / 异源冲突停旧装新 / **安装的 skill 真实进入任务上下文** / 执行侧 winner 唯一

## 批次 M2 — 商城页（前端）

- [ ] hooks：`useMarketplacePresets` / `useInstallMarketplaceEntry`
- [ ] 页 `src/client/pages/MarketplacePage.tsx`（路由 `/marketplace`）：分类 tab（Skill/MCP Server/插件/工具，空类隐藏）+ 二级分组 + 统一卡片（名称/来源徽章/描述/标签/质量徽章/安装状态）+ 全局搜索 + 来源过滤 + 详情抽屉（权限清单/安装方式/依赖/来源时间）
- [ ] 冲突弹窗：同名异源 → 对比两边 +「安装并停用旧条目」/ 取消
- [ ] 能力中心 `CapabilityCenterPage` 加「管理 | 发现」双入口互链
- [ ] e2e：浏览 → 详情 → 一键安装 → 管理页出现且可启用；重复安装卡片显示「已安装」；冲突弹窗停旧装新后 winner 唯一

## 批次 M3 — 官方源接入（搜索）

- [ ] migration：`marketplace_source` 表（id/kind official|manual/endpoint/refreshed_at）
- [ ] MCP Registry 客户端：`GET https://registry.modelcontextprotocol.io/v0/servers`（分页/搜索/超时降级）→ 归一化 MarketplaceEntry（含 namespace 名/安装命令/能力列表）
- [ ] 官方 repo 拉取：anthropics/claude-code marketplace.json + anthropics/skills 目录清单
- [ ] `POST /api/plugins/marketplace/search` 扩展：返回来源分组 + 已装/冲突标记；手动添加来源 API（official 白名单校验 + manual 标记未审核）
- [ ] 测试：mock registry 响应 / 降级路径 / 手动来源未审核标记

## 批次 M4 — 质量信号读侧（排序）

- [ ] `getAllCapabilityQuality` 聚合进商城条目（成功率/耗时/弃用徽章）
- [ ] 排序权重 = 策展分（官方精品 > 官方普通 > 未审核）+ 质量分；仅影响展示，不自动装
- [ ] 测试：quality 变化 → 排序变化

## 顺序与依赖

M1（数据+去重+装管道，解"能装不乱"）→ M2（页面，M1 的消费方）→ M3（搜索来源，独立于 M2 可并行）→ M4（排序，依赖 M1 数据 + quality 后端）。每批独立提交、typecheck + 测试 + e2e 绿。

## 风险与边界

- 拉取上游失败（GitHub raw/registry 网络）→ 降级为「暂不可安装」状态，不阻塞商城浏览。
- pin 版本拉取：raw URL 带 commit sha；上游仓库结构变化 → 安装报"来源已变更，等待目录更新"而非静默装错。
- 不做：智能体包（员工系统另议）、~/.zcode 插件缓存扫描（已拍板）、社区站镜像、卸载/更新 UI。
