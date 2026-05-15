import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { CONFIG } from './config.js';
import { sanitizeArg, tryParseJSON } from './utils.js';
import { getSandboxTools, checkBashCommand } from './sandbox.js';

// 跟踪所有活跃子进程，用于服务关闭时清理
const activeProcesses = new Set();

export function spawnAgent(opts) {
  return new Promise((resolve, reject) => {
    const { role, prompt, systemPrompt, budget, cwd, jsonSchema, emitter, sessionId, subtaskId, model } = opts;

    const cleanPrompt = sanitizeArg(prompt);
    const cleanSystem = sanitizeArg(systemPrompt);

    const args = [
      '-p', cleanPrompt,
      ...CONFIG.baseFlags,
      '--system-prompt', cleanSystem
    ];

    // 沙盒模式：限制可用工具（非 skip-permissions 时）
    if (!CONFIG.skipPermissions) {
      const allowedTools = getSandboxTools(cwd || process.cwd(), cwd || process.cwd());
      for (const tool of allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    // 模型：按角色分配，可通过 model 参数覆盖
    const modelName = model || CONFIG.models[role];
    if (modelName) args.push('--model', modelName);

    if (budget) args.push('--max-budget-usd', String(budget));
    if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

    const proc = spawn(CONFIG.claudeBin, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    activeProcesses.add(proc);

    let fullText = '';
    let structuredOutput = null;
    let cost = 0;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let modelUsage = {};
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
        reject(new Error(`Agent ${role} timed out`));
      }
    }, CONFIG.agentTimeout);

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') {
          const content = event.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                fullText = block.text;
                emitter?.emit('agent:output', { sessionId, subtaskId, role, text: block.text });
              }
              if (block.type === 'tool_use') {
                emitter?.emit('agent:tool', { sessionId, subtaskId, role, tool: block.name, input: block.input });
              }
            }
          }
        }
        if (event.type === 'result') {
          cost = event.total_cost_usd || 0;
          const u = event.usage;
          if (u) {
            usage.inputTokens += u.input_tokens || 0;
            usage.outputTokens += u.output_tokens || 0;
            usage.cacheReadTokens += u.cache_read_input_tokens || 0;
          }
          if (event.modelUsage) {
            for (const [model, data] of Object.entries(event.modelUsage)) {
              if (!modelUsage[model]) modelUsage[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0 };
              modelUsage[model].inputTokens += data.inputTokens || data.input_tokens || 0;
              modelUsage[model].outputTokens += data.outputTokens || data.output_tokens || 0;
              modelUsage[model].cacheReadTokens += data.cacheReadInputTokens || data.cache_read_input_tokens || 0;
              modelUsage[model].costUSD += data.costUSD || 0;
            }
          }
          if (event.subtype === 'success') {
            fullText = event.result || fullText;
            if (event.structured_output) structuredOutput = event.structured_output;
          }
        }
      } catch (e) {
        console.warn(`[agent-runner] Failed to parse output line: ${line.slice(0, 100)} (${e.message})`);
      }
    });

    const errLines = [];
    proc.stderr.on('data', (d) => errLines.push(d.toString()));

    proc.on('close', (code) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        if (jsonSchema && !structuredOutput && fullText) {
          structuredOutput = tryParseJSON(fullText);
        }
        resolve({ text: fullText, structuredOutput, cost, usage, modelUsage });
      } else {
        reject(new Error(`Agent ${role} failed: ${errLines.join('').slice(0, 200) || 'exit ' + code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);
      if (!resolved) { resolved = true; reject(err); }
    });
  });
}

/**
 * 终止所有活跃的 Claude CLI 子进程
 */
export function killAll() {
  for (const proc of activeProcesses) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  activeProcesses.clear();
}
