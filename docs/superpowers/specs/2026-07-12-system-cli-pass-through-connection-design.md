# System CLI Pass-through and Connection Verification Design

**Date:** 2026-07-12

## Goal

Muster discovers and connects to AI CLIs already installed and configured by the user. It does not own installation, login, accounts, model availability, proxy/network configuration, upgrades, plugins, MCP servers, or vendor configuration. If a CLI works in the user's normal local environment, Muster must use that same environment successfully or return the exact reason it cannot.

## Product boundary

Muster owns only:

- discovering supported executables on the system `PATH`;
- recording the exact executable path and observed version in an Executor Profile;
- running a non-mutating real connection probe;
- binding a fixed Executor Profile to an employee;
- providing the Task working directory, structured result contract, session identity, cancellation, logs, and Muster permission bridge at Task runtime;
- normalizing exit codes, stderr, structured vendor errors, timeouts, and permission failures into visible diagnostics.

Muster does not silently install, upgrade, log in, log out, copy credentials, select a vendor account, rewrite vendor settings, override the user's model aliases, remove plugins/MCP servers, or replace the user's network/proxy environment. Official installation and login documentation may be linked as help only.

## Supported built-in CLIs

- Codex CLI: command `codex`.
- Claude Code: command `claude`.
- Antigravity CLI: command `agy`; this replaces the consumer-facing Gemini CLI integration. Existing legacy `gemini` profiles remain readable and are shown as legacy rather than silently rewritten.
- Custom CLI: user supplies an absolute binary path and argument-array template; Muster reports that granular approvals are unavailable unless the custom adapter implements them.

Each built-in Manifest declares discovery arguments, a probe adapter, session capabilities, approval bridge capabilities, and vendor help links. Display names and commands come from the Manifest rather than provider-specific UI conditionals.

## Discovery and binding flow

1. On server start, Executor Center refresh, and explicit rescan, Muster checks each Manifest command with system path resolution and runs its version command.
2. Discovery never starts an interactive login flow.
3. A newly discovered path/version is shown immediately. Existing profiles keep their fixed path; a changed path/version is reported and can create or update a binding only while company configuration is unlocked.
4. A newly discovered CLI, changed CLI version, newly bound profile, or explicit “Connection test” triggers a real probe. A successful unchanged result is cached by executable path + version + relevant profile model for 24 hours; manual testing always bypasses the cache.
5. Startup scanning does not repeatedly consume model quota when a fresh successful cache entry exists.

## Real connection probe

The probe executes the actual bound binary in the normal inherited user environment and vendor configuration. It uses a temporary empty project directory and a prompt equivalent to: return a small fixed structured response, do not use tools, do not access files, and do not modify anything.

Success requires all of the following:

- process starts from the recorded absolute binary path;
- the vendor accepts the user's current authentication, account, network, proxy, and model configuration;
- a response completes before the probe timeout;
- the adapter parses the expected probe token and captures a session identifier when supported;
- the temporary directory remains unchanged.

The probe may consume a small amount of the user's vendor quota. Executor Center explains this before manual testing and records timestamp, duration, version, selected/effective model when reported, and summarized usage when available.

## Runtime pass-through

Task execution inherits the user's normal CLI environment and configuration. Muster must not use flags such as Claude `--setting-sources`, empty MCP overrides, skill disabling, model remapping, or a private CLI home merely to make the CLI behave differently from the user's terminal. Per-employee isolation is provided through Muster Task worktrees, run/session IDs, logs, temp files, abort controllers, and explicit vendor session IDs—not by cloning or rewriting vendor account configuration.

Muster-specific runtime additions are limited to:

- the Task worktree as `cwd`;
- the Task prompt and result contract;
- a fixed employee/thread session ID;
- cancellation/timeout handling;
- a permission bridge that evaluates proposed side effects before they run.

If a vendor cannot support a required bridge without changing user configuration, the profile is marked capability-limited and the limitation is shown before binding. It never silently becomes unrestricted.

## Project tasks and CLI session lifecycle

The user-facing Project Task is the conversation/context container, equivalent to opening a new Codex task inside one project. It is distinct from internal employee assignments:

- **Project Task**: created, named, completed, and archived by the user; groups one coherent objective and its conversation history.
- **Employee Assignment**: an internal work order dispatched to one employee inside a Project Task.
- **Employee Task Thread**: the employee's persistent conversational lane inside that Project Task; stores the vendor session/conversation ID.
- **Run**: one process invocation that starts or resumes an Employee Task Thread.

A new Project Task starts with no vendor session IDs. Muster creates a session lazily for each employee only when that employee first participates. Employees who never receive an assignment do not receive empty sessions. Follow-ups, delegated assignments, review, clarification, approval recovery, and rework within the same Project Task resume the same employee thread explicitly. Muster never uses “continue latest”.

Creating another Project Task in the same project creates fresh employee threads by default. The new task still receives employee identity, capabilities, approved employee/company/project memory, current project facts, and relevant artifacts, but it does not receive the previous task's full transcript. This keeps weakly related user objectives from accumulating into one unbounded vendor context while preserving durable knowledge through Muster memory.

