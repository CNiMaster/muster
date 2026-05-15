import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 复杂度预设（用户只选这个）
const PRESETS = {
  simple:  { retries: 1, concurrency: 2, budgetScale: 0.5, label: '简单', goalMaxIter: 3, goalBudgetCap: 5.00 },
  normal:  { retries: 3, concurrency: 3, budgetScale: 1.0, label: '标准', goalMaxIter: 5, goalBudgetCap: 10.00 },
  deep:    { retries: 5, concurrency: 5, budgetScale: 2.0, label: '深度', goalMaxIter: 10, goalBudgetCap: 25.00 }
};

// 基础预算（USD），会乘以 budgetScale
const BASE_BUDGETS = {
  leader: 0.50,
  worker: 1.00,
  verifier: 0.30
};

// Prompt 缓存
const promptCache = {};

// 专家 Persona 目录
const AGENTS_DIR = resolve(__dirname, 'agents');
const SKILLS_DIR = resolve(__dirname, 'skills');
const PERSONAS_DIR = resolve(__dirname, 'personas');

export const CONFIG = {
  port: parseInt(process.env.MUSTER_PORT || '3456', 10),

  // Claude CLI 路径：环境变量 > PATH 查找
  claudeBin: process.env.CLAUDE_BIN || 'claude',

  // 当前复杂度（默认标准）
  complexity: 'normal',

  // 是否跳过 Claude 权限检查（默认关闭，需显式启用）
  skipPermissions: process.env.MUSTER_SKIP_PERMISSIONS === 'true',

  get preset() { return PRESETS[CONFIG.complexity]; },
  get maxRetries() { return CONFIG.preset.retries; },
  get maxConcurrency() { return CONFIG.preset.concurrency; },
  get agentTimeout() { return 10 * 60 * 1000; },  // 10 分钟

  get budgets() {
    const s = CONFIG.preset.budgetScale;
    return {
      leader: BASE_BUDGETS.leader * s,
      worker: BASE_BUDGETS.worker * s,
      verifier: BASE_BUDGETS.verifier * s
    };
  },

  // 模型按角色分配（用 Claude 的别名，自动映射到用户设置）
  models: {
    leader: 'opus',
    worker: 'sonnet',
    verifier: 'haiku'
  },

  prompts: {
    leader: resolve(__dirname, 'prompts/leader.md'),
    worker: resolve(__dirname, 'prompts/worker.md'),
    verifier: resolve(__dirname, 'prompts/verifier.md')
  },

  get baseFlags() {
    const flags = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence'
    ];
    if (CONFIG.skipPermissions) {
      flags.push('--dangerously-skip-permissions');
    }
    return flags;
  },

  // JSON Schema
  leaderIntentSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['ask', 'answer', 'execute'] },
      text: { type: 'string' },
      plan: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          subtasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                skill: { type: 'string', description: 'Optional skill name from catalog' },
                persona: { type: 'string', description: 'Optional persona name from catalog' }
              },
              required: ['title', 'description']
            }
          }
        }
      }
    },
    required: ['action', 'text']
  },

  verifierVerdictSchema: {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      feedback: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } }
    },
    required: ['approved', 'feedback']
  },

  goalEvaluatorSchema: {
    type: 'object',
    properties: {
      goalMet: { type: 'boolean' },
      confidence: { type: 'number' },
      reasoning: { type: 'string' },
      remainingIssues: { type: 'array', items: { type: 'string' } },
      suggestedActions: { type: 'array', items: { type: 'string' } }
    },
    required: ['goalMet', 'confidence', 'reasoning']
  }
};

export function loadPrompt(name) {
  if (!promptCache[name]) {
    promptCache[name] = readFileSync(CONFIG.prompts[name], 'utf-8');
  }
  return promptCache[name];
}

/**
 * 加载专家 Persona prompt（按需，不缓存以节省内存）
 * 先查本地 agents/，再查 personas/{domain}/
 */
export function loadPersona(name) {
  const localFile = join(AGENTS_DIR, `${name}.md`);
  if (existsSync(localFile)) return readFileSync(localFile, 'utf-8');
  if (existsSync(PERSONAS_DIR)) {
    const domainsFile = join(PERSONAS_DIR, 'domains.json');
    if (existsSync(domainsFile)) {
      const domains = JSON.parse(readFileSync(domainsFile, 'utf-8'));
      for (const domain of Object.keys(domains)) {
        const domainFile = join(PERSONAS_DIR, domain, `${name}.md`);
        if (existsSync(domainFile)) return readFileSync(domainFile, 'utf-8');
      }
    }
  }
  return null;
}

/**
 * 加载技能 prompt（按需）
 */
export function loadSkill(name) {
  const file = join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

/**
 * 列出可用的 Persona
 */
export function listPersonas() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md')
    .map(f => f.replace('.md', ''));
}

/**
 * 列出可用的技能
 */
export function listSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map(d => d.name);
}

export function setComplexity(level) {
  if (PRESETS[level]) CONFIG.complexity = level;
}

/**
 * 轻量技能目录：提取每个 SKILL.md 的 frontmatter description
 * 20 skills ≈ 200 tokens（而非加载全部文件 ≈ 5000 tokens）
 */
export function buildSkillCatalog() {
  const skills = listSkills();
  return skills.map(name => {
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    if (!existsSync(file)) return null;
    const content = readFileSync(file, 'utf-8');
    const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
    const desc = descMatch ? descMatch[1].trim() : '';
    return `${name}: ${desc}`;
  }).filter(Boolean).join('\n');
}

/**
 * 轻量角色目录：本地 persona + 外部域摘要
 */
export function buildPersonaCatalog() {
  const lines = [];
  // 本地 personas
  const personas = listPersonas();
  for (const name of personas) {
    const file = join(AGENTS_DIR, `${name}.md`);
    if (!existsSync(file)) { lines.push(name); continue; }
    const content = readFileSync(file, 'utf-8');
    const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
    lines.push(`${name}: ${descMatch ? descMatch[1].trim() : ''}`);
  }
  // 外部域摘要
  const domainsFile = join(PERSONAS_DIR, 'domains.json');
  if (existsSync(domainsFile)) {
    const domains = JSON.parse(readFileSync(domainsFile, 'utf-8'));
    for (const [domain, data] of Object.entries(domains)) {
      if (data.count > 0) {
        lines.push(`[${data.label} (${data.count})]: 可用角色详见 /api/persona-catalog?domain=${domain}`);
      }
    }
  }
  return lines.join('\n');
}
