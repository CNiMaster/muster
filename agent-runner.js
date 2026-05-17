import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { CONFIG } from './config.js';
import { sanitizeArg, tryParseJSON } from './utils.js';
import { getSandboxTools, checkBashCommand } from './sandbox.js';

const activeProcesses = new Set();
const processSessions = new Map();  // sessionId → Set<proc>

export function spawnAgent(opts) {
  return new Promise((resolve, reject) => {
    const { role, prompt, systemPrompt, cwd, jsonSchema, emitter, sessionId, subtaskId, model } = opts;

    const cleanPrompt = sanitizeArg(prompt);
    const cleanSystem = sanitizeArg(systemPrompt);

    const args = [
      '-p', cleanPrompt,
      ...CONFIG.baseFlags,
      '--system-prompt', cleanSystem
    ];

    if (CONFIG.skipPermissions) {
      args.push('--dangerously-skip-permissions');
      args.push('--allow-dangerously-skip-permissions');
    } else {
      const allowedTools = getSandboxTools(cwd || process.cwd(), cwd || process.cwd());
      for (const tool of allowedTools) {
        args.push('--allowedTools', tool);
      }
      args.push('--permission-mode', 'acceptEdits');
    }

    const modelName = model || CONFIG.models[role];
    if (modelName) args.push('--model', modelName);

    if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

    const cmdPreview = `${CONFIG.claudeBin} ${args.slice(0, 4).map(a => a.length > 80 ? a.slice(0, 80) + '...' : a).join(' ')} [${args.length} args]`;
    console.error(`[agent-runner] Spawning ${role}: ${cmdPreview}, model=${modelName}, cwd=${cwd || process.cwd()}`);

    const proc = spawn(CONFIG.claudeBin, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdin.end();

    activeProcesses.add(proc);
    if (sessionId) {
      if (!processSessions.has(sessionId)) processSessions.set(sessionId, new Set());
      processSessions.get(sessionId).add(proc);
    }

    let fullText = '';
    let structuredOutput = null;
    let cost = 0;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let modelUsage = {};
    let resolved = false;
    let resultEvent = null;
    let lastToolUse = null;
    let eventCount = 0;
    let toolCallCount = 0;
    const recentLines = [];
    const MAX_RECENT = 20;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const info = `timed out after ${Math.round(CONFIG.agentTimeout / 60000)}min (${eventCount} events, ${toolCallCount} tool calls)`;
        console.error(`[agent-runner] ${role} ${info}`);
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
        // Resolve with partial output instead of rejecting — don't lose work
        if (jsonSchema && !structuredOutput && fullText) {
          structuredOutput = tryParseJSON(fullText);
        }
        resolve({
          text: fullText || `(超时，无输出。${info})`,
          structuredOutput,
          cost, usage, modelUsage,
          timedOut: true
        });
      }
    }, CONFIG.agentTimeout);

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      eventCount++;
      recentLines.push(line.length > 300 ? line.slice(0, 300) + '...' : line);
      if (recentLines.length > MAX_RECENT) recentLines.shift();
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
                toolCallCount++;
                lastToolUse = `${block.name}(${JSON.stringify(block.input).slice(0, 80)})`;
                emitter?.emit('agent:tool', { sessionId, subtaskId, role, tool: block.name, input: block.input, toolCallCount });
                // Kill agent if it exceeds max tool calls (prevents infinite exploration loops)
                if (CONFIG.maxToolCalls && toolCallCount > CONFIG.maxToolCalls) {
                  console.error(`[agent-runner] ${role} exceeded ${CONFIG.maxToolCalls} tool calls, resolving with partial output`);
                  resolved = true;
                  clearTimeout(timeout);
                  proc.kill('SIGTERM');
                  resolve({
                    text: fullText || `(工具调用超过 ${CONFIG.maxToolCalls} 次限制，已截断)`,
                    structuredOutput: tryParseJSON(fullText),
                    cost, usage, modelUsage,
                    toolLimited: true
                  });
                }
              }
            }
          }
        }
        if (event.type === 'result') {
          cost = event.total_cost_usd || 0;
          resultEvent = event;
          const u = event.usage;
          if (u) {
            usage.inputTokens += u.input_tokens || 0;
            usage.outputTokens += u.output_tokens || 0;
            usage.cacheReadTokens += u.cache_read_input_tokens || 0;
          }
          if (event.modelUsage) {
            for (const [m, data] of Object.entries(event.modelUsage)) {
              if (!modelUsage[m]) modelUsage[m] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0 };
              modelUsage[m].inputTokens += data.inputTokens || data.input_tokens || 0;
              modelUsage[m].outputTokens += data.outputTokens || data.output_tokens || 0;
              modelUsage[m].cacheReadTokens += data.cacheReadInputTokens || data.cache_read_input_tokens || 0;
              modelUsage[m].costUSD += data.costUSD || 0;
            }
          }
          if (event.subtype === 'success') {
            fullText = event.result || fullText;
            if (event.structured_output) structuredOutput = event.structured_output;
          }
        }
      } catch (e) {
        // non-JSON line, already in recentLines
      }
    });

    const errLines = [];
    proc.stderr.on('data', (d) => {
      errLines.push(d.toString());
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);
      if (sessionId) processSessions.get(sessionId)?.delete(proc);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        if (jsonSchema && !structuredOutput && fullText) {
          structuredOutput = tryParseJSON(fullText);
        }
        resolve({ text: fullText, structuredOutput, cost, usage, modelUsage });
      } else {
        // Build detailed error from multiple sources
        const parts = [];
        const stderrText = errLines.join('').trim();
        if (stderrText) parts.push(stderrText.slice(0, 500));

        // Extract error from result event (e.g. API errors, budget errors)
        if (resultEvent?.errors?.length) {
          parts.push(resultEvent.errors.join('; '));
        }
        if (resultEvent?.is_error && resultEvent.subtype) {
          parts.push(`result: ${resultEvent.subtype}`);
        }

        if (parts.length === 0 && recentLines.length > 0) {
          // Show last few stdout lines for context
          parts.push('last output:\n' + recentLines.slice(-5).join('\n'));
        }

        const detail = parts.join(' | ') || `exit ${code}`;
        console.error(`[agent-runner] ${role} failed (code ${code}): ${detail.slice(0, 500)}`);
        reject(new Error(`Agent ${role} failed: ${detail}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);
      if (sessionId) processSessions.get(sessionId)?.delete(proc);
      console.error(`[agent-runner] ${role} spawn error:`, err.message);
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
  processSessions.clear();
}

export function killSession(sessionId) {
  const procs = processSessions.get(sessionId);
  if (!procs) return 0;
  let count = 0;
  for (const proc of procs) {
    try { proc.kill('SIGTERM'); activeProcesses.delete(proc); count++; } catch {}
  }
  processSessions.delete(sessionId);
  return count;
}
