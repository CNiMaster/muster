/**
 * 执行器 Provider 类型与默认配置。
 *
 * 每个 agent 可指定 provider（claude-cli / openai / gemini），引擎按 provider 分发。
 * 默认 provider 来自 SystemSettings.defaultProvider（默认 claude-cli，向后兼容）。
 */

/** 所有支持的执行器 provider。 */
export const PROVIDERS = ['claude-cli', 'codex-cli','antigravity-cli', 'opencode-cli', 'custom-cli', 'openai', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DEFAULT_PROVIDER: Provider = 'claude-cli';

/** 各 provider 默认的环境变量名（存 apiKeyEnv 时提示用）。 */
export const PROVIDER_DEFAULT_API_KEY_ENV: Record<Provider, string> = {
  'claude-cli': 'ANTHROPIC_API_KEY',
  'codex-cli': 'OPENAI_API_KEY',
  'antigravity-cli':'GOOGLE_API_KEY',
  'opencode-cli': '',
  'custom-cli': 'CUSTOM_CLI_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
};

/** 各 provider 默认的模型名。 */
export const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  'claude-cli': 'sonnet',
  'codex-cli': 'gpt-5',
  'antigravity-cli':'',
  'opencode-cli': '',
  'custom-cli': '',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

/** 各 provider 默认的 baseURL（openai 兼容 API 可覆盖）。 */
export const PROVIDER_DEFAULT_BASE_URL: Record<Provider, string | undefined> = {
  'claude-cli': undefined,
  'codex-cli': undefined,
  'antigravity-cli':undefined,
  'opencode-cli': undefined,
  'custom-cli': undefined,
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/** 判断字符串是否为合法 provider。 */
export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}
