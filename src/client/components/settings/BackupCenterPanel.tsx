/**
 * 备份中心面板：导出/导入结构化配置、文件系统目录指引、扫描导入系统 CLI 能力。
 *
 * 设计原则（用户确认）：
 * - 备份「结构化数据」：工作台/人员/技能/插件(MCP)配置（不含密钥明文、不含工作台文件）。
 * - 工作台文件（工作目录/素材产物）不进备份包，提供目录指引由用户自行备份文件系统。
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { Field, Input } from '../Form';

interface MusterDirectories {
  musterHome: string;
  dbPath: string;
  worktreesDir: string;
  companiesDir: string;
  agentsDir: string;
}

interface ScannedSkill {
  provider: string;
  id: string;
  name: string;
  path: string;
  description: string;
}

interface ScannedMcp {
  provider: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
}

interface ScanResult {
  skills: ScannedSkill[];
  mcps: ScannedMcp[];
  scannedDirs: string[];
  warnings: string[];
}

interface Workspace {
  id: string;
  name: string;
  rootDir: string;
  isActive: boolean;
}

interface MigrationStatus {
  current: Workspace | null;
  target: Workspace | null;
  existingProjectsInOldDir: number;
  targetDir: { exists: boolean; isEmpty: boolean; entries: string[] };
  warnings: string[];
}

const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  agents: '通用 agents',
};

export function BackupCenterPanel({ defaultOpen = false, className }: { defaultOpen?: boolean; className?: string }): React.ReactElement {
  const [dirs, setDirs] = useState<MusterDirectories | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [newWorkspaceDir, setNewWorkspaceDir] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedMcps, setSelectedMcps] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: string[]; skipped: string[] } | null>(null);

  // 挂载时自动加载目录指引与工作区（迁移区直接可见，无需先点按钮）
  useEffect(() => {
    void (async () => {
      try {
        const [d, w] = await Promise.all([
          api.get<MusterDirectories>('/api/backup/directories'),
          api.get<Workspace[]>('/api/workspaces'),
        ]);
        setDirs(d);
        setWorkspaces(w);
      } catch {
        // 加载失败保持空，用户可点「查看目录指引」重试
      }
    })();
  }, []);

  /** 导出：直接触发浏览器下载（后端已设 Content-Disposition）。 */
  const handleExport = async (): Promise<void> => {
    try {
      const res = await fetch('/api/backup/export');
      if (!res.ok) throw new Error(`导出失败：${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `muster-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast('success', `已导出 ${filename}`);
    } catch (error) {
      toast('error', (error as Error).message ?? '导出失败');
    }
  };

  /** 导入：读取本地 JSON 文件上传。 */
  const handleImportFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      let backup: unknown;
      try {
        backup = JSON.parse(String(reader.result));
      } catch {
        toast('error', '文件不是有效的 JSON');
        return;
      }
      void (async () => {
        try {
          const r = await api.post<{ companiesCreated: number; employeesCreated: number; profilesCreated: number; warnings: string[] }>('/api/backup/import', backup);
          toast('success', `导入完成：工作台 ${r.companiesCreated}、智能体 ${r.employeesCreated}、档案 ${r.profilesCreated}`);
          if (r.warnings.length > 0) {
            for (const w of r.warnings) toast('info', w);
          }
        } catch (error) {
          toast('error', (error as Error).message ?? '导入失败');
        }
      })();
    };
    reader.readAsText(file);
  };

  const handleLoadDirs = async (): Promise<void> => {
    try {
      const d = await api.get<MusterDirectories>('/api/backup/directories');
      setDirs(d);
      const w = await api.get<Workspace[]>('/api/workspaces');
      setWorkspaces(w);
    } catch (error) {
      toast('error', (error as Error).message ?? '读取目录失败');
    }
  };

  /** 迁移工作台文件目录：整个工作区目录（含全部项目文件）物理移动到新位置，DB 前缀同步重映射。 */
  const handleMigrateWorkspace = async (): Promise<void> => {
    const dir = newWorkspaceDir.trim();
    if (!dir) {
      toast('info', '请输入新的工作区目录绝对路径');
      return;
    }
    const active = workspaces?.find((w) => w.isActive);
    if (!active) {
      toast('error', '未找到当前工作区');
      return;
    }
    setMigrating(true);
    try {
      // 先查迁移状态：存量项目数 + 目标目录是否非空，把具体信息展示给用户再确认
      const status = await api.get<MigrationStatus>(`/api/workspaces/${active.id}/migration-status`);
      const warningLines = status.warnings.length > 0
        ? `\n\n注意：\n- ${status.warnings.join('\n- ')}`
        : '';
      const ok = window.confirm(
        `迁移工作区：\n${active.rootDir} → ${dir}\n\n` +
        `涉及 ${status.existingProjectsInOldDir} 个项目，文件随目录搬走，路径自动更新。\n` +
        '⚠ 需先让所有工作台下班。目标目录需为空或不存在。' + warningLines,
      );
      if (!ok) return;
      const result = await api.post<{ workspace: Workspace; remappedProjects: number; usedCopyFallback: boolean }>(`/api/workspaces/${active.id}/migrate`, { newRootDir: dir });
      const w = await api.get<Workspace[]>('/api/workspaces');
      setWorkspaces(w);
      const d = await api.get<MusterDirectories>('/api/backup/directories');
      setDirs(d);
      setNewWorkspaceDir('');
      toast('success', `工作区已迁移到 ${result.workspace.rootDir}（重映射 ${result.remappedProjects} 个项目路径${result.usedCopyFallback ? '，跨盘复制完成' : ''}）`);
    } catch (error) {
      toast('error', (error as Error).message ?? '迁移失败');
    } finally {
      setMigrating(false);
    }
  };

  const handleScan = async (): Promise<void> => {
    try {
      const r = await api.post<ScanResult>('/api/backup/scan-system');
      setScan(r);
      setSelectedSkills(new Set());
      setSelectedMcps(new Set());
      setImportResult(null);
      toast('success', `扫描完成：发现 ${r.skills.length} 个 skill、${r.mcps.length} 个 MCP server`);
      if (r.warnings.length > 0) for (const w of r.warnings) toast('info', w);
    } catch (error) {
      toast('error', (error as Error).message ?? '扫描失败');
    }
  };

  const toggleSkill = (id: string): void => {
    setSelectedSkills((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleMcp = (name: string): void => {
    setSelectedMcps((old) => {
      const next = new Set(old);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleImportScanned = async (): Promise<void> => {
    if (!scan) return;
    const skills = scan.skills.filter((s) => selectedSkills.has(s.id));
    const mcps = scan.mcps.filter((m) => selectedMcps.has(m.name));
    if (skills.length === 0 && mcps.length === 0) {
      toast('info', '请先勾选要导入的 skill 或 MCP');
      return;
    }
    setImporting(true);
    try {
      const r = await api.post<{ imported: string[]; skipped: string[] }>('/api/backup/import-scanned', { skills, mcps });
      setImportResult(r);
      toast('success', `已导入 ${r.imported.length} 项能力`);
      if (r.skipped.length > 0) for (const s of r.skipped) toast('info', `跳过：${s}`);
    } catch (error) {
      toast('error', (error as Error).message ?? '导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card
      className={className}
      title="备份与迁移"
      actions={<Button variant="ghost" size="sm" onClick={handleExport}>导出备份</Button>}
    >
      <p className="muted">
        备份包含结构化配置：工作台/部门/智能体、人才档案（含你修改过的预置人）、技能（名称与安装来源）、插件与 MCP 配置
        （<strong>不含密钥明文、不含工作台文件</strong>）。工作台文件请按下方目录指引自行备份。
      </p>

      <div className="settings-primary-actions">
        <Button onClick={handleExport} loading={false}>导出全部（JSON）</Button>
        <label className="mu-btn mu-btn-ghost" style={{ cursor: 'pointer' }}>
          导入备份文件
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }}
          />
        </label>
        <Button variant="ghost" onClick={handleLoadDirs}>查看目录指引</Button>
      </div>

      {dirs && (
        <div className="install-progress" style={{ marginTop: 12 }}>
          <div className="install-progress-head"><strong>文件系统目录指引</strong></div>
          <p className="muted" style={{ fontSize: 12 }}>工作台文件/素材产物不在备份包内，请自行备份以下目录（含隐私与体积考量）：</p>
          <ul style={{ fontSize: 12, margin: '4px 0', paddingLeft: 18 }}>
            <li><strong>程序数据</strong>：<code>{dirs.musterHome}</code>（数据库 <code>{dirs.dbPath}</code> 另存即完整备份）</li>
            <li><strong>工作台文件</strong>：<code>{dirs.companiesDir}</code>（工作目录与素材产物，可整体备份或排除隐私子目录）</li>
            <li><strong>任务工作区</strong>：<code>{dirs.worktreesDir}</code></li>
            <li><strong>智能体空间</strong>：<code>{dirs.agentsDir}</code></li>
          </ul>
        </div>
      )}

      {workspaces && (
        <div className="install-progress" style={{ marginTop: 12 }}>
          <div className="install-progress-head"><strong>工作区目录迁移</strong></div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            当前：<code>{workspaces.find((w) => w.isActive)?.rootDir ?? '（无）'}</code>
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            把整个工作区（含项目文件）搬到新位置，路径自动更新。需先让所有工作台下班。
          </p>
          <div className="settings-field-grid" style={{ marginTop: 8 }}>
            <Field label="新目录（需为空或不存在）">
              <Input value={newWorkspaceDir} onChange={(e) => setNewWorkspaceDir(e.target.value)} placeholder="/Users/you/MyCompanyFiles" />
            </Field>
          </div>
          <div className="settings-primary-actions">
            <Button variant="ghost" onClick={handleMigrateWorkspace} loading={migrating} disabled={!newWorkspaceDir.trim()}>迁移</Button>
          </div>
        </div>
      )}

      <details className="details-collapse" style={{ marginTop: 12 }} open={defaultOpen}>
        <summary>从系统 CLI 导入 skill / MCP（Claude Code / Codex / OpenCode / agents）</summary>
        <div className="form-stack">
          <p className="muted">扫描系统常见目录中已配置的 skills 与 MCP servers，多选后导入为 Muster 插件。MCP 只导入配置与键名引用，<strong>不读取密钥值</strong>。</p>
          <div className="settings-primary-actions">
            <Button variant="ghost" onClick={handleScan}>扫描系统 CLI</Button>
          </div>
          {scan && (
            <>
              {scan.scannedDirs.length === 0 && <p className="muted">未发现可扫描的 CLI 配置目录（如 ~/.claude/skills、~/.claude.json、~/.config/opencode 等）。</p>}
              {scan.skills.length > 0 && (
                <div>
                  <strong>Skills（{scan.skills.length}）：</strong>
                  <ul className="entity-list" style={{ marginTop: 4 }}>
                    {scan.skills.map((s) => (
                      <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                          <input type="checkbox" checked={selectedSkills.has(s.id)} onChange={() => toggleSkill(s.id)} />
                          <strong>{s.name}</strong>
                          <span className="muted">{PROVIDER_LABELS[s.provider] ?? s.provider}</span>
                        </label>
                        {s.description && <span className="muted" style={{ fontSize: 12 }}>{s.description}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {scan.mcps.length > 0 && (
                <div>
                  <strong>MCP Servers（{scan.mcps.length}）：</strong>
                  <ul className="entity-list" style={{ marginTop: 4 }}>
                    {scan.mcps.map((m) => (
                      <li key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                          <input type="checkbox" checked={selectedMcps.has(m.name)} onChange={() => toggleMcp(m.name)} />
                          <strong>{m.name}</strong>
                          <span className="muted">{PROVIDER_LABELS[m.provider] ?? m.provider}</span>
                        </label>
                        <span className="muted" style={{ fontSize: 12 }}>{m.command ? `${m.command} ${(m.args ?? []).join(' ')}` : m.url}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(scan.skills.length > 0 || scan.mcps.length > 0) && (
                <div className="settings-primary-actions">
                  <Button onClick={handleImportScanned} loading={importing}>
                    导入所选（{selectedSkills.size + selectedMcps.size} 项）
                  </Button>
                </div>
              )}
              {importResult && (
                <div className="install-progress">
                  <Badge tone="ok">导入完成</Badge>
                  <span className="muted" style={{ marginLeft: 8 }}>成功 {importResult.imported.length}，跳过 {importResult.skipped.length}</span>
                  {importResult.skipped.length > 0 && (
                    <ul style={{ fontSize: 12, margin: '4px 0 0', paddingLeft: 18 }}>
                      {importResult.skipped.map((s) => <li key={s}>{s}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </Card>
  );
}
