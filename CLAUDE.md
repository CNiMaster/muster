# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About Muster

Muster is a local multi-agent orchestration system that spawns Claude Code CLI processes as agent backends and provides a web UI for visualization and interaction.

**Agent personas and skills** — 3 local personas plus 200+ domain experts integrated from [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) into `personas/`. 20 skills from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) in `skills/`.

## Product Direction: Agent Company Workbench

Muster is being redesigned from a one-shot Leader → Worker → Verifier orchestrator into a persistent, project-driven Agent company workbench.

Authoritative planning documents:

- `docs/PRD-agent-company-workbench.md` — product requirements and accepted domain semantics
- `docs/agent-company-implementation-checklist.md` — phased implementation and acceptance checklist

Key constraints for all new work:

- Do not preserve or extend the existing "quick task" mode as a product requirement. The current orchestrator and group chat are legacy implementation references, not the target architecture.
- Reuse low-level capabilities where appropriate: Claude Code process execution, streaming events, sandboxing, scheduling, backups, and path validation.
- Replace the orchestration and state model with Company, Project, Agent Definition, Project Agent Thread, Mirror, Task, Trigger, Artifact, Report Cycle, and Usage concepts from the PRD.
- All real work belongs to a Project. Employee identity is company-scoped; working context and runtime threads are project-scoped.
- A mirror is a project-local temporary parallel execution thread for one employee, not a new formal company employee.
- Task is the single runtime abstraction for queues, collaboration, clarification, feedback, event triggers, scheduled work, and bounded discussions.
- The platform owns deterministic infrastructure; semantic decisions must be assigned to an explicit Agent.
- No concurrent operation may silently overwrite or lose project files.
- The first validated vertical is a local single-user long-form novel company. Multi-tenant SaaS, payments, and full PPT/Word/video editing are later work.
- Old `.muster` runtime data contains failed test runs, has no migration requirement, and may be removed when the new persistence layer is introduced.

Current code below still documents the legacy implementation until replacement phases land. Do not describe planned modules as already implemented.

## Commands

```bash
npm start          # Start the server (runs server.js with Node ESM)
npm run dev        # Start with --watch for auto-restart
npm install        # Install dependencies (express, ws)
```

