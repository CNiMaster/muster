# Muster v3

本地 Agent 公司工作台 —— 持久化、项目驱动的多 Agent 协作系统，首个落地场景为长篇小说创作公司。

> 旧 Leader→Worker→Verifier 单次编排器已废弃；当前实现见 `CLAUDE.md`。

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 开发模式：tsx watch + Vite middleware，访问 http://127.0.0.1:3456
```

生产构建：

```bash
npm run build      # tsup 编译 server + vite build 客户端
npm start          # node dist/server/server.js
```

## 主要能力

- **公司工作台**：创建公司、员工、部门、组织图、通信图、工作流图；上班锁定正式组织配置。
- **持久 Task 内核**：10 态状态机、原子领取、租约心跳、依赖、追问 3 轮上限、自动规划。
- **安全成果工作区**：每 Task 一个 Git worktree；串行发布队列做三方合并、同段冲突阻塞、可回滚。
- **长篇小说公司**：5 基础岗位（lead/writer/character/plot/inspector），章节事件触发资料维护，定时一致性检查。
- **镜像、监察、复盘、头脑风暴**：镜像并行不重复领取；监察员只建议不扩容；强制复盘按根员工聚合；闲置头脑风暴受限。
- **Claude Code 执行器**：session 持久化、AgentRunResult 契约、用量统计、预算/无进展/重复检测。

## 常用脚本

| 命令 | 作用 |
|------|------|
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm test` | Vitest 单测 + 集成（66 项） |
| `npm run test:e2e` | Playwright 端到端 |
| `npm run build` | 构建产物到 `dist/` |

## 数据

- 数据库：`~/.muster/muster.db`（SQLite，WAL，14 张表）
- Task worktree：`~/.muster/worktrees/<taskId>`
- 项目成果：用户项目根目录（Muster 自动 `git init`）

## 文档

- `CLAUDE.md` — 当前架构与命令
- `docs/PRD-agent-company-workbench.md` — 产品需求
- `docs/agent-company-implementation-checklist.md` — 分阶段实施清单
