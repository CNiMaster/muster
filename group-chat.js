import { EventEmitter } from 'events';
import { CONFIG, loadPersona, buildPersonaCatalog } from './config.js';
import { state } from './state.js';
import { spawnAgent } from './agent-runner.js';
import { tryParseJSON } from './utils.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = resolve(__dirname, 'personas');

const GC_CONFIG = {
  maxExperts: 4,
  maxSpeakersPerRound: 2,
  minDelay: 500,
  maxDelay: 1500,
  responseMaxChars: 300,
  historyWindow: 8,
  routerModel: 'sonnet'
};

const EXPERT_COLORS = ['#4f8ff7', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6'];

export class GroupChat extends EventEmitter {
  constructor() { super(); }

  async handleMessage(taskId, message) {
    const task = state.getTask(taskId);
    if (!task) throw new Error('Task not found');

    state.addChatMessage(taskId, { role: 'human', agentName: '你', text: message, type: 'chat' });
    task.conversationHistory.push({ role: 'human', content: message, timestamp: new Date().toISOString() });

    try {
      // 如果还没有专家 → 先选专家
      if (!task.experts || task.experts.length === 0) {
        await this._selectExperts(taskId, message);
      }

      // 路由：决定谁该说话
      const speakers = await this._route(taskId, message);

      if (!speakers || speakers.length === 0) {
        state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '（群聊暂时无人回应）', type: 'system' });
        return;
      }

      // 逐一发言，带间隔
      for (const speaker of speakers) {
        await this._expertSpeak(taskId, speaker, message);
        if (speakers.indexOf(speaker) < speakers.length - 1) {
          const delay = GC_CONFIG.minDelay + Math.random() * (GC_CONFIG.maxDelay - GC_CONFIG.minDelay);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    } catch (err) {
      console.error(`[group-chat] Error for task ${taskId}:`, err.message);
      state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `群聊出错: ${err.message}`, type: 'error' });
    }
  }

  async _selectExperts(taskId, userMessage) {
    const task = state.getTask(taskId);

    // 构建精简的 persona 索引
    const personaIndex = this._buildPersonaIndex();

    const routerPrompt = `## 任务
分析用户的消息，从以下专家库中选出 ${GC_CONFIG.maxExperts} 位最相关的专家组成群聊小组。

## 专家库
${personaIndex}

## 用户消息
${userMessage}

## 工作目录
${task.cwd}

## 输出格式（严格 JSON）
{
  "experts": [
    { "name": "专家文件名（不含.md）", "display_name": "中文显示名", "reason": "选择理由" }
  ]
}

只输出 JSON，不要解释。选择不同领域的专家以获得多元视角。`;

    const routerSystem = '你是一个群聊组建助手。你的唯一任务是根据用户话题选择最合适的专家组合。只输出 JSON。';

    const schema = {
      type: 'object',
      properties: {
        experts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              display_name: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['name', 'display_name']
          }
        }
      },
      required: ['experts']
    };

    const result = await spawnAgent({
      role: 'leader', prompt: routerPrompt, systemPrompt: routerSystem,
      model: GC_CONFIG.routerModel, cwd: task.cwd,
      jsonSchema: schema, emitter: this, sessionId: taskId
    });

    state.addCost(taskId, result.cost, result.usage, result.modelUsage);
    const parsed = result.structuredOutput || tryParseJSON(result.text);
    if (!parsed?.experts?.length) {
      // fallback: 选默认 2 个
      parsed.experts = [
        { name: 'engineering-senior-developer', display_name: '资深开发者' },
        { name: 'product-product-manager', display_name: '产品经理' }
      ];
    }

    const experts = parsed.experts.slice(0, GC_CONFIG.maxExperts).map((e, i) => ({
      id: `expert-${i}`,
      name: e.name,
      displayName: e.display_name || e.name,
      color: EXPERT_COLORS[i % EXPERT_COLORS.length],
      emoji: this._extractEmoji(e.name),
      status: 'idle'
    }));

    state.updateTask(taskId, { experts });
    const names = experts.map(e => e.displayName).join('、');
    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `👥 已邀请 ${names} 加入群聊`, type: 'system' });
  }

  async _route(taskId, userMessage) {
    const task = state.getTask(taskId);
    const experts = task.experts || [];
    if (!experts.length) return [];

    const recentMsgs = state.getChatMessages(taskId).slice(-GC_CONFIG.historyWindow);
    const historyStr = recentMsgs.map(m => `${m.agentName}: ${m.text?.slice(0, 80) || ''}`).join('\n');

    const expertList = experts.map(e => `- ${e.displayName} (${e.name})`).join('\n');

    const routerPrompt = `## 群聊成员
${expertList}

## 最近对话
${historyStr}

## 用户最新消息
${userMessage}

## 任务
判断哪些成员应该回复这条消息。不是所有人都需要说话，只有话题相关的人回应。可以没人回应。
输出 JSON：{ "speakers": ["displayName1", "displayName2"] }
最多 ${GC_CONFIG.maxSpeakersPerRound} 人。可以为空数组 []。`;

    const routerSystem = '你是群聊主持人。判断谁该说话。只输出 JSON。';

    const schema = {
      type: 'object',
      properties: {
        speakers: { type: 'array', items: { type: 'string' } }
      },
      required: ['speakers']
    };

    const result = await spawnAgent({
      role: 'leader', prompt: routerPrompt, systemPrompt: routerSystem,
      model: GC_CONFIG.routerModel, cwd: task.cwd,
      jsonSchema: schema, emitter: this, sessionId: taskId
    });

    state.addCost(taskId, result.cost, result.usage, result.modelUsage);
    const parsed = result.structuredOutput || tryParseJSON(result.text);

    if (!parsed?.speakers?.length) return [];

    // 匹配 speaker 名到专家，随机化顺序
    const matched = parsed.speakers
      .map(name => experts.find(e => e.displayName === name || e.name === name))
      .filter(Boolean)
      .slice(0, GC_CONFIG.maxSpeakersPerRound);

    // 随机抖动顺序
    for (let i = matched.length - 1; i > 0; i--) {
      if (Math.random() < 0.3) {
        [matched[i], matched[i - 1]] = [matched[i - 1], matched[i]];
      }
    }

    return matched;
  }

  async _expertSpeak(taskId, expert, userMessage) {
    const task = state.getTask(taskId);

    // 加载 persona
    const personaContent = loadPersona(expert.name);

    // 构建上下文
    const recentMsgs = state.getChatMessages(taskId).slice(-GC_CONFIG.historyWindow);
    const contextStr = recentMsgs.map(m => `${m.agentName}: ${m.text?.slice(0, 100) || ''}`).join('\n');

    const speakPrompt = `## 群聊上下文
${contextStr}

## 用户最新消息
${userMessage}

## 你的身份
你是${expert.displayName}。${personaContent ? `\n${personaContent.slice(0, 1500)}` : ''}

## 规则
- 从你的专业视角简短回应（不超过 ${GC_CONFIG.responseMaxChars} 字）
- 语气自然，像群聊发言，不要标题、不要列表、不要 markdown
- 可以同意、反对或补充其他人的观点
- 如果没什么要补充的，就别说`;

    const speakSystem = `你是${expert.displayName}，群聊成员。用简短的中文发言，像在微信群里一样自然。不要超过${GC_CONFIG.responseMaxChars}字。`;

    // 更新状态为 thinking
    state.updateTask(taskId, {
      experts: task.experts.map(e => e.id === expert.id ? { ...e, status: 'thinking' } : e)
    });

    try {
      const result = await spawnAgent({
        role: 'worker', prompt: speakPrompt, systemPrompt: speakSystem,
        model: 'sonnet', cwd: task.cwd,
        emitter: this, sessionId: taskId
      });

      state.addCost(taskId, result.cost, result.usage, result.modelUsage);

      const text = (result.text || '').slice(0, GC_CONFIG.responseMaxChars);
      state.addChatMessage(taskId, {
        role: 'expert',
        agentName: expert.displayName,
        text,
        type: 'chat'
      });
    } catch (err) {
      state.addChatMessage(taskId, {
        role: 'expert',
        agentName: expert.displayName,
        text: `（发言失败: ${err.message.slice(0, 50)}）`,
        type: 'chat'
      });
    }

    // 恢复 idle
    state.updateTask(taskId, {
      experts: state.getTask(taskId).experts.map(e => e.id === expert.id ? { ...e, status: 'idle' } : e)
    });
  }

  /**
   * 从 Chat 切换到 Agent 模式：总结聊天成果
   */
  async summarizeForAgent(taskId) {
    const task = state.getTask(taskId);
    const msgs = state.getChatMessages(taskId);
    const expertMsgs = msgs.filter(m => m.role === 'expert');
    const humanMsgs = msgs.filter(m => m.role === 'human');

    if (!expertMsgs.length) {
      // 没有群聊成果，直接用用户的最后一条消息
      return humanMsgs.length > 0 ? humanMsgs[humanMsgs.length - 1].text : null;
    }

    const summaryPrompt = `## 群聊讨论记录
${msgs.filter(m => m.role === 'human' || m.role === 'expert').map(m => `${m.agentName}: ${m.text}`).join('\n')}

## 任务
请将以上群聊讨论总结为一段简洁的任务描述，包括：
1. 用户的核心需求
2. 专家们达成的共识
3. 关键建议和约束
4. 建议的执行方向

输出一段话，不要列表。`;

    const result = await spawnAgent({
      role: 'leader', prompt: summaryPrompt, systemPrompt: '你是任务总结助手。输出简洁的任务描述。',
      model: 'sonnet', cwd: task.cwd, emitter: this, sessionId: taskId
    });

    state.addCost(taskId, result.cost, result.usage, result.modelUsage);
    return result.text;
  }

  /**
   * 从 Agent 切回 Chat：无需特殊处理，直接恢复
   */
  switchToChat(taskId) {
    state.updateTask(taskId, { mode: 'groupchat', status: 'chatting' });
    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '💬 已切换到群聊模式', type: 'system' });
  }

  _buildPersonaIndex() {
    const lines = [];
    try {
      const domainsFile = join(PERSONAS_DIR, 'domains.json');
      if (existsSync(domainsFile)) {
        const domains = JSON.parse(readFileSync(domainsFile, 'utf-8'));
        for (const [domain, data] of Object.entries(domains)) {
          if (data.count > 0) {
            const sample = (data.personas || []).slice(0, 5).join(', ');
            lines.push(`[${data.label || domain} (${data.count})]: ${sample}${data.personas?.length > 5 ? ' ...' : ''}`);
          }
        }
      }
    } catch {}
    // 也加上 agents/ 本地的
    try {
      const agentsDir = resolve(__dirname, 'agents');
      if (existsSync(agentsDir)) {
        for (const f of readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md')) {
          const name = f.replace('.md', '');
          const content = readFileSync(join(agentsDir, f), 'utf-8');
          const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
          lines.push(`${name}: ${descMatch ? descMatch[1].trim() : name}`);
        }
      }
    } catch {}
    return lines.join('\n');
  }

  _extractEmoji(name) {
    const emojiMap = {
      'engineering': '⚙️', 'marketing': '📢', 'product': '🎯', 'security': '🔒',
      'qa': '🧪', 'data': '📊', 'design': '🎨', 'backend': '🖥️',
      'frontend': '🌐', 'devops': '🚀', 'specialized': '🔬',
      'code-reviewer': '👀', 'security-auditor': '🛡️', 'test-engineer': '🧪'
    };
    for (const [key, emoji] of Object.entries(emojiMap)) {
      if (name.includes(key)) return emoji;
    }
    return '💡';
  }
}

export const groupChat = new GroupChat();
