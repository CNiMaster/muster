import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST_SESSION_KEYS = ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE'];

export async function resolveCliEnvironment(options: {
  parentEnv?: NodeJS.ProcessEnv;
  shell?: string;
  loadLoginEnvironment?: () => Promise<NodeJS.ProcessEnv>;
} = {}): Promise<NodeJS.ProcessEnv> {
  const parentEnv = options.parentEnv ?? process.env;
  const shell = options.shell ?? parentEnv.SHELL ?? '/bin/zsh';
  let env: NodeJS.ProcessEnv;
  try {
    env = await (options.loadLoginEnvironment?.() ?? loadLoginEnvironment(shell, parentEnv));
  } catch {
    env = { ...parentEnv };
  }
  const resolved = { ...env };
  for (const key of HOST_SESSION_KEYS) delete resolved[key];
  return resolved;
}

async function loadLoginEnvironment(shell: string, parentEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const { stdout } = await execFileAsync(shell, ['-lic', 'env -0'], {
    env: { HOME: parentEnv.HOME, USER: parentEnv.USER, LOGNAME: parentEnv.LOGNAME, SHELL: shell, TERM: parentEnv.TERM ?? 'xterm-256color' },
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
  });
  const env: NodeJS.ProcessEnv = {};
  for (const entry of stdout.toString().split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}
