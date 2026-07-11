import { AppError, ErrorCode } from '../../shared/errors';
import { deepFreeze } from '../../shared/utils';

export type ExecutorKind = 'cli' | 'api';
export type ExecutorConcurrency = 'parallel' | 'profile-serial' | 'global-serial';

export interface ExecutorManifest {
  id: string;
  version: number;
  displayName: string;
  kind: ExecutorKind;
  officialSource: string;
  platforms: string[];
  detection: { command: string; args: string[] } | null;
  minimumVersion: string | null;
  session: { create: boolean; resume: boolean; compact: boolean; abort: boolean };
  isolation: { cwd: boolean; configDir: boolean; tempDir: boolean };
  permissions: { scoped: boolean; turboFlag: string | null };
  concurrency: ExecutorConcurrency;
  officialInstall: { guideUrl: string; commands: string[]; binaryName: string } | null;
}

export const BUILTIN_EXECUTOR_MANIFESTS: readonly Readonly<ExecutorManifest>[] = deepFreeze([
  { id: 'codex-cli', version: 1, displayName: 'Codex CLI', kind: 'cli', officialSource: 'https://github.com/openai/codex', platforms: ['darwin', 'linux', 'win32'], detection: { command: 'codex', args: ['--version'] }, minimumVersion: null, session: { create: true, resume: true, compact: true, abort: true }, isolation: { cwd: true, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: '--dangerously-bypass-approvals-and-sandbox' }, concurrency: 'parallel', officialInstall: { guideUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli', commands: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'brew install --cask codex', 'npm install -g @openai/codex'], binaryName: 'codex' } },
  { id: 'claude-code-cli', version: 1, displayName: 'Claude Code CLI', kind: 'cli', officialSource: 'https://code.claude.com/docs/en/installation', platforms: ['darwin', 'linux', 'win32'], detection: { command: 'claude', args: ['--version'] }, minimumVersion: null, session: { create: true, resume: true, compact: true, abort: true }, isolation: { cwd: true, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: '--dangerously-skip-permissions' }, concurrency: 'parallel', officialInstall: { guideUrl: 'https://code.claude.com/docs/en/installation', commands: ['curl -fsSL https://claude.ai/install.sh | bash', 'brew install --cask claude-code'], binaryName: 'claude' } },
  { id: 'gemini-cli', version: 1, displayName: 'Gemini CLI', kind: 'cli', officialSource: 'https://github.com/google-gemini/gemini-cli', platforms: ['darwin', 'linux', 'win32'], detection: { command: 'gemini', args: ['--version'] }, minimumVersion: null, session: { create: true, resume: true, compact: false, abort: true }, isolation: { cwd: true, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: { guideUrl: 'https://geminicli.com/docs/get-started/installation/', commands: ['brew install gemini-cli', 'npm install -g @google/gemini-cli'], binaryName: 'gemini' } },
  { id: 'openai-compatible-api', version: 1, displayName: 'OpenAI-compatible API', kind: 'api', officialSource: 'https://platform.openai.com/docs/api-reference', platforms: ['darwin', 'linux', 'win32'], detection: null, minimumVersion: null, session: { create: true, resume: false, compact: true, abort: true }, isolation: { cwd: false, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: null },
  { id: 'gemini-api', version: 1, displayName: 'Gemini API', kind: 'api', officialSource: 'https://ai.google.dev/api', platforms: ['darwin', 'linux', 'win32'], detection: null, minimumVersion: null, session: { create: true, resume: false, compact: true, abort: true }, isolation: { cwd: false, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: null },
  { id: 'custom-cli', version: 1, displayName: 'Custom CLI', kind: 'cli', officialSource: 'user-defined', platforms: ['darwin', 'linux', 'win32'], detection: null, minimumVersion: null, session: { create: true, resume: false, compact: false, abort: true }, isolation: { cwd: true, configDir: false, tempDir: true }, permissions: { scoped: false, turboFlag: null }, concurrency: 'profile-serial', officialInstall: null },
] satisfies ExecutorManifest[]);

export function getExecutorManifest(id: string): Readonly<ExecutorManifest> {
  const manifest = BUILTIN_EXECUTOR_MANIFESTS.find((item) => item.id === id);
  if (!manifest) throw new AppError(ErrorCode.VALIDATION, `未知执行器 Manifest: ${id}`);
  return manifest;
}
