import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { homedir } from 'os';
import { state } from './state.js';
import { orchestrator } from './orchestrator.js';
import { CONFIG, setComplexity, listPersonas, listSkills } from './config.js';
import { Storage } from './storage.js';
import { killAll } from './agent-runner.js';
import { isPathAllowed } from './utils.js';
import { scheduler } from './scheduler.js';
import { BackupManager } from './backup.js';
import { getSandboxConfig, updateSandboxConfig } from './sandbox.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) { if (ws.readyState === 1) ws.send(msg); }
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// REST API
app.get('/api/workspaces', (req, res) => res.json(state.listWorkspaces()));

app.post('/api/workspaces', (req, res) => {
  let { name, path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'path 是必填字段' });
  }
  dirPath = dirPath.replace(/^~/, homedir());
  dirPath = resolve(dirPath);

  if (!isPathAllowed(dirPath)) {
    return res.status(403).json({ error: '路径不在允许范围内' });
  }

  if (!existsSync(dirPath)) {
    try { mkdirSync(dirPath, { recursive: true }); }
    catch (e) { return res.status(400).json({ error: `无法创建目录: ${e.message}` }); }
  }
  if (!statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: '路径不是目录' });
  }
  const ws = state.createWorkspace(name || basename(dirPath), dirPath);
  Storage.saveWorkspace(dirPath, { ...ws, lastUsed: new Date().toISOString() });
  Storage.saveWorkspaceIndex(__dirname, state.listWorkspaces());
  const savedTasks = Storage.loadTasks(dirPath);
  for (const st of savedTasks) {
    if (st.archived) continue;
    state.restoreTask(ws.id, st);
  }
  const savedBacklog = Storage.loadBacklog(dirPath);
  if (savedBacklog.length) state.setBacklog(ws.id, savedBacklog);
  res.json(ws);
});

// 目录浏览 API
app.get('/api/browse', (req, res) => {
  let dirPath = (req.query.path || '~').replace(/^~/, homedir());
  dirPath = resolve(dirPath);

  if (!isPathAllowed(dirPath)) {
    return res.json({ path: dirPath, exists: false, dirs: [], error: '路径不在允许范围内' });
  }

  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    return res.json({ path: dirPath, exists: false, dirs: [] });
  }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: dirPath, exists: true, dirs });
  } catch (e) {
    res.json({ path: dirPath, exists: true, dirs: [], error: e.message });
  }
});

// 路径验证
app.post('/api/validate-path', (req, res) => {
  const p = req.body?.path;
  if (!p || typeof p !== 'string') {
    return res.status(400).json({ error: 'path 是必填字段' });
  }
  const resolved = resolve(p.replace(/^~/, homedir()));
  if (!isPathAllowed(resolved)) {
    return res.json({ path: resolved, exists: false, isDir: false, error: '路径不在允许范围内' });
  }
  res.json({ path: resolved, exists: existsSync(resolved), isDir: existsSync(resolved) && statSync(resolved).isDirectory() });
});

app.get('/api/tasks/:workspaceId', (req, res) => res.json(state.listTasks(req.params.workspaceId)));

app.post('/api/tasks', (req, res) => {
  const { workspaceId, cwd } = req.body;
  if (!workspaceId || !cwd) {
    return res.status(400).json({ error: 'workspaceId 和 cwd 是必填字段' });
  }
  if (!state.getWorkspace(workspaceId)) {
    return res.status(404).json({ error: 'Workspace not found' });
  }
  res.json(state.createTask(workspaceId, cwd));
});

app.get('/api/task/:id', (req, res) => {
  const t = state.getTask(req.params.id);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});

// 任务归档
app.post('/api/task/:id/archive', (req, res) => {
  const t = state.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const ws = state.getWorkspace(t.workspaceId);
  if (ws) {
    Storage.archiveTask(ws.path, t.id);
    state.tasks.delete(t.id);
    state.chatMessages.delete(t.id);
  }
  res.json({ ok: true });
});

// 删除任务
app.delete('/api/task/:id', (req, res) => {
  const t = state.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const ws = state.getWorkspace(t.workspaceId);
  if (ws) Storage.deleteTaskFromDisk(ws.path, t.id);
  state.deleteTask(req.params.id);
  res.json({ ok: true });
});