Changing project, employee, or fixed executor always starts a new thread. Parallel work for one employee uses a mirror thread rather than writing concurrently to the employee's primary thread. When a Project Task is archived, all of its vendor thread IDs, summaries, usage, approvals, runs, and artifacts are retained as read-only history and are no longer selected for new work.

## Context capacity and session health

Muster, not the user, owns session health monitoring because vendor CLIs run headlessly. Before and during every Run, the session manager tracks available token/usage events, transcript size, accumulated tool output, turn count, compaction events, context-overflow errors, idle duration, wall-clock timeout, and consecutive recovery attempts.

At a soft threshold, Muster asks the adapter to use its native compaction capability when one exists. Codex uses `thread/compact/start`; Claude may auto-compact and exposes compact lifecycle events. An adapter without a reliable non-interactive compact operation, including the current Antigravity CLI contract, declares that limitation rather than emulating an undocumented command.

At a hard threshold, failed compaction, corrupt session, or repeated context error, Muster creates a replacement employee thread inside the same Project Task. Before replacement it persists a handoff bundle containing employee identity, approved memory, current objective, decisions, open assignments, artifact state, and the previous thread reference. The old thread remains archived and the replacement receives the bounded handoff rather than the full transcript.

Recovery is finite: retry the current thread once, compact once when supported, then replace the thread once. If the replacement also fails, the assignment stops with a visible diagnostic. No adapter may loop indefinitely or leave a hidden interactive process waiting forever.

## Approval takeover and wait recovery

Certified CLI adapters must prevent invisible native approval prompts. Codex approvals are handled through app-server server-initiated requests. Claude and Antigravity tool calls are intercepted through their supported pre-tool hooks. The bridge maps the proposed command, path, network target, or tool call into the same Muster policy engine used by API tools.

An immediately allowed or denied decision is returned synchronously. A decision requiring the user creates a durable approval record and moves the Assignment to `waiting_approval`. The live CLI request may wait for a bounded interval; if approved in time, Muster returns the decision to that process. On timeout, process exit, or Muster restart, the bridge fails closed, retains the approval and session ID, and resumes the same Employee Task Thread after the user decides.

Native interactive prompts must never be the only approval surface. If an adapter cannot suppress, intercept, or safely time out its native prompt, it cannot be certified for background operation. Turbo changes Muster's automatic decision rules but does not bypass declared high-risk categories, and a failed bridge never degrades into unrestricted execution.

## Diagnostics

Connection results use these states:

- `not_found`: command not on the server process `PATH`;
- `version_failed`: executable found but version command failed;
- `probe_required`: discovered but no fresh real probe exists;
- `testing`: real probe is running;
- `connected`: real probe completed successfully;
- `authentication_failed`: vendor reported login/account failure;
- `model_failed`: configured/default model was rejected;
- `network_failed`: endpoint, DNS, TLS, proxy, or connection retry failure;
- `permission_bridge_failed`: Muster could not enforce the declared bridge;
- `timeout`: process did not complete before the probe timeout;
- `failed`: other nonzero exit or invalid output.

Diagnostics retain sanitized stdout/stderr and vendor error codes. They redact tokens, authorization headers, credential values, and sensitive environment values. The UI states that login/configuration remains the user's responsibility and provides the exact command/path/error plus official help link.

## Antigravity migration

The built-in Google CLI Manifest becomes `antigravity-cli`, display name “Antigravity CLI”, command `agy`, and provider `antigravity-cli`. Its official install guide and command replace Gemini CLI guidance for new profiles. The adapter must be derived from the current `agy --help` and machine-readable/headless capabilities rather than assuming Gemini CLI flags remain compatible.

Legacy `gemini-cli` has been removed (Google sunset it on 2026-06-18 in favor of Antigravity CLI); its manifest, adapter, provider entry, and credential seed were dropped. `opencode-cli` is added as an experimental provider using `opencode run --format json --auto` headless output (approval via opencode deny rules). New automatic discovery prioritizes `agy` and keeps `codex-cli` / `claude-code-cli`.

## API and UI

Executor Center shows one card per discovered/supported CLI with path, version, last probe state/time, concise error, “Connection test”, “Rescan”, “Bind”, and vendor help. Startup discovery and probe updates are persisted and broadcast so the UI can refresh without polling aggressively.

The connection test API accepts a profile or discovered Manifest ID, supports `force: true` for manual testing, returns immediately with a test-run ID, and exposes status/result separately so a slow CLI does not hold an HTTP request open indefinitely.

## Verification

- Unit tests cover Manifest commands, discovery, cache keys, cache expiry, redaction, error classification, and legacy Gemini preservation.
- Adapter contract tests prove probes inherit environment/configuration and do not add configuration-isolation flags.
- Fixture CLIs cover success, auth error, model error, network retry/error, timeout, malformed output, and accidental file mutation.
- Real local smoke tests run against installed `codex`, `claude`, and `agy` when available; absence or user-side failure is reported as evidence rather than hidden.
- Acceptance remains `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`, and `git diff --check`.

## Non-goals

- Installing, upgrading, authenticating, or repairing vendor CLIs.
- Managing vendor accounts, subscriptions, API keys, model aliases, endpoints, proxies, plugins, MCP servers, or global configuration.
- Guaranteeing vendor availability when the same CLI is not operational in the user's own terminal environment.
