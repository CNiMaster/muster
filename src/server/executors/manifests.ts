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
  certification:'certified'|'experimental'|'custom';
  legacy:boolean;
  approvalBridge:'rpc'|'hook'|'none';
  limitations:string[];
  session: { create: boolean; resume: boolean; fork:boolean; compact: boolean; abort: boolean };
  isolation: { cwd: boolean; configDir: boolean; tempDir: boolean };
  permissions: { scoped: boolean; turboFlag: string | null };
  concurrency: ExecutorConcurrency;
  officialInstall: { guideUrl: string; commands: string[]; binaryName: string; loginCommand: string } | null;
  /** 池化统一（2026-08-17）：开箱自带能力标签（客户端建档案时预填）。 */
  defaultCapabilities?: string[];
}

/** 池化统一：manifest → provider 的单一路由（两份旧实现并入一处，避免行为漂移）。 */
export function providerForManifest(manifestId: string | undefined): string | undefined {
  if (manifestId === 'claude-code-cli') return 'claude-cli';
  if (manifestId === 'openai-compatible-api') return 'openai';
  if (manifestId === 'gemini-api') return 'gemini';
  return manifestId;
}

export const BUILTIN_EXECUTOR_MANIFESTS: readonly Readonly<ExecutorManifest>[] = deepFreeze([
  { id: 'codex-cli', version: 2, displayName: 'Codex CLI', kind: 'cli',certification:'certified',legacy:false,approvalBridge:'rpc',limitations:[], officialSource: 'https://github.com/openai/codex', platforms: ['darwin', 'linux', 'win32'], detection: { command: 'codex', args: ['--version'] }, minimumVersion: null, session: { create: true, resume: true,fork:true, compact: true, abort: true }, isolation: { cwd: true, configDir: false, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: { guideUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli', commands: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'brew install --cask codex', 'npm install -g @openai/codex'], binaryName: 'codex', loginCommand: 'codex login' }, defaultCapabilities: ['code'] },
  { id: 'claude-code-cli', version: 2, displayName: 'Claude Code CLI', kind: 'cli',certification:'certified',legacy:false,approvalBridge:'hook',limitations:[], officialSource: 'https://code.claude.com/docs/en/installation', platforms: ['darwin', 'linux', 'win32'], detection: { command: 'claude', args: ['--version'] }, minimumVersion: null, session: { create: true, resume: true,fork:true, compact: true, abort: true }, isolation: { cwd: true, configDir: false, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: { guideUrl: 'https://code.claude.com/docs/en/installation', commands: ['curl -fsSL https://claude.ai/install.sh | bash', 'brew install --cask claude-code'], binaryName: 'claude', loginCommand: 'claude' }, defaultCapabilities: ['code'] },
  {id:'antigravity-cli',version:1,displayName:'Antigravity CLI',kind:'cli',certification:'certified',legacy:false,approvalBridge:'hook',limitations:['当前版本不提供可靠的非交互压缩接口'],officialSource:'https://github.com/google-antigravity/antigravity-cli',platforms:['darwin','linux','win32'],detection:{command:'agy',args:['--version']},minimumVersion:null,session:{create:true,resume:true,fork:false,compact:false,abort:true},isolation:{cwd:true,configDir:false,tempDir:true},permissions:{scoped:true,turboFlag:null},concurrency:'parallel',officialInstall:{guideUrl:'https://antigravity.google/docs/cli-overview',commands:['curl -fsSL https://antigravity.google/cli/install.sh | bash'],binaryName:'agy',loginCommand:'agy'},defaultCapabilities:['code']},
  { id: 'opencode-cli', version: 2, displayName: 'OpenCode CLI', kind: 'cli', certification: 'experimental', legacy: false, approvalBridge: 'none', limitations: ['原生审批无法接管：以 --auto 运行，Muster 注入项目级 opencode.json deny 守卫（覆盖灾难性命令 + 与 classifyCommand 高风险分类对齐：git-push/system-install/deploy/credential-access/远程脚本执行/进程管理/敏感文件访问共 90+ 条规则）', '依赖 opencode headless JSON 输出，部分旧版本存在文本事件缺失问题（建议 ≥1.16）'], officialSource: 'https://github.com/anomalyco/opencode', platforms: ['darwin', 'linux', 'win32'], detection: { command: 'opencode', args: ['--version'] }, minimumVersion: null, session: { create: true, resume: false, fork: false, compact: false, abort: true }, isolation: { cwd: true, configDir: false, tempDir: true }, permissions: { scoped: false, turboFlag: null }, concurrency: 'parallel', officialInstall: { guideUrl: 'https://opencode.ai/docs', commands: ['curl -fsSL https://opencode.ai/install | bash', 'npm install -g opencode-ai'], binaryName: 'opencode', loginCommand: 'opencode auth login' }, defaultCapabilities: ['code'] },
  { id: 'openai-compatible-api', version: 1, displayName: 'Muster OpenAI-compatible API', kind: 'api',certification:'certified',legacy:false,approvalBridge:'rpc',limitations:[], officialSource: 'https://platform.openai.com/docs/api-reference', platforms: ['darwin', 'linux', 'win32'], detection: null, minimumVersion: null, session: { create: true, resume: false,fork:false, compact: true, abort: true }, isolation: { cwd: false, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: null },
  { id: 'gemini-api', version: 1, displayName: 'Muster Gemini API', kind: 'api',certification:'certified',legacy:false,approvalBridge:'rpc',limitations:[], officialSource: 'https://ai.google.dev/api', platforms: ['darwin', 'linux', 'win32'], detection: null, minimumVersion: null, session: { create: true, resume: false,fork:false, compact: true, abort: true }, isolation: { cwd: false, configDir: true, tempDir: true }, permissions: { scoped: true, turboFlag: null }, concurrency: 'parallel', officialInstall: null },
  { id: 'custom-cli', version: 1, displayName: 'Custom CLI', kind: 'cli',certification:'custom',legacy:false,approvalBridge:'none',limitations:['无法接管原生审批，只允许受限非交互运行'], officialSource: 'user-defined', platforms: ['darwin', 'linux', 'win32'], detection: null, minimumVersion: null, session: { create: true, resume: false,fork:false, compact: false, abort: true }, isolation: { cwd: true, configDir: false, tempDir: true }, permissions: { scoped: false, turboFlag: null }, concurrency: 'profile-serial', officialInstall: null },
] satisfies ExecutorManifest[]);

export function getExecutorManifest(id: string): Readonly<ExecutorManifest> {
  const manifest = BUILTIN_EXECUTOR_MANIFESTS.find((item) => item.id === id);
  if (!manifest) throw new AppError(ErrorCode.VALIDATION, `未知执行器 Manifest: ${id}`);
  return manifest;
}