Desktop launch: double-click `start.command` (auto-opens browser).

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MUSTER_PORT` | `3456` | Server port |
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `MUSTER_SKIP_PERMISSIONS` | `false` | Set `true` to pass `--dangerously-skip-permissions` to agents |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | Colon-separated path roots for directory browsing |

Configs persist to `.muster/config.json` — restores on restart (complexity, leader model, sandbox overrides). Workspaces and tasks also auto-restore from disk.

No build step, no test suite. Node.js ESM project (`"type": "module"` in package.json). Single-file frontend (`public/index.html`) — all CSS/HTML/JS in one file, no framework, no hot-reload.

**Language**: UI and prompts are Chinese-first. Task descriptions, logs, and user-facing messages default to Chinese. Code comments and variable names are mixed (English + Chinese).

## Architecture

### Core Flow

```
Human (boss) ←→ Leader (project manager) ← orchestrates → Workers + Verifiers
```

- **Leader**: The sole conversational partner for the human. Judges intent: `ask` (clarify), `answer` (direct reply), or `execute` (start task). Uses conversation history for context continuity. Auto-assigns expert personas from `personas/` domain catalog.
- **Workers**: Execute subtasks. Each Worker gets a subtask prompt + project directory as cwd.
- **Verifiers**: Adversarial review of Worker output. Must approve or provide feedback. Worker retries up to N times on failure (preset-dependent).

### Key New Features

- **Timer mode**: Per-task timer toggle in chat input — messages are delayed and auto-triggered via scheduler
- **Goal mode**: Autonoumous loop until preset/custom goal met (test pass, security audit, etc.) with iteration tracking
- **Config persistence**: Settings auto-save to `.muster/config.json`, restore on startup
- **Workspace restoration**: Saved workspace index + all tasks restore automatically after restart
- **Clickable model badge**: Top bar shows "Leader: Opus" — click to cycle Opus↔Sonnet↔Haiku
- **Auto-create task**: Click workspace = create new task; type without selecting task = auto-create then send

### Agent Execution

Each agent is a `child_process.spawn('claude', ...)` invocation:

```
claude -p "<prompt>" --output-format stream-json --verbose --system-prompt "<role>" --model <role-model>
```

- `--output-format stream-json` **requires** `--verbose` (non-negotiable, CLI will error)
- Models assigned by role: leader→opus, worker→sonnet, verifier→haiku (maps to user's Claude alias settings)
- `--json-schema` used for structured Leader responses (ask/answer/execute)
- Stream JSON events parsed line-by-line: `system` → `assistant` (text/tool_use) → `result` (cost/usage)
- Per-model token tracking extracted from `result.modelUsage` field

### Key Files

| File | Role |
|------|------|
| `server.js` | Express + WebSocket server, REST APIs, event bridge to WS |
| `orchestrator.js` | Core engine: Leader conversation, task planning, Worker-Verifier adversarial loop |
| `agent-runner.js` | Spawns Claude CLI, parses stream-json, extracts cost/usage/modelUsage |
| `state.js` | In-memory state store (EventEmitter): workspaces, tasks, chat messages, subtasks |
| `config.js` | Complexity presets (simple/normal/deep), model mapping, CLI flags, persona/skill loader |
| `storage.js` | File-based persistence to `.muster/` directories in each project |
| `sandbox.js` | Sandbox permission system: tool whitelist, command blacklist, API-overridable |
| `backup.js` | Backup manager: pre-modification snapshots, max 15 per project |
| `scheduler.js` | Scheduled task engine: one-shot and recurring jobs, rate-limit auto-retry |
| `utils.js` | Path validation, JSON parsing, CLI argument sanitization |
| `prompts/leader.md` | Chat-oriented Leader system prompt (ask/answer/execute modes) |
| `prompts/worker.md` | Worker execution prompt with retry-aware output format |
| `prompts/verifier.md` | Adversarial verifier prompt (approved/feedback JSON verdict) |
| `public/index.html` | Single-file two-panel chat UI with tree sidebar, settings modal |
| `agents/` | 3 expert personas from addyosmani/agent-skills |
| `skills/` | 20 specialist skills from addyosmani/agent-skills |
| `personas/` | 200+ domain expert personas from agency-agents-zh, organized into 10 domain directories |

### Persistence Structure

```
muster/.muster/
├── config.json              # Global config (complexity, leader model, sandbox)
└── workspaces.json          # Workspace index (survives restart)

<project-dir>/.muster/
├── workspace.json            # Workspace metadata
├── backlog.json              # Backlog items
└── tasks/
    └── <taskId>/
        ├── task.json          # Task state + conversation history + subtasks + modelUsage
        └── chat.json          # Chat messages
