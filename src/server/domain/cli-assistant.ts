import { z } from 'zod';
import type { SetupGenerator } from './setup-assistant';
import { zodObjectToJsonSchema } from './setup-assistant';
import { log } from '../logger';

/**
 * AI 引导自定义 CLI 接入。
 * - 热门本地 CLI agent 内置离线模板：关键词命中直接返回，不依赖 AI（调研 2026-07）。
 * - 其余走 ClaudeSetupGenerator（同公司/员工蓝图生成器），失败回退通用模板。
 */

export const cliProposalSchema = z.object({
  displayName: z.string().min(1),
  binaryName: z.string().min(1),
  detectionArgs: z.array(z.string()),
  installCommands: z.array(z.string()),
  loginCommand: z.string(),
  guideUrl: z.string(),
  argTemplate: z.array(z.string()),
  notes: z.string(),
});
export type CliProposal = z.infer<typeof cliProposalSchema>;

export interface CliProposalResult {
  source: 'claude' | 'offline_template' | 'builtin_template';
  proposal: CliProposal;
  warning?: string;
}

const HOT_CLI_TEMPLATES: Array<{ keywords: string[]; proposal: CliProposal }> = [
  {
    keywords: ['opencode'],
    proposal: {
      displayName: 'OpenCode CLI',
      binaryName: 'opencode',
      detectionArgs: ['--version'],
      installCommands: ['curl -fsSL https://opencode.ai/install | bash', 'npm install -g opencode-ai'],
      loginCommand: 'opencode auth login',
      guideUrl: 'https://opencode.ai/docs',
      argTemplate: ['run', '{prompt}', '--format', 'json', '--auto'],
      notes: '模型无关：用 opencode auth 登录任意 provider；--auto 自动批准未被 deny 的权限，请先在 opencode 配置中设置 deny 规则。',
    },
  },
  {
    keywords: ['aider'],
    proposal: {
      displayName: 'Aider',
      binaryName: 'aider',
      detectionArgs: ['--version'],
      installCommands: ['pipx install aider-install && aider-install', 'brew install aider'],
      loginCommand: '',
      guideUrl: 'https://aider.chat/docs',
      argTemplate: ['--message', '{prompt}', '--yes'],
      notes: '模型无关：通过 API key 环境变量（如 ANTHROPIC_API_KEY）鉴权；输出为文本流，结果以 AgentRunResult JSON 结尾。',
    },
  },
  {
    keywords: ['goose'],
    proposal: {
      displayName: 'Goose',
      binaryName: 'goose',
      detectionArgs: ['--version'],
      installCommands: ['curl -fsSL https://github.com/block/goose/releases/latest/download/goose_install.sh | bash'],
      loginCommand: 'goose configure',
      guideUrl: 'https://block.github.io/goose',
      argTemplate: ['run', '{prompt}'],
      notes: 'Block 开源 agent；运行参数与输出格式请以本机版本为准。',
    },
  },
  {
    keywords: ['qwen'],
    proposal: {
      displayName: 'Qwen Code',
      binaryName: 'qwen-code',
      detectionArgs: ['--version'],
      installCommands: ['npm install -g @qwen-code/qwen-code'],
      loginCommand: 'qwen code --login',
      guideUrl: 'https://github.com/QwenLM/qwen-code',
      argTemplate: ['-p', '{prompt}'],
      notes: '阿里开源；登录与参数以官方文档为准。',
    },
  },
  {
    keywords: ['grok'],
    proposal: {
      displayName: 'Grok Build',
      binaryName: 'grok',
      detectionArgs: ['--version'],
      installCommands: ['curl -fsSL https://grok.com/build/install.sh | bash'],
      loginCommand: 'grok auth login',
      guideUrl: 'https://grok.com/build',
      argTemplate: ['{prompt}'],
      notes: 'xAI 新秀；安装与参数以官方文档为准。',
    },
  },
  {
    keywords: ['copilot'],
    proposal: {
      displayName: 'GitHub Copilot CLI',
      binaryName: 'gh',
      detectionArgs: ['--version'],
      installCommands: ['brew install gh', 'gh extension install github/gh-copilot'],
      loginCommand: 'gh auth login',
      guideUrl: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
      argTemplate: ['copilot', 'suggest', '{prompt}'],
      notes: '需要 GitHub Copilot 订阅；suggest 命令用于代码建议场景。',
    },
  },
];

function genericTemplate(binaryName: string): CliProposal {
  return {
    displayName: 'Custom CLI',
    binaryName,
    detectionArgs: ['--version'],
    installCommands: [],
    loginCommand: '',
    guideUrl: '',
    argTemplate: ['{prompt}'],
    notes: '通用模板：请按你的 CLI 实际情况调整参数模板（每行一项，支持 {prompt}/{cwd}/{taskId}/{sessionId} 整项占位符）。',
  };
}

function matchBuiltin(prompt: string): CliProposal | null {
  const lowered = prompt.toLowerCase();
  for (const entry of HOT_CLI_TEMPLATES) {
    if (entry.keywords.some((keyword) => lowered.includes(keyword))) return entry.proposal;
  }
  return null;
}

/** AI 引导：生成自定义 CLI 接入方案（内置模板命中优先；AI 失败回退通用模板）。 */
export async function generateCliProposal(
  input: { prompt: string },
  generator: SetupGenerator,
): Promise<CliProposalResult> {
  const builtin = matchBuiltin(input.prompt);
  if (builtin) return { source: 'builtin_template', proposal: builtin };

  const offline = genericTemplate(input.prompt.trim().split(/\s+/)[0] ?? 'my-agent');
  try {
    const generated = cliProposalSchema.parse(await generator.generate({
      prompt: `为 Muster Agent 工作台设计自定义 CLI 执行器接入方案。用户描述：${input.prompt}。输出可执行配置：displayName（展示名）、binaryName（可执行文件名，如 opencode）、detectionArgs（检测版本参数数组）、installCommands（官方安装命令数组）、loginCommand（登录/鉴权命令，没有则为空字符串）、guideUrl（官方文档 URL）、argTemplate（参数模板数组，{prompt} 代表任务提示词，每项一个参数）、notes（限制与注意事项，如审批机制、headless 要求）。参数模板只能使用整项占位符 {prompt}/{cwd}/{taskId}/{sessionId}。`,
      jsonSchema: zodObjectToJsonSchema(cliProposalSchema),
    }));
    return { source: 'claude', proposal: generated };
  } catch (error) {
    log.warn('cli assistant proposal generation failed; using generic template', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      source: 'offline_template',
      proposal: offline,
      warning: '智能方案暂时不可用，已为你载入可编辑的通用模板。',
    };
  }
}