// 重命名任务
app.put('/api/task/:id', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name 是必填字段' });
  const t = state.renameTask(req.params.id, name);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

// 恢复归档任务
app.post('/api/task/:id/restore', (req, res) => {
  const { workspaceId, taskId } = req.body;
  if (!workspaceId || !taskId) {
    return res.status(400).json({ error: 'workspaceId 和 taskId 是必填字段' });
  }
  const ws = state.getWorkspace(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  Storage.unarchiveTask(ws.path, taskId);
  const savedTasks = Storage.loadTasks(ws.path);
  const st = savedTasks.find(t => t.id === taskId);
  if (st) {
    state.restoreTask(workspaceId, st);
  }
  res.json({ ok: true });
});

// 获取归档任务列表
app.get('/api/archived/:workspaceId', (req, res) => {
  const ws = state.getWorkspace(req.params.workspaceId);
  if (!ws) return res.json([]);
  res.json(Storage.loadArchivedTasks(ws.path));
});

// 最近项目
app.get('/api/recent', (req, res) => {
  res.json(Storage.scanRecentProjects());
});

app.get('/api/chat/:taskId', (req, res) => res.json(state.getChatMessages(req.params.taskId)));

app.put('/api/config', (req, res) => {
  if (req.body.complexity) setComplexity(req.body.complexity);
  if (req.body.leaderModel && ['opus','sonnet','haiku'].includes(req.body.leaderModel)) CONFIG.models.leader = req.body.leaderModel;
  const existing = Storage.loadConfig(__dirname) || {};
  Storage.saveConfig(__dirname, { ...existing, complexity: CONFIG.complexity, leaderModel: CONFIG.models.leader });
  res.json({ ok: true, complexity: CONFIG.complexity, leaderModel: CONFIG.models.leader });
});

app.get('/api/config', (req, res) => {
  res.json({ complexity: CONFIG.complexity, leaderModel: CONFIG.models.leader, preset: CONFIG.preset.label, skipPermissions: CONFIG.skipPermissions,
    goalMaxIter: CONFIG.preset.goalMaxIter, goalBudgetCap: CONFIG.preset.goalBudgetCap });
});

// ===== Goal API =====
app.post('/api/task/:id/goal', (req, res) => {
  const { goal } = req.body;
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  state.updateTask(req.params.id, { goal: goal || null, goalIterations: 0, goalHistory: [] });
  res.json({ ok: true, goal: goal || null });
});

app.delete('/api/task/:id/goal', (req, res) => {
  state.updateTask(req.params.id, { goal: null });
  res.json({ ok: true });
});

// ===== 专家 & 技能 API =====
app.get('/api/personas', (req, res) => res.json(listPersonas()));
app.get('/api/skills', (req, res) => res.json(listSkills()));

// ===== 沙盒 & 权限 API =====
app.get('/api/sandbox', (req, res) => res.json(getSandboxConfig()));
app.put('/api/sandbox/config', (req, res) => {
  const { allowedTools, writeTools, blacklistEnabled } = req.body;
  const result = updateSandboxConfig({ allowedTools, writeTools, blacklistEnabled });
  // 持久化沙盒配置
  const config = Storage.loadConfig(__dirname) || {};
  config.sandbox = { allowedTools, writeTools, blacklistEnabled };
  Storage.saveConfig(__dirname, config);
  res.json(result);
});

// ===== 备份 API =====
app.get('/api/backups/:taskId', (req, res) => {
  const task = state.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const bm = new BackupManager(task.cwd);
  res.json(bm.listBackups());
});

app.post('/api/backups/:taskId/restore/:backupId', (req, res) => {
  const task = state.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const bm = new BackupManager(task.cwd);
  const result = bm.restore(req.params.backupId);
  res.json(result);
});

// ===== 定时任务 API =====
app.get('/api/scheduler/jobs', (req, res) => res.json(scheduler.listJobs()));

// ===== Backlog API =====
app.get('/api/backlog/:workspaceId', (req, res) => {
  res.json(state.getBacklog(req.params.workspaceId));
});

app.post('/api/backlog/:workspaceId', (req, res) => {
  const { title, description, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'title 是必填字段' });
  const ws = state.getWorkspace(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const item = state.createBacklogItem(req.params.workspaceId, { title, description, priority });
  Storage.saveBacklog(ws.path, state.getBacklog(req.params.workspaceId));
  res.json(item);
});

app.put('/api/backlog/:workspaceId/:itemId', (req, res) => {
  const ws = state.getWorkspace(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const item = state.updateBacklogItem(req.params.workspaceId, req.params.itemId, req.body);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  Storage.saveBacklog(ws.path, state.getBacklog(req.params.workspaceId));
  res.json(item);
});

app.delete('/api/backlog/:workspaceId/:itemId', (req, res) => {
  const ws = state.getWorkspace(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const ok = state.removeBacklogItem(req.params.workspaceId, req.params.itemId);
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Item not found' });
});

app.put('/api/backlog/:workspaceId/reorder', (req, res) => {
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds)) return res.status(400).json({ error: 'itemIds must be array' });
  const ws = state.getWorkspace(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  state.reorderBacklog(req.params.workspaceId, itemIds);
  Storage.saveBacklog(ws.path, state.getBacklog(req.params.workspaceId));
  res.json({ ok: true });
});

app.post('/api/scheduler/cancel/:jobId', (req, res) => {
  const ok = scheduler.cancel(req.params.jobId);
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Job not found' });
});

app.post('/api/scheduler/schedule', (req, res) => {
  const { taskId, subtaskIndex, delayMinutes } = req.body;
  if (!taskId || subtaskIndex === undefined || !delayMinutes) {
    return res.status(400).json({ error: 'taskId, subtaskIndex, delayMinutes 是必填字段' });
  }
  const task = state.getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const subtask = task.subtasks[subtaskIndex];
  if (!subtask) return res.status(404).json({ error: 'Subtask not found' });

  const job = scheduler.scheduleOnce({
    name: `手动重试: ${subtask.title}`,
    delayMs: delayMinutes * 60 * 1000,
    reason: 'manual',
    payload: { taskId, subtask, index: subtaskIndex },
    execute: () => orchestrator.runSubtaskWithVerification(taskId, subtask, subtaskIndex),
  });
  res.json(job);
});

// 桥接 scheduler 事件到 WS
scheduler.on('job:scheduled', (job) => broadcast({ type: 'scheduler:job', data: job }));
scheduler.on('job:started', (job) => broadcast({ type: 'scheduler:job', data: { ...job, status: 'running' } }));
scheduler.on('job:completed', (job) => broadcast({ type: 'scheduler:job', data: { ...job, status: 'completed' } }));
scheduler.on('job:failed', (data) => broadcast({ type: 'scheduler:job', data }));
scheduler.on('job:cancelled', (job) => broadcast({ type: 'scheduler:job', data: { ...job, status: 'cancelled' } }));

// WebSocket — 验证 Origin
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && origin !== `http://localhost:${CONFIG.port}` && origin !== `http://127.0.0.1:${CONFIG.port}`) {
    ws.close(1008, 'Invalid origin');
    return;
  }

  ws.send(JSON.stringify({ type: 'init', workspaces: state.listWorkspaces() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'workspace:create') {
        if (!msg.path) { ws.send(JSON.stringify({ type: 'error', error: 'path 是必填字段' })); return; }
        let dirPath = msg.path.replace(/^~/, homedir());
        dirPath = resolve(dirPath);
        if (!isPathAllowed(dirPath)) { ws.send(JSON.stringify({ type: 'error', error: '路径不在允许范围内' })); return; }
        const ws2 = state.createWorkspace(msg.name || basename(dirPath), dirPath);
        Storage.saveWorkspace(dirPath, { ...ws2, lastUsed: new Date().toISOString() });
        Storage.saveWorkspaceIndex(__dirname, state.listWorkspaces());
        ws.send(JSON.stringify({ type: 'workspace:created', data: ws2 }));
      }

      if (msg.type === 'task:create') {
        if (!msg.workspaceId) { ws.send(JSON.stringify({ type: 'error', error: 'workspaceId 是必填字段' })); return; }
        const task = state.createTask(msg.workspaceId, msg.cwd || process.cwd());
        ws.send(JSON.stringify({ type: 'task:created', data: task }));
      }

      if (msg.type === 'chat:send') {
        if (!msg.taskId || !msg.text) { ws.send(JSON.stringify({ type: 'error', error: 'taskId 和 text 是必填字段' })); return; }
        orchestrator.handleHumanMessage(msg.taskId, msg.text).catch(err => {
          console.error('Chat error:', err);
          ws.send(JSON.stringify({ type: 'error', error: `Chat error: ${err.message}` }));
        });
      }

      if (msg.type === 'timer:schedule') {
        if (!msg.taskId || !msg.text) { ws.send(JSON.stringify({ type: 'error', error: 'taskId and text required' })); return; }
        const task = state.getTask(msg.taskId);
        if (!task) return;
        const job = scheduler.scheduleOnce({
          name: `定时: ${msg.text.slice(0, 40)}`,
          delayMs: (msg.delayMinutes || 30) * 60 * 1000,
          reason: 'timer',
          payload: { taskId: msg.taskId, text: msg.text },
          execute: () => orchestrator.handleHumanMessage(msg.taskId, msg.text),
        });
        ws.send(JSON.stringify({ type: 'timer:scheduled', data: job }));
      }

      if (msg.type === 'config:set') {
        if (msg.complexity) setComplexity(msg.complexity);
        if (msg.leaderModel && ['opus','sonnet','haiku'].includes(msg.leaderModel)) CONFIG.models.leader = msg.leaderModel;
        // 持久化到项目配置（merge 保留 sandbox 等已有字段）
        const existing = Storage.loadConfig(__dirname) || {};
        Storage.saveConfig(__dirname, { ...existing, complexity: CONFIG.complexity, leaderModel: CONFIG.models.leader });
        broadcast({ type: 'config:updated', complexity: CONFIG.complexity, leaderModel: CONFIG.models.leader });
      }

      if (msg.type === 'goal:set') {
        if (!msg.taskId) { ws.send(JSON.stringify({ type: 'error', error: 'taskId is required' })); return; }
        state.updateTask(msg.taskId, { goal: msg.goal || null, goalIterations: 0, goalHistory: [] });
        // task:update 由事件桥接自动 broadcast
      }

      if (msg.type === 'backlog:add') {
        if (!msg.workspaceId || !msg.title) { ws.send(JSON.stringify({ type: 'error', error: 'workspaceId 和 title 是必填字段' })); return; }
        state.createBacklogItem(msg.workspaceId, { title: msg.title, description: msg.description, priority: msg.priority });
        const ws2 = state.getWorkspace(msg.workspaceId);
        if (ws2) Storage.saveBacklog(ws2.path, state.getBacklog(msg.workspaceId));
        // backlog:update 由事件桥接自动广播
      }

      if (msg.type === 'backlog:update') {
        if (!msg.workspaceId || !msg.itemId) { ws.send(JSON.stringify({ type: 'error', error: 'workspaceId 和 itemId 是必填字段' })); return; }
        state.updateBacklogItem(msg.workspaceId, msg.itemId, msg.updates || {});
        const ws2 = state.getWorkspace(msg.workspaceId);
        if (ws2) Storage.saveBacklog(ws2.path, state.getBacklog(msg.workspaceId));
      }

      if (msg.type === 'backlog:reorder') {
        if (!msg.workspaceId || !msg.itemIds) { ws.send(JSON.stringify({ type: 'error', error: 'workspaceId 和 itemIds 是必填字段' })); return; }
        state.reorderBacklog(msg.workspaceId, msg.itemIds);
        const ws2 = state.getWorkspace(msg.workspaceId);
        if (ws2) Storage.saveBacklog(ws2.path, state.getBacklog(msg.workspaceId));
      }

      if (msg.type === 'backlog:remove') {
        if (!msg.workspaceId || !msg.itemId) { ws.send(JSON.stringify({ type: 'error', error: 'workspaceId 和 itemId 是必填字段' })); return; }
        state.removeBacklogItem(msg.workspaceId, msg.itemId);
        const ws2 = state.getWorkspace(msg.workspaceId);
        if (ws2) Storage.saveBacklog(ws2.path, state.getBacklog(msg.workspaceId));
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });
});

// 桥接事件
const events = ['task:update', 'subtask:update', 'chat:message'];
events.forEach(evt => {
  state.on(evt, (data) => {
    broadcast({ type: evt, data });
    if (data.taskId) {
      const task = state.getTask(data.taskId);
      if (task) {
        const ws = state.getWorkspace(task.workspaceId);
        if (ws) Storage.saveTask(ws.path, task, state.getChatMessages(data.taskId));
      }
    }
  });
});
orchestrator.on('agent:output', (data) => broadcast({ type: 'agent:output', data }));
orchestrator.on('agent:tool', (data) => broadcast({ type: 'agent:tool', data }));
state.on('backlog:update', (data) => broadcast({ type: 'backlog:update', data }));

// 进程清理
function gracefulShutdown() {
  killAll();
  scheduler.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function restoreWorkspaceState() {
  // 从持久化恢复全局配置
  const saved = Storage.loadConfig(__dirname);
  if (saved) {
    if (saved.complexity) setComplexity(saved.complexity);
    if (saved.leaderModel && ['opus','sonnet','haiku'].includes(saved.leaderModel)) CONFIG.models.leader = saved.leaderModel;
    if (saved.sandbox) updateSandboxConfig(saved.sandbox);
  }

  // 恢复工作区及其任务
  const savedWorkspaces = Storage.loadWorkspaceIndex(__dirname);
  for (const wsMeta of savedWorkspaces) {
    const ws = state.restoreWorkspace(wsMeta);
    Storage.restoreWorkspaceTasks(state, ws);
  }
  // 如果工作区恢复后数量 > 0，广播恢复结果
  if (savedWorkspaces.length > 0) {
    broadcast({ type: 'restore:done', count: savedWorkspaces.length, workspaces: state.listWorkspaces() });
  }
}

server.listen(CONFIG.port, () => {
  restoreWorkspaceState();
  const skipNote = CONFIG.skipPermissions ? '' : '\n  ⚠️  权限检查已启用，如需自动执行请设置 MUSTER_SKIP_PERMISSIONS=true';
  console.log(`\n  Muster v2 — http://localhost:${CONFIG.port}${skipNote}\n`);
});
