import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

class StateStore extends EventEmitter {
  constructor() {
    super();
    this.workspaces = new Map();  // id -> Workspace
    this.tasks = new Map();       // id -> Task
    this.chatMessages = new Map(); // taskId -> ChatMessage[]
  }

  // ===== Workspace =====
  createWorkspace(name, path) {
    const ws = { id: randomUUID(), name: name || path.split('/').pop(), path, tasks: [], createdAt: new Date().toISOString() };
    this.workspaces.set(ws.id, ws);
    this.emit('workspace:update', ws);
    return ws;
  }

  getWorkspace(id) { return this.workspaces.get(id); }
  listWorkspaces() { return [...this.workspaces.values()]; }

  // ===== Task =====
  createTask(workspaceId, cwd) {
    const task = {
      id: randomUUID(),
      workspaceId,
      cwd,
      status: 'chatting',  // chatting | planning | executing | completed | failed
      conversationHistory: [],
      subtasks: [],
      agents: [],
      result: null,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, cacheRead: 0 },
      modelUsage: {},  // { "model-name": { inputTokens, outputTokens, cacheReadTokens, costUSD } }
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    this.tasks.set(task.id, task);
    this.chatMessages.set(task.id, []);
    const ws = this.workspaces.get(workspaceId);
    if (ws) ws.tasks.push(task.id);
    this.emit('task:update', task);
    return task;
  }

  getTask(id) { return this.tasks.get(id); }

  listTasks(workspaceId) {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return ws.tasks.map(id => this.tasks.get(id)).filter(Boolean);
  }

  updateTask(id, updates) {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, updates);
    this.emit('task:update', task);
    return task;
  }

  restoreTask(workspaceId, savedTask) {
    const task = { ...savedTask, workspaceId };
    this.tasks.set(task.id, task);
    this.chatMessages.set(task.id, savedTask._chatMessages || []);
    const ws = this.workspaces.get(workspaceId);
    if (ws && !ws.tasks.includes(task.id)) ws.tasks.push(task.id);
    return task;
  }

  // ===== Chat Messages =====
  addChatMessage(taskId, msg) {
    const msgs = this.chatMessages.get(taskId);
    if (!msgs) return null;
    const { role, agentName, text, type } = msg;
    const chatMsg = {
      id: randomUUID(),
      taskId,
      timestamp: new Date().toISOString(),
      role,
      agentName,
      text,
      type
    };
    msgs.push(chatMsg);
    this.emit('chat:message', chatMsg);
    return chatMsg;
  }

  getChatMessages(taskId) {
    return this.chatMessages.get(taskId) || [];
  }

  // ===== Subtask =====
  addSubtask(taskId, { title, description }) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const subtask = {
      id: randomUUID(),
      taskId,
      title, description,
      status: 'pending',
      attempts: [],
      currentAttempt: 0,
      finalOutput: null
    };
    task.subtasks.push(subtask);
    this.emit('subtask:update', subtask);
    return subtask;
  }

  updateSubtask(taskId, subtaskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const st = task.subtasks.find(s => s.id === subtaskId);
    if (!st) return null;
    Object.assign(st, updates);
    this.emit('subtask:update', st);
    return st;
  }

  getSubtask(taskId, subtaskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return task.subtasks.find(s => s.id === subtaskId);
  }

  addAttempt(taskId, subtaskId, attempt) {
    const st = this.getSubtask(taskId, subtaskId);
    if (!st) return null;
    st.attempts.push(attempt);
    st.currentAttempt = st.attempts.length;
    this.emit('subtask:update', st);
    return attempt;
  }

  updateAttempt(taskId, subtaskId, idx, updates) {
    const st = this.getSubtask(taskId, subtaskId);
    if (!st || !st.attempts[idx]) return null;
    Object.assign(st.attempts[idx], updates);
    this.emit('subtask:update', st);
    return st.attempts[idx];
  }

  // ===== Agents =====
  addAgent(taskId, agent) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const a = { id: randomUUID(), taskId, ...agent };
    task.agents.push(a);
    this.emit('task:update', task);
    return a;
  }

  updateAgent(taskId, agentId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const a = task.agents.find(x => x.id === agentId);
    if (!a) return null;
    Object.assign(a, updates);
    this.emit('task:update', task);
    return a;
  }

  addCost(taskId, cost, usage, modelUsage) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.totalCost += cost;
    if (usage) {
      task.totalTokens.input += usage.inputTokens || 0;
      task.totalTokens.output += usage.outputTokens || 0;
      task.totalTokens.cacheRead += usage.cacheReadTokens || 0;
    }
    // 累计 per-model 用量
    if (modelUsage) {
      for (const [model, data] of Object.entries(modelUsage)) {
        if (!task.modelUsage[model]) task.modelUsage[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0 };
        task.modelUsage[model].inputTokens += data.inputTokens || 0;
        task.modelUsage[model].outputTokens += data.outputTokens || 0;
        task.modelUsage[model].cacheReadTokens += data.cacheReadTokens || 0;
        task.modelUsage[model].costUSD += data.costUSD || 0;
      }
    }
  }
}

export const state = new StateStore();
