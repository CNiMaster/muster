/**
 * R6a 技能库面板（设置页，与工具档案面板相邻）：
 * 双根清单（用户根 $MUSTER_HOME/skills + 仓库 bundled，用户根同名覆盖）+ 来源徽章 + 启停
 * （复用 plugin 治理）+ 新建 SKILL.md（frontmatter 自动生成）+ URL 导入（LICENSE 白名单 + 注入扫描，
 * 成功后自动登记 THIRD_PARTY_NOTICES）。bundled 只可停不可删；删除仅限用户根。
 */
import { useState } from 'react';
import type React from 'react';
import { Button, toast } from '../Button';
import { Badge } from '../Badge';
import { useSkills, useCreateSkill, useImportSkill, useDeleteSkill, useToggleSkill } from '../../hooks/queries';

const STORAGE_LABEL: Record<string, { label: string; tone: 'info' | 'ok' | 'neutral' }> = {
  user: { label: '我的', tone: 'info' },
  synthesized: { label: '沉淀', tone: 'ok' },
  bundled: { label: '内置', tone: 'neutral' },
};

export function SkillLibraryPanel({ defaultOpen = false }: { defaultOpen?: boolean }): React.ReactElement {
  const { data: skills, isLoading } = useSkills();
  const createSkill = useCreateSkill();
  const importSkill = useImportSkill();
  const deleteSkill = useDeleteSkill();
  const toggleSkill = useToggleSkill();
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newId, setNewId] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newBody, setNewBody] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importId, setImportId] = useState('');
  const [importLicense, setImportLicense] = useState('MIT');
  const [importName, setImportName] = useState('');

  const list = skills ?? [];
  return (
    <details className="details-collapse" open={defaultOpen || undefined}>
      <summary>
        技能库
        <span className="muted">（我的 {list.filter((s) => s.storage !== 'bundled').length} · 内置 {list.filter((s) => s.storage === 'bundled').length}）</span>
      </summary>
      <div className="form-stack">
        <p className="muted">
          技能按任务自动检索注入。「我的」= 用户根（$MUSTER_HOME/skills，可增删改）；「内置」= 仓库自带（只可停用）；同名时我的版本优先生效。
        </p>
        <div className="settings-primary-actions">
          <Button variant="ghost" onClick={() => { setShowCreate((v) => !v); setShowImport(false); }}>＋ 新建技能</Button>
          <Button variant="ghost" onClick={() => { setShowImport((v) => !v); setShowCreate(false); }}>⬇ URL 导入</Button>
        </div>

        {showCreate && (
          <div className="form-stack" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 10 }}>
            <input className="mu-input" placeholder="技能 id（小写字母/数字/连字符，如 release-checklist）" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <input className="mu-input" placeholder="一句话描述（检索匹配用）" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            <textarea className="mu-input" rows={6} placeholder="技能正文（SKILL.md body：什么时候用、怎么做、注意事项）" value={newBody} onChange={(e) => setNewBody(e.target.value)} />
            <Button
              disabled={!newId.trim() || !newBody.trim() || createSkill.isPending}
              loading={createSkill.isPending}
              onClick={() => createSkill.mutate(
                { skillId: newId.trim(), description: newDesc.trim(), body: newBody },
                {
                  onSuccess: () => { toast('success', '技能已创建'); setShowCreate(false); setNewId(''); setNewDesc(''); setNewBody(''); },
                  onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
                },
              )}
            >
              保存技能
            </Button>
          </div>
        )}

        {showImport && (
          <div className="form-stack" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 10 }}>
            <input className="mu-input" placeholder="raw 文件 URL（如 https://raw.githubusercontent.com/.../SKILL.md）" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            <input className="mu-input" placeholder="落库技能 id（小写字母/数字/连字符）" value={importId} onChange={(e) => setImportId(e.target.value)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="mu-input" placeholder="协议（MIT / Apache-2.0 / BSD-3-Clause / ISC / MPL-2.0）" value={importLicense} onChange={(e) => setImportLicense(e.target.value)} style={{ flex: 1 }} />
              <input className="mu-input" placeholder="来源名（登记 THIRD_PARTY 用，可空）" value={importName} onChange={(e) => setImportName(e.target.value)} style={{ flex: 1 }} />
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>导入自动做注入扫描与协议白名单校验，通过后落用户根并登记 THIRD_PARTY_NOTICES.md。</p>
            <Button
              disabled={!importUrl.trim() || !importId.trim() || importSkill.isPending}
              loading={importSkill.isPending}
              onClick={() => importSkill.mutate(
                { url: importUrl.trim(), skillId: importId.trim(), license: importLicense.trim(), ...(importName.trim() ? { sourceName: importName.trim() } : {}) },
                {
                  onSuccess: () => { toast('success', '技能已导入并登记来源'); setShowImport(false); setImportUrl(''); setImportId(''); setImportName(''); },
                  onError: (e: unknown) => toast('error', (e as Error).message ?? '导入失败'),
                },
              )}
            >
              导入
            </Button>
          </div>
        )}

        {isLoading && <p className="muted">加载中…</p>}
        {!isLoading && list.length === 0 && <p className="muted">技能库为空。</p>}
        <div className="tool-registry-list">
          {list.map((skill) => {
            const storage = STORAGE_LABEL[skill.storage] ?? STORAGE_LABEL.bundled!;
            const disabled = skill.enabled === false;
            return (
              <div key={skill.skillId} className="tool-item" style={{ opacity: disabled ? 0.6 : 1 }}>
                <div className="tool-item-head">
                  <span className="tool-item-title">
                    {skill.name}
                    <Badge tone={storage.tone}>{storage.label}</Badge>
                    {disabled && <Badge tone="err">已停用</Badge>}
                  </span>
                  <div className="tool-item-actions">
                    <Button variant="ghost" onClick={() => toggleSkill.mutate(
                      { skillId: skill.skillId, enable: disabled },
                      { onSuccess: () => toast('success', disabled ? '已启用' : '已停用'), onError: (e: unknown) => toast('error', (e as Error).message ?? '操作失败') },
                    )}>
                      {disabled ? '启用' : '停用'}
                    </Button>
                    {skill.storage !== 'bundled' && (
                      <Button variant="ghost" onClick={() => {
                        if (!window.confirm(`删除技能「${skill.name}」？不可恢复。`)) return;
                        deleteSkill.mutate(skill.skillId, {
                          onSuccess: () => toast('success', '已删除'),
                          onError: (e: unknown) => toast('error', (e as Error).message ?? '删除失败'),
                        });
                      }}>删除</Button>
                    )}
                  </div>
                </div>
                <div className="tool-item-meta">
                  <span className="muted">{skill.description || '（无描述）'}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}
