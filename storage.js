import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const MUSTER_DIR = '.muster';
const TASKS_DIR = 'tasks';

/**
 * 持久化存储：任务记录保存在项目目录的 .muster/ 下
 * 结构:
 *   项目目录/.muster/
 *     workspace.json          ← 工作区元数据
 *     tasks/
 *       {taskId}/
 *         task.json            ← 任务元数据 + 对话历史 + 结果
 *         chat.json            ← 聊天消息记录
 */
export class Storage {
  /**
   * 获取或创建 .muster 目录
   */
  static getMusterDir(projectPath) {
    const dir = join(projectPath, MUSTER_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  static getTasksDir(projectPath) {
    const dir = join(Storage.getMusterDir(projectPath), TASKS_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 保存工作区元数据
   */
  static saveWorkspace(projectPath, workspaceData) {
    const dir = Storage.getMusterDir(projectPath);
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify(workspaceData, null, 2), 'utf-8');
  }

  /**
   * 加载工作区元数据
   */
  static loadWorkspace(projectPath) {
    const file = join(projectPath, MUSTER_DIR, 'workspace.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
  }

  /**
   * 保存任务
   */
  static saveTask(projectPath, taskData, chatMessages) {
    const taskDir = join(Storage.getTasksDir(projectPath), taskData.id);
    if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify(taskData, null, 2), 'utf-8');
    if (chatMessages) {
      writeFileSync(join(taskDir, 'chat.json'), JSON.stringify(chatMessages, null, 2), 'utf-8');
    }
  }

  /**
   * 加载所有任务
   */
  static loadTasks(projectPath) {
    const tasksDir = Storage.getTasksDir(projectPath);
    if (!existsSync(tasksDir)) return [];
    const tasks = [];
    const dirs = readdirSync(tasksDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const d of dirs) {
      const taskFile = join(tasksDir, d.name, 'task.json');
      const chatFile = join(tasksDir, d.name, 'chat.json');
      if (existsSync(taskFile)) {
        const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
        task._chatMessages = existsSync(chatFile) ? JSON.parse(readFileSync(chatFile, 'utf-8')) : [];
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * 加载单个任务的聊天记录
   */
  static loadChat(projectPath, taskId) {
    const file = join(Storage.getTasksDir(projectPath), taskId, 'chat.json');
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, 'utf-8'));
  }

  /**
   * 归档任务（标记为 archived，不删除文件）
   */
  static archiveTask(projectPath, taskId) {
    const taskFile = join(Storage.getTasksDir(projectPath), taskId, 'task.json');
    if (!existsSync(taskFile)) return;
    const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
    task.archived = true;
    writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');
  }

  /**
   * 恢复归档任务
   */
  static unarchiveTask(projectPath, taskId) {
    const taskFile = join(Storage.getTasksDir(projectPath), taskId, 'task.json');
    if (!existsSync(taskFile)) return;
    const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
    delete task.archived;
    writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');
  }

  /**
   * 加载归档任务
   */
  static loadArchivedTasks(projectPath) {
    return Storage.loadTasks(projectPath).filter(t => t.archived);
  }

  /**
   * 扫描最近打开过的项目（遍历 ~ 下的 .muster 目录）
   * 只扫描一层，避免太慢
   */
  static scanRecentProjects(basePaths = ['~/Projects', '~']) {
    const results = [];
    for (const bp of basePaths) {
      const dir = bp.replace(/^~/, homedir());
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            const musterDir = join(dir, e.name, MUSTER_DIR);
            if (existsSync(musterDir)) {
              const ws = Storage.loadWorkspace(join(dir, e.name));
              results.push({
                name: e.name,
                path: join(dir, e.name),
                hasData: true,
                lastUsed: ws?.lastUsed || null
              });
            }
          }
        }
      } catch {}
    }
    return results;
  }

  static saveBacklog(projectPath, items) {
    const dir = Storage.getMusterDir(projectPath);
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(items, null, 2), 'utf-8');
  }

  static loadBacklog(projectPath) {
    const file = join(projectPath, MUSTER_DIR, 'backlog.json');
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, 'utf-8'));
  }

  /**
   * 保存工作区索引（全局，在 Muster 项目根目录）
   */
  static saveWorkspaceIndex(musterRoot, workspaces) {
    const data = workspaces.map(w => ({ id: w.id, name: w.name, path: w.path }));
    const dir = Storage.getMusterDir(musterRoot);
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * 加载工作区索引
   */
  static loadWorkspaceIndex(musterRoot) {
    const file = join(musterRoot, MUSTER_DIR, 'workspaces.json');
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, 'utf-8'));
  }

  /**
   * 从项目目录恢复工作区的所有任务
   */
  static restoreWorkspaceTasks(state, ws) {
    const savedTasks = Storage.loadTasks(ws.path);
    for (const st of savedTasks) {
      if (st.archived) continue;
      state.restoreTask(ws.id, st);
    }
    const savedBacklog = Storage.loadBacklog(ws.path);
    if (savedBacklog.length) state.setBacklog(ws.id, savedBacklog);
  }

  /**
   * 保存配置（复杂度、模型、沙盒覆盖）
   */
  static saveConfig(projectPath, config) {
    const dir = Storage.getMusterDir(projectPath);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * 加载配置
   */
  static loadConfig(projectPath) {
    const file = join(projectPath, MUSTER_DIR, 'config.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
  }
}
