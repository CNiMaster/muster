# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About Muster

Muster is a local multi-agent orchestration system that spawns Claude Code CLI processes as agent backends and provides a web UI for visualization and interaction.

**Agent personas and skills** are derived from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (3 personas + 20 of 23 skills). See `agents/` and `skills/` directories.

## Commands

```bash
npm start          # Start the server (runs server.js with Node ESM)
npm run dev        # Start with --watch for auto-restart
npm install        # Install dependencies (express, ws)
```

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MUSTER_PORT` | `3456` | Server port |
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `MUSTER_SKIP_PERMISSIONS` | `false` | Set `true` to pass `--dangerously-skip-permissions` to agents |
| `MUSTER_ALLOWED_ROOTS` | `~:/tmp` | Colon-separated path roots for directory browsing |

No build step, no test suite. Node.js ESM project (`"type": "module"` in package.json).

## Architecture

### Core Flow

```
Human (boss) ←→ Leader (project manager) ← orchestrates → Workers + Verifiers
```

- **Leader**: The sole conversational partner for the human. Judges intent: `ask` (clarify), `answer` (direct reply), or `execute` (start task). Uses conversation history for context continuity.
- **Workers**: Execute subtasks. Each Worker gets a subtask prompt + project directory as cwd.
- **Verifiers**: Adversarial review of Worker output. Must approve or provide feedback. Worker retries up to N times on failure (preset-dependent).

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
| `config.js` | Complexity presets, model mapping, CLI flags, persona/skill loader |
| `storage.js` | File-based persistence to `.muster/` directories in each project |
| `sandbox.js` | Sandbox permission system: tool whitelist, command blacklist |
| `backup.js` | Backup manager: pre-modification snapshots, max 15 per project |
| `scheduler.js` | Scheduled task engine: one-shot and recurring jobs, rate-limit auto-retry |
| `utils.js` | Path validation, JSON parsing, CLI argument sanitization |
| `prompts/leader.md` | Chat-oriented Leader system prompt (ask/answer/execute modes) |
| `prompts/worker.md` | Worker execution prompt with retry-aware output format |
| `prompts/verifier.md` | Adversarial verifier prompt (approved/feedback JSON verdict) |
| `public/index.html` | Single-file two-panel chat UI with settings modal |
| `agents/` | Expert personas (from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)): code-reviewer, security-auditor, test-engineer |
| `skills/` | 20 specialist skills (from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)): spec-driven, planning, incremental-impl, etc. |

### Persistence Structure

```
<project-dir>/.muster/
├── workspace.json              # Workspace metadata
└── tasks/
    └── <taskId>/
        ├── task.json            # Task state + conversation history + subtasks + modelUsage
        └── chat.json            # Chat messages
```

Tasks are never deleted — only archived (`archived: true` flag). Archived tasks can be restored.

### Concurrency Model

`orchestrator.runParallel(taskFns, concurrency)` limits concurrent Worker-Verifier pairs. Concurrency comes from the complexity preset (2/3/5). Each subtask runs the full Worker→Verifier adversarial loop independently.

### WebSocket Events

Server bridges state events to all connected WS clients:
- `task:update`, `subtask:update`, `chat:message` — from state.js EventEmitter
- `agent:output`, `agent:tool` — from orchestrator (real-time agent activity)

All state changes auto-persist to disk via the event bridge in server.js.

### Sandbox & Security

Default mode is **sandbox**: Workers can only use whitelisted tools within the workspace directory. Dangerous commands (rm -rf /, git push --force, etc.) are blocked by 18 blacklist patterns. Workers operating outside the workspace require explicit approval. Backups are taken before each modification (up to 15 snapshots per project).

### Expert Personas & Skills

Workers can load specialist personas (`agents/*.md`) and skills (`skills/*/SKILL.md`) as system-prompt overlays. The orchestrator auto-injects these when a subtask specifies `persona` or `skill` fields. This enables domain-specific review (security audit, code review, test engineering) without spawning separate agent types.

### Scheduled Tasks

`scheduler.js` manages one-shot and recurring jobs. When a Worker hits an LLM rate limit, the system auto-schedules a retry after the cooldown period. Users can also manually schedule tasks via the Web UI settings panel. All jobs are visible and cancellable through `/api/scheduler/jobs`.

## Related Projects

| Project | Description | Relevance |
|---------|-------------|-----------|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Agent personas & skills source | Current `agents/` + `skills/` derived from this |
| [jnMetaCode/superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) | 20 AI work methodology skills (Chinese) | Expand skills library |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | 211 AI expert personas (46 Chinese originals) | Expand personas library |
| [jnMetaCode/agency-orchestrator](https://github.com/jnMetaCode/agency-orchestrator) | Multi-agent orchestration engine | DAG parallel execution patterns |
| [jnMetaCode/shellward](https://github.com/jnMetaCode/shellward) | 8-layer security middleware | Enhance sandbox security |
| [jnMetaCode/ai-coding-guide](https://github.com/jnMetaCode/ai-coding-guide) | 66 Claude Code tips & best practices | Optimize prompts & workflows |
