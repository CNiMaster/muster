import { EventEmitter } from 'events';
import { CONFIG, loadPrompt, loadPersona, loadSkill, buildSkillCatalog, buildPersonaCatalog } from './config.js';
import { state } from './state.js';
import { spawnAgent } from './agent-runner.js';
import { tryParseJSON } from './utils.js';
import { BackupManager } from './backup.js';
import { scheduler } from './scheduler.js';

const MAX_HISTORY_CONTEXT = 20;
const CHAT_OUTPUT_LIMIT = 300;

class Orchestrator extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * 处理人类消息 —— 核心：Leader 判断意图（ask/answer/execute）
   */
  async handleHumanMessage(taskId, message) {
    const task = state.getTask(taskId);
    if (!task) throw new Error('Task not found');

    // 记录人类消息到群聊
    state.addChatMessage(taskId, { role: 'human', agentName: '你', text: message, type: 'chat' });
    task.conversationHistory.push({ role: 'human', content: message, timestamp: new Date().toISOString() });

    const chatPrompt = buildLeaderChatPrompt(task.conversationHistory, message, task);

    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: 'Leader 正在思考...', type: 'system' });

    try {
      const leaderSystemPrompt = loadPrompt('leader')
        .replace('[SKILL_CATALOG]', buildSkillCatalog())
        .replace('[PERSONA_CATALOG]', buildPersonaCatalog());
      const leaderResult = await spawnAgent({
        role: 'leader',
        prompt: chatPrompt,
        systemPrompt: leaderSystemPrompt,
        budget: CONFIG.budgets.leader,
        cwd: task.cwd,
        jsonSchema: CONFIG.leaderIntentSchema,
        emitter: this,
        sessionId: taskId
      });

      state.addCost(taskId, leaderResult.cost, leaderResult.usage, leaderResult.modelUsage);
      const intent = leaderResult.structuredOutput || tryParseJSON(leaderResult.text);

      if (!intent) {
        state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: leaderResult.text, type: 'chat' });
        task.conversationHistory.push({ role: 'leader', content: leaderResult.text, timestamp: new Date().toISOString() });
        return;
      }

      const action = intent.action || 'answer';

      if (action === 'ask' || action === 'answer') {
        state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: intent.text, type: action });
        task.conversationHistory.push({ role: 'leader', content: intent.text, timestamp: new Date().toISOString() });
      }

      if (action === 'execute' && intent.plan) {
        state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: intent.text, type: 'execute' });
        task.conversationHistory.push({ role: 'leader', content: intent.text, timestamp: new Date().toISOString() });

        if (task.goal) {
          this.runGoalLoop(taskId, intent.plan, task.goal).catch(err => {
            console.error('Goal loop error:', err);
            state.updateTask(taskId, { status: 'failed', result: err.message, completedAt: new Date().toISOString() });
            state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `Goal 循环失败: ${err.message}`, type: 'system' });
          });
        } else {
          this.runTask(taskId, intent.plan).catch(err => {
            console.error('Task execution error:', err);
            state.updateTask(taskId, { status: 'failed', result: err.message, completedAt: new Date().toISOString() });
            state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `任务失败: ${err.message}`, type: 'system' });
          });
        }
      }
    } catch (err) {
      state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `Leader 出错: ${err.message}`, type: 'system' });
    }
  }

  /**
   * 执行任务：Workers + Verifiers 并行对抗
   */
  async runTask(taskId, plan) {
    state.updateTask(taskId, { status: 'planning' });

    for (const st of plan.subtasks || []) {
      state.addSubtask(taskId, { title: st.title, description: st.description });
    }

    const task = state.getTask(taskId);
    const subtasks = task.subtasks;
    for (let i = 0; i < subtasks.length; i++) {
      state.addChatMessage(taskId, {
        role: 'leader', agentName: 'Leader',
        text: `📋 子任务 ${i + 1}: ${subtasks[i].title}`,
        type: 'system'
      });
    }

    state.updateTask(taskId, { status: 'executing' });
    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '🚀 任务开始执行', type: 'system' });

    const results = await this.runParallel(
      subtasks.map((st, i) => () => this.runSubtaskWithVerification(taskId, st, i)),
      CONFIG.maxConcurrency
    );

    state.updateTask(taskId, { status: 'completed' });

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    state.addChatMessage(taskId, {
      role: 'leader', agentName: 'Leader',
      text: `✅ 任务完成！${successCount} 个子任务成功，${failCount} 个失败。\n\n${results.map((r, i) => `${r.success ? '✅' : '❌'} ${subtasks[i].title}`).join('\n')}`,
      type: 'chat'
    });

    const aggPrompt = buildAggregationPrompt(task.conversationHistory.map(h => h.content).join('\n'), results, subtasks);
    const aggSystemPrompt = loadPrompt('leader')
      .replace('[SKILL_CATALOG]', buildSkillCatalog())
      .replace('[PERSONA_CATALOG]', buildPersonaCatalog());
    try {
      const aggResult = await spawnAgent({
        role: 'leader', prompt: aggPrompt, systemPrompt: aggSystemPrompt,
        budget: CONFIG.budgets.leader, cwd: task.cwd, emitter: this, sessionId: taskId
      });
      state.addCost(taskId, aggResult.cost, aggResult.usage, aggResult.modelUsage);
      state.updateTask(taskId, { result: aggResult.text, completedAt: new Date().toISOString() });
      state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: `📊 最终交付:\n\n${aggResult.text}`, type: 'chat' });
    } catch (err) {
      state.updateTask(taskId, { result: results.map((r, i) => `${subtasks[i].title}: ${r.output || r.error}`).join('\n'), completedAt: new Date().toISOString() });
    }
  }

  /**
   * Worker → Verifier 对抗循环
   */
  async runSubtaskWithVerification(taskId, subtask, index) {
    const workerName = `Worker#${index + 1}`;
    const verifierName = `Verifier#${index + 1}`;
    let lastFeedback = null;

    for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
      // --- Worker ---
      state.updateSubtask(taskId, subtask.id, { status: attempt === 0 ? 'running' : 'retrying' });
      state.addChatMessage(taskId, { role: 'system', agentName: workerName, text: attempt === 0 ? `🙋 认领: ${subtask.title}` : `🔄 重试 (${attempt + 1}/${CONFIG.maxRetries}): ${subtask.title}`, type: 'claim' });

      const workerPrompt = lastFeedback
        ? `${subtask.description}\n\n## 上次被拒绝\nVerifier 反馈:\n${lastFeedback}\n\n请修正并重新执行。`
        : subtask.description;

      const workerAttempt = { role: 'worker', workerName, status: 'running', output: '', cost: 0, startedAt: new Date().toISOString() };
      const attemptIdx = state.addAttempt(taskId, subtask.id, workerAttempt)
        ? state.getSubtask(taskId, subtask.id).attempts.length - 1 : 0;

      try {
        // 构建 Worker 的 system prompt（基础 + 专家技能叠加）
        let workerSystemPrompt = loadPrompt('worker');
        const personaOverride = subtask.persona ? loadPersona(subtask.persona) : null;
        const skillOverride = subtask.skill ? loadSkill(subtask.skill) : null;
        if (personaOverride) workerSystemPrompt += '\n\n' + personaOverride;
        if (skillOverride) workerSystemPrompt += '\n\n' + skillOverride;

        const workerResult = await spawnAgent({
          role: 'worker', prompt: workerPrompt, systemPrompt: workerSystemPrompt,
          budget: CONFIG.budgets.worker, cwd: state.getTask(taskId)?.cwd,
          emitter: this, sessionId: taskId, subtaskId: subtask.id
        });
        workerAttempt.status = 'success';
        workerAttempt.output = workerResult.text;
        workerAttempt.cost = workerResult.cost;
        workerAttempt.completedAt = new Date().toISOString();
        state.updateAttempt(taskId, subtask.id, attemptIdx, workerAttempt);
        state.addCost(taskId, workerResult.cost, workerResult.usage, workerResult.modelUsage);
        const preview = workerResult.text.length > CHAT_OUTPUT_LIMIT
          ? workerResult.text.slice(0, CHAT_OUTPUT_LIMIT) + `... (共 ${workerResult.text.length} 字符)`
          : workerResult.text;
        state.addChatMessage(taskId, { role: 'worker', agentName: workerName, text: `✅ 完成: ${subtask.title}\n${preview}`, type: 'chat' });
      } catch (err) {
        workerAttempt.status = 'failed';
        workerAttempt.output = err.message;
        workerAttempt.completedAt = new Date().toISOString();
        state.updateAttempt(taskId, subtask.id, attemptIdx, workerAttempt);

        // 检测限流错误，自动安排延迟重试
        if (isRateLimitError(err.message) && attempt === CONFIG.maxRetries - 1) {
          const delayMs = parseRetryDelay(err.message) || 2 * 60 * 60 * 1000;  // 默认 2 小时
          const job = scheduler.scheduleOnce({
            name: `重试: ${subtask.title}`,
            delayMs,
            reason: 'rate_limit',
            payload: { taskId, subtask, index },
            execute: () => this.runSubtaskWithVerification(taskId, subtask, index),
          });
          state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `⏰ 检测到限流，已安排 ${Math.round(delayMs / 60000)} 分钟后自动重试 (${job.id})`, type: 'system' });
          return { success: false, error: 'rate_limited', scheduledJobId: job.id, subtaskIndex: index };
        }

        state.addChatMessage(taskId, { role: 'worker', agentName: workerName, text: `❌ 执行出错: ${err.message}`, type: 'chat' });
        if (attempt === CONFIG.maxRetries - 1) {
          state.updateSubtask(taskId, subtask.id, { status: 'failed' });
          return { success: false, error: err.message, subtaskIndex: index };
        }
        continue;
      }

      // --- Verifier ---
      state.updateSubtask(taskId, subtask.id, { status: 'verifying' });
      state.addChatMessage(taskId, { role: 'system', agentName: verifierName, text: `🔍 验证 ${workerName} 的成果...`, type: 'system' });

      try {
        const verifierResult = await spawnAgent({
          role: 'verifier', prompt: `## 任务\n${subtask.title}\n${subtask.description}\n\n## Worker 提交\n${workerAttempt.output}`,
          systemPrompt: loadPrompt('verifier'),
          budget: CONFIG.budgets.verifier, cwd: state.getTask(taskId)?.cwd,
          jsonSchema: CONFIG.verifierVerdictSchema,
          emitter: this, sessionId: taskId, subtaskId: subtask.id
        });
        state.addCost(taskId, verifierResult.cost, verifierResult.usage, verifierResult.modelUsage);
        const verdict = verifierResult.structuredOutput || tryParseJSON(verifierResult.text);

        state.addAttempt(taskId, subtask.id, {
          role: 'verifier', verifierName,
          status: verdict?.approved ? 'approved' : 'rejected',
          output: verifierResult.text, cost: verifierResult.cost,
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
        });

        if (verdict?.approved) {
          state.addChatMessage(taskId, { role: 'verifier', agentName: verifierName, text: `✅ APPROVED: ${subtask.title}`, type: 'verdict' });
          state.updateSubtask(taskId, subtask.id, { status: 'completed', finalOutput: workerAttempt.output });
          return { success: true, output: workerAttempt.output, subtaskIndex: index, attempts: attempt + 1, verified: true };
        }

        lastFeedback = verdict?.feedback || verifierResult.text;
        state.addChatMessage(taskId, { role: 'verifier', agentName: verifierName, text: `❌ REJECTED: ${lastFeedback}`, type: 'verdict' });
      } catch (err) {
        // Verifier 出错 → 标记为未验证而非直接通过
        state.addChatMessage(taskId, { role: 'verifier', agentName: verifierName, text: `⚠️ Verifier 出错，跳过验证: ${err.message}`, type: 'system' });
        state.updateSubtask(taskId, subtask.id, { status: 'completed', finalOutput: workerAttempt.output });
        return { success: true, output: workerAttempt.output, subtaskIndex: index, attempts: attempt + 1, verified: false };
      }
    }

    state.updateSubtask(taskId, subtask.id, { status: 'failed' });
    return { success: false, error: 'Max retries', feedback: lastFeedback, subtaskIndex: index };
  }

  async runParallel(taskFns, concurrency) {
    const results = [];
    const executing = new Set();
    for (const fn of taskFns) {
      const p = fn().then(r => { executing.delete(p); return r; });
      executing.add(p);
      results.push(p);
      if (executing.size >= concurrency) await Promise.race(executing);
    }
    return Promise.all(results);
  }

  /**
   * Goal Mode：自治循环，直到目标达成或安全限制
   */
  async runGoalLoop(taskId, initialPlan, goal) {
    const maxIter = CONFIG.preset.goalMaxIter;
    const budgetCap = CONFIG.preset.goalBudgetCap;
    let currentPlan = initialPlan;

    for (let iteration = 0; iteration < maxIter; iteration++) {
      const task = state.getTask(taskId);

      if (task.totalCost >= budgetCap) {
        state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `Budget cap reached ($${budgetCap.toFixed(2)}). Goal loop stopped.`, type: 'system' });
        break;
      }

      state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `🎯 Goal iteration ${iteration + 1}/${maxIter}`, type: 'system' });

      // Execute current plan
      await this.runTask(taskId, currentPlan);
      const updatedTask = state.getTask(taskId);
      const subtaskResults = updatedTask.subtasks.map((st, i) => ({
        success: st.status === 'completed',
        output: st.finalOutput || '',
        subtaskIndex: i,
        title: st.title
      }));

      // Evaluate goal
      const verdict = await this.evaluateGoal(taskId, goal, subtaskResults);

      if (!verdict) {
        state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '评估员无法响应，Goal 循环停止。', type: 'system' });
        break;
      }

      state.addGoalIteration(taskId, iteration + 1, verdict, currentPlan, subtaskResults);

      if (verdict.goalMet && verdict.confidence >= 0.8) {
        state.updateTask(taskId, { status: 'completed' });
        state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: `🎯 Goal achieved! Confidence: ${(verdict.confidence * 100).toFixed(0)}%\n${verdict.reasoning}`, type: 'chat' });
        return;
      }

      state.addChatMessage(taskId, {
        role: 'system', agentName: '系统',
        text: `Goal not met (confidence: ${((verdict.confidence || 0) * 100).toFixed(0)}%). Remaining: ${verdict.remainingIssues?.join(', ') || 'see details'}`,
        type: 'system'
      });

      // Replan
      const replanResult = await this.replanForGoal(taskId, goal, { iteration: iteration + 1, verdict, subtaskResults });

      if (!replanResult || replanResult.action !== 'execute' || !replanResult.plan) {
        state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: replanResult?.text || 'Cannot create further plan. Goal loop stopped.', type: 'chat' });
        break;
      }

      currentPlan = replanResult.plan;
      state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: `🔄 Replanning: ${replanResult.text}`, type: 'execute' });

      // Reset subtasks for new iteration
      state.updateTask(taskId, { subtasks: [], status: 'chatting' });
    }

    state.updateTask(taskId, { status: 'completed' });
    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `Goal loop ended after ${state.getTask(taskId).goalIterations} iterations.`, type: 'system' });
  }

  /**
   * 评估 Goal 是否达成
   */
  async evaluateGoal(taskId, goal, subtaskResults) {
    const task = state.getTask(taskId);
    const resultsSummary = subtaskResults.map(r =>
      `${r.success ? 'PASS' : 'FAIL'}: ${r.title}\n${(r.output || '').slice(0, 500)}`
    ).join('\n\n');

    const evalPrompt = `## Goal Condition\n${goal}\n\n## Completed Work\n${resultsSummary}\n\nHas the goal been fully met?`;

    const result = await spawnAgent({
      role: 'verifier',
      prompt: evalPrompt,
      systemPrompt: loadPrompt('goal-evaluator'),
      budget: CONFIG.budgets.verifier,
      cwd: task.cwd,
      jsonSchema: CONFIG.goalEvaluatorSchema,
      emitter: this,
      sessionId: taskId
    });

    state.addCost(taskId, result.cost, result.usage, result.modelUsage);
    return result.structuredOutput || tryParseJSON(result.text);
  }

  /**
   * 根据 Goal 评估结果重新规划
   */
  async replanForGoal(taskId, goal, previousIteration) {
    const task = state.getTask(taskId);
    const replanPrompt = buildReplanPrompt(task.conversationHistory, goal, previousIteration);
    const leaderSystemPrompt = loadPrompt('leader')
      .replace('[SKILL_CATALOG]', buildSkillCatalog())
      .replace('[PERSONA_CATALOG]', buildPersonaCatalog());

    const result = await spawnAgent({
      role: 'leader',
      prompt: replanPrompt,
      systemPrompt: leaderSystemPrompt,
      budget: CONFIG.budgets.leader,
      cwd: task.cwd,
      jsonSchema: CONFIG.leaderIntentSchema,
      emitter: this,
      sessionId: taskId
    });

    state.addCost(taskId, result.cost, result.usage, result.modelUsage);
    return result.structuredOutput || tryParseJSON(result.text);
  }
}

