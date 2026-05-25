# Muster v2

本地多 Agent 编排系统 — 以 Claude Code CLI 为后端引擎，提供 Web UI 可视化交互。

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务
npm start
# 或 node server.js
```

浏览器自动打开 http://localhost:3456

### 桌面快捷方式

双击 `start.command` 即可启动，服务在后台运行，日志输出到 `/tmp/muster.log`。
关闭终端窗口也不会影响服务运行。

> **提示**：如果端口 3456 被占用，启动脚本会自动清理旧进程。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MUSTER_PORT` | `3456` | 服务端口 |
| `CLAUDE_BIN` | `claude` | Claude Code CLI 路径 |
| `MUSTER_SKIP_PERMISSIONS` | `false` | 设为 `true` 跳过权限检查 |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | 目录浏览允许的根路径 |

## 使用指南

### 基本流程

1. **打开工作区** — 点击左侧"打开目录"，选择项目文件夹
2. **对话** — 选中工作区后直接输入消息，Leader 自动理解需求、规划任务、分配专家
3. **跟踪进度** — 左侧任务树展开后可查看 Worker/Verifier 团队进度
4. **查看结果** — 右侧聊天区实时显示 Agent 输出

### 定时消息

点击输入框上方 ⏰ 按钮开启定时模式，设置延迟时间后发送的消息会在指定时间后自动触发。

### Goal 模式

🎯 Goal 模式让系统自治循环执行，直到达成目标或达到限制：
- 输入框上方点击 🎯 Goal → 选择预制条件或自定义
- 系统自动执行 → 评估 → 重试，直到达标
- 可在顶部标签查看当前迭代进度

### 复杂度预设

顶部可选择三种复杂度模式：
- **简单** — 出错重试 1 次，最多 2 个子任务并行
- **标准** — 出错重试 3 次，最多 3 个子任务并行（日常推荐）
- **深度** — 出错重试 5 次，最多 5 个子任务并行

### 切换模型

顶部紫色标签可点击切换 Leader 模型：Opus → Sonnet → Haiku。

### 任务清单

每个工作区可管理待办清单（Backlog），在任务树中展开任务可见。

### 配置持久化

设置（复杂度、模型、沙盒配置）自动保存，重启后恢复。
工作区和任务进度在服务重启后自动恢复。

## 技术架构

```
Human ←→ Leader (Opus) ←→ Workers (Sonnet) + Verifiers (Haiku)
```

- **Leader**: 对话中枢，理解意图（ask/answer/execute），自动分配专家和技能
- **Worker**: 执行子任务，可加载领域专家角色（200+ 预置 Agent）
- **Verifier**: 对抗式审查 Worker 输出，通过/反馈循环

### 关键文件

| 文件 | 说明 |
|------|------|
| `server.js` | Express + WebSocket 服务端 |
| `orchestrator.js` | 核心编排引擎 |
| `agent-runner.js` | Agent 进程管理 |
| `state.js` | 内存状态管理 |
| `config.js` | 复杂度预设、模型映射、角色/技能加载 |
| `storage.js` | 文件持久化 |
| `sandbox.js` | 沙盒权限系统 |
| `scheduler.js` | 定时任务引擎 |
| `backup.js` | 修改前快照备份 |
| `public/index.html` | Web UI |
| `prompts/` | Agent 系统提示词 |
| `agents/` | 3 个内建专家角色 |
| `skills/` | 20 个内建技能模块 |
| `personas/` | 200+ 领域专家角色库 |

### 沙盒安全

Worker 只能在白名单工具和工作目录内操作，26 条黑名单模式拦截危险命令（rm -rf、强制推送、shell 注入等）。

### 配置持久化结构

```
muster/.muster/
├── config.json       # 全局配置（复杂度、模型、沙盒）
├── workspaces.json   # 工作区索引

<project-dir>/.muster/
├── workspace.json    # 工作区元数据
├── backlog.json      # 待办清单
└── tasks/
    └── <taskId>/
        ├── task.json # 任务状态 + 对话历史
        └── chat.json # 聊天消息
```

## 相关项目

- [agent-skills](https://github.com/addyosmani/agent-skills) — Agent 角色与技能来源
- [agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) — 211 个中文专家角色
- [superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) — 20 种 AI 工作法
- [shellward](https://github.com/jnMetaCode/shellward) — 8 层安全中间件
- [agency-orchestrator](https://github.com/jnMetaCode/agency-orchestrator) — DAG 并行编排模式
- [ai-coding-guide](https://github.com/jnMetaCode/ai-coding-guide) — 66 条 Claude Code 最佳实践

## License

MIT
