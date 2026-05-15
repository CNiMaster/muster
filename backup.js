import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, relative, basename } from 'path';
import { homedir } from 'os';

const MAX_BACKUPS = 15;
const BACKUPS_DIR_NAME = '.muster-backups';

/**
 * 备份管理器：在 Worker 修改文件前自动备份
 * 遵循 备份-修改-验证 三步流程
 */
export class BackupManager {
  constructor(projectPath) {
    this.projectPath = resolve(projectPath);
    this.backupsDir = join(this.projectPath, BACKUPS_DIR_NAME);
  }

  /**
   * 确保备份目录存在
   */
  _ensureDir() {
    if (!existsSync(this.backupsDir)) {
      mkdirSync(this.backupsDir, { recursive: true });
    }
  }

  /**
   * 创建备份快照
   * @param {string[]} files - 要备份的文件列表（相对于项目根目录或绝对路径）
   * @param {string} reason - 备份原因（如 subtask 标题）
   * @returns {{ id: string, timestamp: string, files: string[], size: number }}
   */
  createBackup(files, reason = 'pre-modification') {
    this._ensureDir();
    const id = `bak-${Date.now()}`;
    const backupDir = join(this.backupsDir, id);
    mkdirSync(backupDir, { recursive: true });

    let totalSize = 0;
    const backed = [];

    for (const file of files) {
      const absPath = file.startsWith('/') ? file : join(this.projectPath, file);
      if (!existsSync(absPath)) continue;

      const relPath = relative(this.projectPath, absPath);
      if (relPath.startsWith('..')) continue;  // 不备份项目外的文件

      const destDir = join(backupDir, dirname(relPath));
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

      const destFile = join(backupDir, relPath);
      try {
        const content = readFileSync(absPath);
        writeFileSync(destFile, content);
        totalSize += content.length;
        backed.push(relPath);
      } catch {}
    }

    const manifest = {
      id,
      timestamp: new Date().toISOString(),
      reason,
      files: backed,
      totalSize,
    };
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 清理超出上限的旧备份
    this._prune();

    return manifest;
  }

  /**
   * 从备份恢复
   * @param {string} backupId - 备份 ID
   * @returns {{ restored: string[], errors: string[] }}
   */
  restore(backupId) {
    const backupDir = join(this.backupsDir, backupId);
    const manifestPath = join(backupDir, 'manifest.json');

    if (!existsSync(manifestPath)) {
      return { restored: [], errors: [`备份 ${backupId} 不存在`] };
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const restored = [];
    const errors = [];

    for (const relPath of manifest.files) {
      const src = join(backupDir, relPath);
      const dest = join(this.projectPath, relPath);
      try {
        const content = readFileSync(src);
        writeFileSync(dest, content);
        restored.push(relPath);
      } catch (e) {
        errors.push(`${relPath}: ${e.message}`);
      }
    }

    return { restored, errors };
  }

  /**
   * 列出所有备份
   */
  listBackups() {
    this._ensureDir();
    if (!existsSync(this.backupsDir)) return [];

    try {
      return readdirSync(this.backupsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('bak-'))
        .map(d => {
          const manifestPath = join(this.backupsDir, d.name, 'manifest.json');
          if (!existsSync(manifestPath)) return null;
          try {
            return JSON.parse(readFileSync(manifestPath, 'utf-8'));
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }

  /**
   * 清理超出上限的旧备份
   */
  _prune() {
    const backups = this.listBackups();
    if (backups.length <= MAX_BACKUPS) return;

    const toDelete = backups.slice(MAX_BACKUPS);
    for (const bak of toDelete) {
      const dir = join(this.backupsDir, bak.id);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}
