# 贡献指南 (Contributing Guide)

感谢你愿意为 **Muster** 贡献力量！无论你是提交 Bug、改进文档、修复问题还是开发新功能，都欢迎。

## 目录

- [开发环境](#开发环境)
- [项目结构](#项目结构)
- [本地开发](#本地开发)
- [代码规范](#代码规范)
- [提交规范](#提交规范)
- [测试](#测试)
- [提交 PR 流程](#提交-pr-流程)

## 开发环境

- **Node.js >= 22.12**（推荐使用 [nvm](https://github.com/nvm-sh/nvm) 或 [fnm](https://github.com/Schniz/fnm) 管理）
- **Git**
- 一个可用的 AI CLI（可选，运行真实任务时需要）：[Claude Code](https://code.claude.com) / [Codex CLI](https://github.com/openai/codex) / [Antigravity CLI](https://antigravity.google) / [OpenCode](https://opencode.ai)

```bash
git clone https://github.com/your-org/muster.git
cd muster
npm install
```

## 项目结构

```
src/
  client/        # React 前端（Vite + React Router + TanStack Query）
  server/        # Node 后端（Express + better-sqlite3）
    api/         # REST 路由
    domain/      # 领域逻辑（公司/员工/项目/Task/执行器/备份…）
    executors/   # CLI/API 执行器适配器与工具装配
    db/          # SQLite 迁移（migrations/*.sql）
    task-engine/ # Task 执行引擎（watchdog/调度/工作树）
  shared/        # 前后端共享类型与常量
tests/
  unit/          # 组件/单测（jsdom + vitest）
  integration/   # 领域集成测试（内存 SQLite）
  e2e/           # Playwright 端到端（独立 MUSTER_HOME，不污染本地数据）
scripts/
  smoke/         # 冒烟测试（通过 HTTP API 驱动，写入独立库）
docs/
  superpowers/specs/   # 架构设计文档
  superpowers/plans/   # 实施计划
```

## 本地开发

```bash
npm run dev        # 启动开发服务（http://127.0.0.1:3456）
npm run typecheck  # 类型检查（提交前必须通过）
npm test           # 运行单元 + 集成测试
```

> 冒烟测试 `npm run smoke` 会通过 HTTP 写入数据库。请在独立环境（`MUSTER_HOME=/tmp/muster-smoke`）下运行，避免污染本地数据。

## 代码规范

- **TypeScript 严格模式**：所有代码必须通过 `npm run typecheck`。
- **领域分层**：路由（`api/`）只做参数校验与编排；业务逻辑放 `domain/`；共享类型放 `shared/`。
- **数据库迁移**：表结构变更必须新增 `src/server/db/migrations/<时间戳>_<名称>.sql`，**不修改已应用的迁移文件**。
- **注释语言**：代码注释与用户可见文案使用中文；标识符与提交信息使用英文（或中英混合）。
- **不引入不必要的依赖**：优先复用现有工具（better-sqlite3、zod、TanStack Query 等）。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格：

```
feat(scope): 摘要
fix(scope): 摘要
docs: 摘要
refactor(scope): 摘要
test: 摘要
chore: 摘要
```

示例：

```
feat(executors): 一键安装 CLI（平台智能选择安装方式）
fix(backup): 导入包整体事务，避免半成品数据
```

## 测试

- 新功能**必须**配套集成测试（`tests/integration/*.spec.ts`，使用 `makeTestDb()` 内存库）。
- 新组件**鼓励**配套组件测试（`tests/unit/*.spec.tsx`）。
- 修改执行引擎/迁移等高风险区域时，请运行全量测试确认无回归。

```bash
npm test           # 全部单元 + 集成
npm run test:e2e   # Playwright（需先安装 playwright browsers）
```

## 提交 PR 流程

1. Fork 仓库并创建功能分支：`git checkout -b feat/my-feature`
2. 完成开发，确保 `npm run typecheck` 与 `npm test` 通过
3. 提交（遵循提交规范），推送分支
4. 创建 Pull Request，描述：
   - 解决了什么问题 / 新增了什么能力
   - 变更了哪些领域语义（如有）
   - 测试覆盖情况与验证步骤
5. 等待 CI（typecheck + test + build）通过与维护者 review

### PR 检查清单

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过
- [ ] 新增功能有集成测试
- [ ] 表结构变更新增迁移文件（不改历史迁移）
- [ ] 提交信息遵循 Conventional Commits

## 行为准则

请保持友善与建设性。参考 [CODE_OF_CONDUCT]（如已建立）。所有讨论与贡献默认遵循 [MIT License](LICENSE)。
