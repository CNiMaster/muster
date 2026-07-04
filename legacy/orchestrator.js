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
    this._collectedTools = new Map();
    this.on('agent:tool', (data) => {
      if (!data.subtaskId) return;
      if (!this._collectedTools.has(data.subtaskId)) this._collectedTools.set(data.subtaskId, []);
      const list = this._collectedTools.get(data.subtaskId);
      list.push({ tool: data.tool, input: data.input, role: data.role, time: new Date().toISOString() });
    });
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
        model: task.leaderModel || CONFIG.models.leader,
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
      const detail = err.message || '未知错误';
      console.error(`[orchestrator] Leader error for task ${taskId}:`, detail);
      state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `Leader 出错: ${detail}`, type: 'error' });
    }
  }

  /**
   * 执行任务：Workers + Verifiers 并行对抗
   */
  async runTask(taskId, plan) {
    state.updateTask(taskId, { status: 'planning' });

    for (const st of plan.subtasks || []) {
      state.addSubtask(taskId, {
        title: st.title,
        description: st.description,
        files: st.files || [],
        workerModel: st.model || 'sonnet',
        persona: st.persona || null,
        skill: st.skill || null,
        dependsOn: st.depends_on || []
      });
    }

    const task = state.getTask(taskId);
    const subtasks = task.subtasks;

    // 文件重叠检测：如果两个子任务共享文件但没有设置依赖，自动补充
    for (let i = 0; i < subtasks.length; i++) {
      for (let j = i + 1; j < subtasks.length; j++) {
        const filesA = new Set((subtasks[i].files || []).map(f => f.toLowerCase()));
        const filesB = new Set((subtasks[j].files || []).map(f => f.toLowerCase()));
        const overlap = [...filesA].filter(f => filesB.has(f));
        if (overlap.length === 0) continue;
        // 检查是否已经有任一方向的依赖，避免循环
        const iDependsOnJ = (subtasks[i].dependsOn || []).includes(j);
        const jDependsOnI = (subtasks[j].dependsOn || []).includes(i);
        if (iDependsOnJ || jDependsOnI) continue;
        // 默认让索引大的依赖索引小的（保持顺序一致）
        subtasks[j].dependsOn = [...(subtasks[j].dependsOn || []), i];
        console.warn(`[orchestrator] Auto-dep: ${subtasks[j].title} → ${subtasks[i].title} (shared: ${overlap.join(', ')})`);
        state.addChatMessage(taskId, {
          role: 'system', agentName: '系统',
          text: `🔗 自动依赖: "${subtasks[j].title}" → "${subtasks[i].title}"（共享文件: ${overlap.join(', ')}）`,
          type: 'system'
        });
      }
    }

    for (let i = 0; i < subtasks.length; i++) {
      const st = subtasks[i];
      const modelTag = st.workerModel !== 'sonnet' ? ` (${st.workerModel})` : '';
      const personaTag = st.persona ? ` [${st.persona}]` : '';
      state.addChatMessage(taskId, {
        role: 'leader', agentName: 'Leader',
        text: `📋 子任务 ${i + 1}: ${st.title}${modelTag}${personaTag}`,
        type: 'system'
      });
    }

    state.updateTask(taskId, { status: 'executing' });
    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '🚀 任务开始执行', type: 'system' });

    // Schedule with depends_on awareness: run independent tasks in parallel,
    // wait for dependencies before starting dependent tasks
    const results = await this.runWithDependencies(
      taskId, subtasks,
      (st, i) => this.runSubtaskWithVerification(taskId, st, i),
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
        model: task.leaderModel || CONFIG.models.leader,
        cwd: task.cwd, emitter: this, sessionId: taskId
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
    let lastError = null;
    let lastWorkerOutput = '';  // 保留上次 worker 的工作成果

    for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
      // --- Worker ---
      const baseModel = subtask.workerModel || 'sonnet';
      const currentModel = attempt > 0 ? 'opus' : baseModel;  // 重试时升级到 opus
      const modelTag = currentModel !== baseModel ? ` (${currentModel} 升级)` : '';

      state.updateSubtask(taskId, subtask.id, { status: attempt === 0 ? 'running' : 'retrying' });

      // 渐进式重试策略
      let workerPrompt;
      if (attempt === 0) {
        workerPrompt = subtask.description;
        state.addChatMessage(taskId, { role: 'system', agentName: workerName, text: `🙋 认领: ${subtask.title} [${currentModel}]`, type: 'claim' });
      } else {
        const allAttempts = state.getSubtask(taskId, subtask.id)?.attempts || [];

        if (attempt === 1) {
          // 第 1 次重试：Worker 自我反思，从失败点继续
          state.addChatMessage(taskId, { role: 'system', agentName: workerName, text: `🔄 自我反思重试 (${attempt + 1}/${CONFIG.maxRetries}): ${subtask.title}${modelTag}`, type: 'claim' });
          workerPrompt = buildSelfReflectPrompt(subtask, allAttempts, lastWorkerOutput, lastError, lastFeedback);
        } else if (attempt === 2) {
          // 第 2 次重试：请求 Leader 分析后指导
          state.addChatMessage(taskId, { role: 'system', agentName: workerName, text: `🔄 Leader 指导重试 (${attempt + 1}/${CONFIG.maxRetries}): ${subtask.title}${modelTag}`, type: 'claim' });
          const leaderDiagnosis = await this.requestLeaderDiagnosis(taskId, subtask, allAttempts, lastError, lastFeedback);
          workerPrompt = buildLeaderGuidedPrompt(subtask, allAttempts, lastWorkerOutput, leaderDiagnosis);
        } else {
          // 第 3 次及以上：通知 Leader，等待用户指示
          state.addChatMessage(taskId, { role: 'system', agentName: workerName, text: `⚠️ ${attempt} 次重试仍失败，请求 Leader 介入`, type: 'system' });
          await this.notifyLeaderAndWaitForUser(taskId, subtask, allAttempts, lastError, lastFeedback);
          state.updateSubtask(taskId, subtask.id, { status: 'failed' });
          return { success: false, error: lastError || lastFeedback || '多次重试失败', feedback: lastFeedback, subtaskIndex: index, needsUserIntervention: true };
        }
      }

      const workerAttempt = { role: 'worker', workerName, status: 'running', output: '', cost: 0, startedAt: new Date().toISOString() };

      // 首次尝试前自动备份涉及文件
      if (attempt === 0 && subtask.files?.length > 0) {
        try {
          const cwd = state.getTask(taskId)?.cwd;
          if (cwd) {
            const bm = new BackupManager(cwd);
            await bm.createBackup(subtask.files, `pre-work: ${subtask.title}`);
          }
        } catch (e) { console.warn('[orchestrator] Backup skipped:', e.message); }
      }
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
          model: currentModel,
          cwd: state.getTask(taskId)?.cwd,
          emitter: this, sessionId: taskId, subtaskId: subtask.id
        });
        workerAttempt.tools = this._collectedTools.get(subtask.id) || [];
        this._collectedTools.delete(subtask.id);
        workerAttempt.status = workerResult.timedOut || workerResult.toolLimited ? 'partial' : 'success';
        workerAttempt.output = workerResult.text;
        workerAttempt.cost = workerResult.cost;
        workerAttempt.completedAt = new Date().toISOString();
        lastWorkerOutput = workerResult.text;  // 保留工作成果
        state.updateAttempt(taskId, subtask.id, attemptIdx, workerAttempt);
        state.addCost(taskId, workerResult.cost, workerResult.usage, workerResult.modelUsage);
        const preview = workerResult.text.length > CHAT_OUTPUT_LIMIT
          ? workerResult.text.slice(0, CHAT_OUTPUT_LIMIT) + `... (共 ${workerResult.text.length} 字符)`
          : workerResult.text;
        const statusIcon = workerResult.timedOut ? '⏱️ 超时(部分完成)' : workerResult.toolLimited ? '⚡ 工具限制(部分完成)' : '✅ 完成';
        state.addChatMessage(taskId, { role: 'worker', agentName: workerName, text: `${statusIcon}: ${subtask.title}\n${preview}`, type: 'chat' });
      } catch (err) {
        lastError = err.message;
        workerAttempt.errorCategory = categorizeError(err.message);
        workerAttempt.status = 'failed';
        workerAttempt.output = err.message;
        workerAttempt.completedAt = new Date().toISOString();
        state.updateAttempt(taskId, subtask.id, attemptIdx, workerAttempt);

        // 检测限流错误，自动安排延迟重试
        if (isRateLimitError(err.message) && attempt === CONFIG.maxRetries - 1) {
          const delayMs = parseRetryDelay(err.message) || 2 * 60 * 60 * 1000;
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
          // 最后一次重试也失败，通知 Leader 请求用户介入
          const allAttempts = state.getSubtask(taskId, subtask.id)?.attempts || [];
          await this.notifyLeaderAndWaitForUser(taskId, subtask, allAttempts, lastError, lastFeedback);
          state.updateSubtask(taskId, subtask.id, { status: 'failed' });
          return { success: false, error: err.message, subtaskIndex: index, needsUserIntervention: true };
        }
        continue;
      }

      // --- Verifier ---
      if (workerAttempt.status === 'partial') {
        state.addChatMessage(taskId, { role: 'system', agentName: verifierName, text: `⚠️ 跳过验证 (部分完成): ${subtask.title}`, type: 'system' });
        state.updateSubtask(taskId, subtask.id, { status: 'completed', finalOutput: workerAttempt.output });
        return { success: true, output: workerAttempt.output, subtaskIndex: index, attempts: attempt + 1, verified: false };
      }

      state.updateSubtask(taskId, subtask.id, { status: 'verifying' });
      state.addChatMessage(taskId, { role: 'system', agentName: verifierName, text: `🔍 验证 ${workerName} 的成果...`, type: 'system' });

      try {
        const verifierModel = attempt > 0
          ? (CONFIG.verifierEscalationModel || 'sonnet')
          : CONFIG.models.verifier;

        const verifierResult = await spawnAgent({
          role: 'verifier', prompt: `## 任务\n${subtask.title}\n${subtask.description}\n\n## Worker 提交\n${workerAttempt.output}`,
          systemPrompt: loadPrompt('verifier'),
          cwd: state.getTask(taskId)?.cwd,
          model: verifierModel,
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
        // 保存 verifier 反馈到 worker attempt
        const wAttempts = state.getSubtask(taskId, subtask.id)?.attempts?.filter(a => a.role === 'worker') || [];
        const lastWAttempt = wAttempts[wAttempts.length - 1];
        if (lastWAttempt) {
          lastWAttempt.verifierFeedback = verdict?.feedback || verifierResult.text;
          lastWAttempt.verifierIssues = verdict?.issues || [];
        }
        state.addChatMessage(taskId, { role: 'verifier', agentName: verifierName, text: `❌ REJECTED: ${lastFeedback}`, type: 'verdict' });
      } catch (err) {
        state.addChatMessage(taskId, { role: 'verifier', agentName: verifierName, text: `⚠️ Verifier 出错，跳过验证: ${err.message}`, type: 'system' });
        state.updateSubtask(taskId, subtask.id, { status: 'completed', finalOutput: workerAttempt.output });
        return { success: true, output: workerAttempt.output, subtaskIndex: index, attempts: attempt + 1, verified: false };
      }
    }

    // 所有重试用尽（Verifier 一直拒绝的情况）
    state.updateSubtask(taskId, subtask.id, { status: 'failed' });
    const allAttempts = state.getSubtask(taskId, subtask.id)?.attempts || [];
    await this.notifyLeaderAndWaitForUser(taskId, subtask, allAttempts, lastError, lastFeedback);
    return { success: false, error: 'Max retries', feedback: lastFeedback, subtaskIndex: index, needsUserIntervention: true };
  }

  /**
   * 第 1 次重试：请求 Leader 分析失败原因
   */
  async requestLeaderDiagnosis(taskId, subtask, allAttempts, lastError, lastFeedback) {
    const workerAttempts = allAttempts.filter(a => a.role === 'worker');
    const latestAttempt = workerAttempts[workerAttempts.length - 1];

    const diagPrompt = `## 子任务失败分析\n\n任务: ${subtask.title}\n描述: ${subtask.description.slice(0, 500)}\n\n` +
      `已尝试 ${workerAttempts.length} 次。\n` +
      `最近错误: ${(lastError || '无').slice(0, 300)}\n` +
      `Verifier 反馈: ${(lastFeedback || '无').slice(0, 300)}\n` +
      `Worker 已完成的工作摘要: ${(latestAttempt?.output || '无').slice(0, 500)}\n\n` +
      `请分析失败根因，给出具体的修正建议。告诉 Worker 应该：\n1. 保留哪些已完成的工作\n2. 从哪里继续\n3. 具体用什么不同方法\n\n用简洁的一段话回答。`;

    try {
      const leaderSystemPrompt = loadPrompt('leader')
        .replace('[SKILL_CATALOG]', buildSkillCatalog())
        .replace('[PERSONA_CATALOG]', buildPersonaCatalog());
      const result = await spawnAgent({
        role: 'leader', prompt: diagPrompt, systemPrompt: leaderSystemPrompt,
        model: 'opus',
        cwd: state.getTask(taskId)?.cwd, emitter: this, sessionId: taskId
      });
      state.addCost(taskId, result.cost, result.usage, result.modelUsage);
      state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: `🔍 失败诊断: ${result.text.slice(0, 300)}`, type: 'system' });
      return result.text;
    } catch {
      state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '⚠️ Leader 诊断失败，Worker 将自行分析重试', type: 'system' });
      return null;
    }
  }

  /**
   * 所有重试失败后：通知 Leader → 通知用户，等待指示
   */
  async notifyLeaderAndWaitForUser(taskId, subtask, allAttempts, lastError, lastFeedback) {
    const workerAttempts = allAttempts.filter(a => a.role === 'worker');
    const failSummary = `## 子任务需要您介入\n\n任务: ${subtask.title}\n描述: ${subtask.description.slice(0, 300)}\n\n` +
      `已尝试 ${workerAttempts.length} 次，均未成功。\n` +
      `${lastError ? `错误: ${lastError.slice(0, 200)}\n` : ''}` +
      `${lastFeedback ? `验证反馈: ${lastFeedback.slice(0, 200)}\n` : ''}` +
      `\n已完成的工作:\n${(workerAttempts[workerAttempts.length - 1]?.output || '无').slice(0, 500)}\n\n` +
      `请简要告诉老板失败原因，并询问是否需要：\n1. 提供更多信息/提示后继续\n2. 跳过此任务，继续其他任务\n3. 简化任务范围后重试`;

    try {
      const leaderSystemPrompt = loadPrompt('leader')
        .replace('[SKILL_CATALOG]', buildSkillCatalog())
        .replace('[PERSONA_CATALOG]', buildPersonaCatalog());
      const analysis = await spawnAgent({
        role: 'leader', prompt: failSummary, systemPrompt: leaderSystemPrompt,
        model: 'opus',
        cwd: state.getTask(taskId)?.cwd, emitter: this, sessionId: taskId
      });
      state.addCost(taskId, analysis.cost, analysis.usage, analysis.modelUsage);
      state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: `🛑 需要您的决定: ${analysis.text}`, type: 'chat' });
    } catch {
      state.addChatMessage(taskId, { role: 'system', agentName: '系统',
        text: `🛑 子任务 "${subtask.title}" 多次重试失败，请查看详情后决定下一步操作。`, type: 'system' });
    }
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
   * Run subtasks respecting depends_on: parallel for independent, sequential for dependent
   */
  async runWithDependencies(taskId, subtasks, runFn, concurrency) {
    const results = new Array(subtasks.length).fill(null);
    const completed = new Set();

    // Find which subtasks are ready (all deps completed)
    const getReady = () => subtasks.map((st, i) => {
      if (completed.has(i) || results[i]) return -1;
      const deps = st.dependsOn || [];
      return deps.every(d => completed.has(d)) ? i : -1;
    }).filter(i => i >= 0);

    const executing = new Map();  // index → promise

    while (completed.size < subtasks.length) {
      // Find ready tasks not already running
      const ready = getReady().filter(i => !executing.has(i));

      for (const i of ready) {
        if (executing.size >= concurrency) break;
        const p = runFn(subtasks[i], i).then(r => {
          executing.delete(i);
          results[i] = r;
          completed.add(i);
          return r;
        });
        executing.set(i, p);
      }

      if (executing.size === 0 && completed.size < subtasks.length) {
        // Deadlock: all remaining tasks have unresolved deps
        state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: '⚠️ 任务依赖检测到死锁，强制执行剩余任务', type: 'system' });
        for (let i = 0; i < subtasks.length; i++) {
          if (!results[i] && !executing.has(i)) {
            const p = runFn(subtasks[i], i).then(r => { executing.delete(i); results[i] = r; completed.add(i); return r; });
            executing.set(i, p);
          }
        }
      }

      if (executing.size > 0) await Promise.race(executing.values());
    }

    return results;
  }

  /**
   * Goal Mode：自治循环，直到目标达成或安全限制
   */
  async runGoalLoop(taskId, initialPlan, goal) {
    const maxIter = CONFIG.preset.goalMaxIter;
    let currentPlan = initialPlan;
    const planSignatures = [computePlanSignature(initialPlan)];
    let consecutiveSimilarPlans = 0;
    const planHistory = [initialPlan];

    for (let iteration = 0; iteration < maxIter; iteration++) {
      const task = state.getTask(taskId);

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
      const replanResult = await this.replanForGoal(taskId, goal, { iteration: iteration + 1, verdict, subtaskResults }, planHistory, consecutiveSimilarPlans >= 2);

      if (!replanResult || replanResult.action !== 'execute' || !replanResult.plan) {
        state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: replanResult?.text || 'Cannot create further plan. Goal loop stopped.', type: 'chat' });
        break;
      }

      currentPlan = replanResult.plan;
      // 死循环检测
      const newSig = computePlanSignature(replanResult.plan);
      planSignatures.push(newSig);
      planHistory.push(replanResult.plan);

      let maxSimilarity = 0;
      for (const prevSig of planSignatures.slice(0, -1)) {
        maxSimilarity = Math.max(maxSimilarity, planSimilarity(newSig, prevSig));
      }
      if (maxSimilarity > 0.7) {
        consecutiveSimilarPlans++;
        if (consecutiveSimilarPlans >= 2) {
          state.addChatMessage(taskId, { role: 'system', agentName: '系统',
            text: `⚠️ 检测到重复方案 (${Math.round(maxSimilarity * 100)}% 相似)，强制要求全新策略`, type: 'system' });
        }
      } else {
        consecutiveSimilarPlans = 0;
      }

      state.addChatMessage(taskId, { role: 'leader', agentName: 'Leader', text: `🔄 Replanning: ${replanResult.text}`, type: 'execute' });

      // Reset subtasks for new iteration
      state.updateTask(taskId, { subtasks: [], status: 'chatting' });
    }

    state.updateTask(taskId, { status: 'failed' });
    state.addChatMessage(taskId, { role: 'system', agentName: '系统', text: `Goal loop exhausted after ${state.getTask(taskId).goalIterations} iterations — goal NOT achieved.`, type: 'system' });
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
  async replanForGoal(taskId, goal, previousIteration, planHistory, deadLoopDetected) {
    const task = state.getTask(taskId);
    const replanPrompt = buildReplanPrompt(task.conversationHistory, goal, previousIteration, planHistory, deadLoopDetected);
    const leaderSystemPrompt = loadPrompt('leader')
      .replace('[SKILL_CATALOG]', buildSkillCatalog())
      .replace('[PERSONA_CATALOG]', buildPersonaCatalog());

    const result = await spawnAgent({
      role: 'leader',
      prompt: replanPrompt,
      systemPrompt: leaderSystemPrompt,
      model: task.leaderModel || CONFIG.models.leader,
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

function buildReplanPrompt(history, goal, previousIteration, planHistory, deadLoopDetected) {
  const historyStr = history.slice(-MAX_HISTORY_CONTEXT).map(h =>
    `${h.role === 'human' ? '老板' : 'Leader'}: ${h.content}`
  ).join('\n');

  let planHistoryStr = '';
  if (planHistory && planHistory.length > 0) {
    planHistoryStr = '\n\n## Previously Attempted Plans (DO NOT repeat these approaches)\n' +
      planHistory.map((plan, i) =>
        `Iteration ${i + 1}: ${plan.subtasks?.map(st => st.title).join(', ') || 'unknown'}`
      ).join('\n');
  }

  return `## 对话历史\n${historyStr}\n\n## Goal Condition\n${goal}\n\n## Previous Attempt\nIteration: ${previousIteration.iteration}\nEvaluator verdict: ${previousIteration.verdict.goalMet ? 'MET' : 'NOT MET'}\nReasoning: ${previousIteration.verdict.reasoning}\nRemaining issues: ${previousIteration.verdict.remainingIssues?.join('; ') || 'none listed'}\nSuggested actions: ${previousIteration.verdict.suggestedActions?.join('; ') || 'none listed'}\n\nResults:\n${previousIteration.subtaskResults.map((r, i) => `${r.success ? 'PASS' : 'FAIL'}: ${r.title || 'Subtask ' + (i + 1)}`).join('\n')}${planHistoryStr}\n\nThe goal was NOT met. Create a NEW plan focusing on the remaining issues.\nCRITICAL: Do NOT repeat the same approach that failed. You must try a fundamentally different strategy.${deadLoopDetected ? '\n\n⚠️ WARNING: Your previous plans were too similar. You MUST use a completely different decomposition strategy.' : ''}`;
}

// --- 智能重试工具函数 ---

function categorizeError(msg) {
  if (!msg) return 'unknown';
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('rate') || lower.includes('limit') || lower.includes('429')) return 'rate_limit';
  if (lower.includes('permission') || lower.includes('forbidden') || lower.includes('403')) return 'permission';
  if (lower.includes('syntax') || lower.includes('parse') || lower.includes('unexpected')) return 'syntax';
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('404')) return 'file_not_found';
  if (lower.includes('typeerror') || lower.includes('referenceerror')) return 'runtime';
  return 'general';
}

function buildRetryPrompt(subtask, attempts, diagnosis) {
  const MAX_HISTORY_CHARS = 2000;
  const workerAttempts = attempts.filter(a => a.role === 'worker');
  const historyParts = [];

  for (let i = 0; i < workerAttempts.length; i++) {
    const a = workerAttempts[i];
    const isLatest = i === workerAttempts.length - 1;
    if (isLatest) {
      let part = `### Attempt ${i + 1} (latest)\nStatus: ${a.status}\n`;
      if (a.output) part += `Output: ${a.output.slice(0, 500)}\n`;
      if (a.errorCategory) part += `Error category: ${a.errorCategory}\n`;
      if (a.verifierFeedback) part += `Verifier feedback: ${a.verifierFeedback}\n`;
      if (a.verifierIssues?.length) part += `Issues: ${a.verifierIssues.join('; ')}\n`;
      historyParts.push(part);
    } else {
      let part = `### Attempt ${i + 1}: ${a.status}`;
      if (a.verifierFeedback) part += ` - "${a.verifierFeedback.slice(0, 100)}"`;
      if (a.errorCategory) part += ` [${a.errorCategory}]`;
      historyParts.push(part);
    }
  }

  let historyStr = historyParts.join('\n\n');
  if (historyStr.length > MAX_HISTORY_CHARS) {
    historyStr = historyStr.slice(0, MAX_HISTORY_CHARS) + '\n...(truncated)';
  }

  let prompt = `## Original Task\n${subtask.description}\n\n`;
  prompt += `## Attempt History (${workerAttempts.length} previous attempts)\n${historyStr}\n\n`;

  if (diagnosis) {
    prompt += `## Failure Diagnosis\nRoot cause: ${diagnosis.rootCause}\nSuggested approach: ${diagnosis.suggestedApproach}\n\n`;
  }

  prompt += `## Instructions\nYou are retrying this task. Previous attempts failed.\n`;
  prompt += `- Analyze WHY previous approaches failed before starting\n`;
  prompt += `- Use a DIFFERENT approach than what was tried before\n`;
  prompt += `- If the task seems fundamentally blocked, simplify the scope\n`;
  prompt += `- Address ALL issues from verifier feedback\n`;

  return prompt;
}

/**
 * 第 1 次重试：自我反思 prompt — 从失败点继续，不从头开始
 */
function buildSelfReflectPrompt(subtask, attempts, lastOutput, lastError, lastFeedback) {
  const workerAttempts = attempts.filter(a => a.role === 'worker');
  const latestAttempt = workerAttempts[workerAttempts.length - 1];

  let prompt = `## 原始任务\n${subtask.description}\n\n`;

  // 保留上次已完成的工作成果
  if (lastOutput && lastOutput.length > 0) {
    prompt += `## 已完成的工作（你的上次输出）\n${lastOutput.slice(0, 2000)}\n\n`;
  }

  // 说明失败原因
  prompt += `## 失败原因\n`;
  if (lastError) {
    prompt += `执行错误: ${lastError.slice(0, 500)}\n\n`;
  }
  if (lastFeedback) {
    prompt += `验证反馈: ${lastFeedback.slice(0, 500)}\n`;
    if (latestAttempt?.verifierIssues?.length) {
      prompt += `具体问题:\n${latestAttempt.verifierIssues.map((iss, i) => `${i + 1}. ${iss}`).join('\n')}\n`;
    }
    prompt += '\n';
  }

  prompt += `## 重试指令\n`;
  prompt += `请自我分析为什么失败了，然后从失败的地方继续，而不是从头开始。\n`;
  prompt += `- 先分析失败原因（是方法不对？理解有误？遗漏了什么？）\n`;
  prompt += `- 保留之前已正确完成的部分，只修正有问题的部分\n`;
  prompt += `- 用不同的方法解决失败的部分\n`;
  prompt += `- 如果某个方向走不通，换一个更简单的方案\n`;

  return prompt;
}

/**
 * 第 2 次重试：Leader 指导 prompt — 基于 Leader 的诊断结果继续
 */
function buildLeaderGuidedPrompt(subtask, attempts, lastOutput, leaderDiagnosis) {
  const workerAttempts = attempts.filter(a => a.role === 'worker');
  const latestAttempt = workerAttempts[workerAttempts.length - 1];

  let prompt = `## 原始任务\n${subtask.description}\n\n`;

  // 保留已完成的工作
  if (lastOutput && lastOutput.length > 0) {
    prompt += `## 已完成的工作（保留，不要重做）\n${lastOutput.slice(0, 2000)}\n\n`;
  }

  // 之前的尝试历史摘要
  prompt += `## 尝试历史摘要\n`;
  for (let i = 0; i < workerAttempts.length; i++) {
    const a = workerAttempts[i];
    prompt += `- 尝试 ${i + 1}: ${a.status}`;
    if (a.errorCategory) prompt += ` [${a.errorCategory}]`;
    if (a.verifierFeedback) prompt += ` — "${a.verifierFeedback.slice(0, 100)}"`;
    prompt += '\n';
  }
  prompt += '\n';

  // Leader 的诊断指导
  if (leaderDiagnosis) {
    prompt += `## Leader 的指导（必须遵循）\n${leaderDiagnosis.slice(0, 1000)}\n\n`;
  }

  prompt += `## 重试指令\n`;
  prompt += `这是你第 ${workerAttempts.length + 1} 次尝试。Leader 已经分析了失败原因并给出了指导。\n`;
  prompt += `- 严格遵循 Leader 的指导方法\n`;
  prompt += `- 保留之前已完成的工作，只做需要修正的部分\n`;
  prompt += `- 如果 Leader 建议简化范围，就简化\n`;

  return prompt;
}

// --- 死循环检测 ---

function computePlanSignature(plan) {
  if (!plan?.subtasks) return [];
  return plan.subtasks.map(st => st.title).sort();
}

function planSimilarity(sig1, sig2) {
  if (!sig1?.length || !sig2?.length) return 0;
  const set2 = new Set(sig2);
  const overlap = sig1.filter(t => set2.has(t)).length;
  return overlap / Math.max(sig1.length, sig2.length, 1);
}

export const orchestrator = new Orchestrator();