function buildLeaderChatPrompt(history, newMessage, task) {
  const historyStr = history.slice(-MAX_HISTORY_CONTEXT).map(h =>
    `${h.role === 'human' ? '老板' : 'Leader'}: ${h.content}`
  ).join('\n');

  return `## 对话历史\n${historyStr}\n\n## 老板的新消息\n${newMessage}\n\n## 当前工作目录\n${task.cwd}\n\n请判断老板的意图并回复。如果是任务且信息充分，返回 execute；如果不清楚，返回 ask；如果只是闲聊或提问，返回 answer。`;
}

function buildAggregationPrompt(goal, results, subtasks) {
  const parts = results.map((r, i) =>
    `${r.success ? '✅' : '❌'} ${subtasks[i].title}${r.verified === false ? ' (未验证)' : ''}\n${r.output || r.error || '无输出'}`
  ).join('\n\n');
  return `## 原始目标\n${goal}\n\n## 各子任务结果\n\n${parts}\n\n请将以上结果聚合为一份完整的最终交付物。`;
}

function isRateLimitError(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes('rate') || lower.includes('limit') || lower.includes('429') || lower.includes('quota') || lower.includes('overloaded');
}

function parseRetryDelay(msg) {
  const match = msg.match(/(\d+)\s*(?:minute|min|second|sec|hour)/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  if (/hour/i.test(msg)) return n * 3600000;
  if (/minute|min/i.test(msg)) return n * 60000;
  if (/second|sec/i.test(msg)) return n * 1000;
  return null;
}

function buildReplanPrompt(history, goal, previousIteration) {
  const historyStr = history.slice(-MAX_HISTORY_CONTEXT).map(h =>
    `${h.role === 'human' ? '老板' : 'Leader'}: ${h.content}`
  ).join('\n');

  return `## 对话历史\n${historyStr}\n\n## Goal Condition\n${goal}\n\n## Previous Attempt\nIteration: ${previousIteration.iteration}\nEvaluator verdict: ${previousIteration.verdict.goalMet ? 'MET' : 'NOT MET'}\nReasoning: ${previousIteration.verdict.reasoning}\nRemaining issues: ${previousIteration.verdict.remainingIssues?.join('; ') || 'none listed'}\nSuggested actions: ${previousIteration.verdict.suggestedActions?.join('; ') || 'none listed'}\n\nResults:\n${previousIteration.subtaskResults.map((r, i) => `${r.success ? 'PASS' : 'FAIL'}: ${r.title || 'Subtask ' + (i + 1)}`).join('\n')}\n\nThe goal was NOT met. Create a NEW plan focusing on the remaining issues. Do NOT repeat the same approach that failed.`;
}

export const orchestrator = new Orchestrator();