```

Tasks are never deleted — only archived (`archived: true` flag). Archived tasks can be restored.

### Concurrency Model

`orchestrator.runWithDependencies(taskId, subtasks, runFn, concurrency)` implements a DAG-based scheduler. Independent subtasks run in parallel (up to concurrency limit from preset: 2/3/3). Subtasks with `dependsOn` wait for dependencies. File overlap is auto-detected — shared files between subtasks force sequential execution. Concurrency comes from the complexity preset (2/3/3). Each subtask runs the full Worker→Verifier adversarial loop independently.

### WebSocket Events

Server bridges state events to all connected WS clients:
- `task:update`, `subtask:update`, `chat:message`, `task:deleted` — from state.js EventEmitter
- `agent:output`, `agent:tool` — from orchestrator (real-time agent activity)
- `backlog:update`, `config:updated`, `timer:scheduled` — from various subsystems

All state changes auto-persist to disk via the event bridge in server.js.

### Retry & Failure Recovery

Workers have a progressive retry strategy governed by the complexity preset:
1. **Attempt 1**: Execute normally
2. **Attempt 2** (1st retry): Self-reflection — Worker receives its previous output and is told to continue from the failure point
3. **Attempt 3** (2nd retry): Leader diagnosis — Leader analyzes the failure and provides guidance
4. **Attempt 4+**: Notify human for intervention

On retry, the Worker model auto-escalates to `opus`. When a Worker times out (10-min default) or hits the tool-call limit (50), partial output is preserved and verification is skipped. If a rate limit error is detected, the system auto-schedules a delayed retry. Backups of affected files are taken before each Worker's first attempt, accessible via `/api/backups`.

### Sandbox & Security

Default mode is **sandbox**: Workers operate with restricted permissions. `sandbox.js` maintains a 22-pattern blacklist for dangerous commands (rm -rf, git push --force, shell injection). Write tools (Edit/Write/Bash) are only allowed within the workspace directory. The sandbox is configurable via the settings UI and persists overrides to `.muster/config.json`. To fully disable sandboxing, set `MUSTER_SKIP_PERMISSIONS=true`.

### Expert Personas & Skills

Workers can load specialist personas (`agents/*.md`, `personas/{domain}/*.md`) and skills (`skills/*/SKILL.md`) as system-prompt overlays. The orchestrator auto-injects these when a subtask specifies `persona` or `skill` fields. 200+ domain personas across 10 domains (engineering, marketing, design, security, product, data, qa, etc.) — imported from jnMetaCode/agency-agents-zh.

### Scheduled Tasks

`scheduler.js` manages one-shot and recurring jobs. When a Worker hits an LLM rate limit, the system auto-schedules a retry after the cooldown period. Users can also manually schedule tasks via timer toggle in chat input. All jobs are visible and cancellable through `/api/scheduler/jobs`.

## Related Projects

| Project | Description | Relevance |
|---------|-------------|-----------|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Agent personas & skills source | Current `agents/` + `skills/` derived from this |
| [jnMetaCode/superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) | 20 AI work methodology skills (Chinese) | Expand skills library |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | 211 AI expert personas (46 Chinese originals) | `personas/` imported from this |
| [jnMetaCode/agency-orchestrator](https://github.com/jnMetaCode/agency-orchestrator) | Multi-agent orchestration engine | DAG parallel execution patterns |
| [jnMetaCode/shellward](https://github.com/jnMetaCode/shellward) | 8-layer security middleware | Sandbox blacklist patterns inspired by this |
| [jnMetaCode/ai-coding-guide](https://github.com/jnMetaCode/ai-coding-guide) | 66 Claude Code tips & best practices | Optimize prompts & workflows |

## iHome API 接入规则

- iHome API 以 `/Users/master/Project/iHome/docs/Api规范/` 为唯一规范源。
- 收到 iHome API 变更通知时，先读 `变更通知/INDEX.md` 筛选出 `must_check` 项，再只读对应通知文件，不要整包加载全部规范。
- 本项目维护一份"实际使用的 iHome API 清单"，每次变更先搜索这些端点。
- STT WebSocket 必须发送 16kHz / 16bit / mono PCM 分片；浏览器 MediaRecorder 的 webm/opus 不能直接按 PCM 发。

## 指令入口约定（不可随意修改）

- `CLAUDE.md` 是本项目唯一主指令文件。
- `AGENTS.md`、`GEMINI.md` 只能保留 `@CLAUDE.md` 引用和本约定说明，不得复制、分叉或新增独立规则。
- 执行 /init、刷新项目记忆或更新 agent 规则时，只更新 `CLAUDE.md`。
- 如果其他入口文件已有更具体内容，必须先合并回 `CLAUDE.md`，再把入口文件恢复为 `@CLAUDE.md`。


## Supabase 数据库迁移约定（不可随意修改）

本节是项目数据库操作契约。任何 AI、脚本或协作者不得删除、弱化或绕过本节规则，除非用户在当前任务中明确要求修改该约定。

- 不默认使用 `supabase db push`。只有在确认本地 `supabase/migrations` 与远端 `supabase_migrations.schema_migrations` 历史完全一致时，才允许使用。
- 新增 Supabase migration 必须使用官方时间戳命名：`YYYYMMDDHHMMSS_description.sql`。优先通过 `supabase migration new <name>` 生成文件；不得再手写 `067_xxx.sql` 这类连续数字新迁移。
- 已有短编号历史 migration 保留不动，不为整理账本而重命名旧文件；从本约定生效后，所有新迁移一律使用官方时间戳形式。
- 远端执行优先使用 Supabase MCP `apply_migration`，并使用与本地 migration 文件一致的 migration name；没有 MCP 时使用 `supabase db query --linked --file supabase/migrations/<file>.sql`。
- 如果项目使用共享 Supabase 或双数据库，必须同时遵守项目级数据库路径和部署说明，并在所有目标数据库执行对应 SQL。
- 每次远端迁移后必须执行验证 SQL，确认关键列、函数、约束、RLS/policy、数据修复结果已经落库。
- 不主动执行 `supabase migration repair`、不手动改 `supabase_migrations.schema_migrations`，除非用户明确发起“迁移历史整理/修复”专项任务。
- 不把 Supabase access token、数据库连接串、service role key、数据库密码写入代码、文档、migration 或日志输出。
