/**
 * 素材库页面(项目工具页)。
 * 展示项目素材,支持三选一导入(链接/移入/复制)。
 */
import type React from 'react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMaterials, useImportMaterial, useDeleteMaterial, type ProjectMaterialDTO } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Field, Input, Select } from '../components/Form';
import { EmptyState } from '../components/EmptyState';

const KIND_ICON: Record<ProjectMaterialDTO['kind'], string> = {
  video: '🎬', audio: '🎵', image: '🖼️', document: '📄', link: '🔗', other: '📦',
};
const SOURCE_LABEL: Record<ProjectMaterialDTO['sourceType'], string> = {
  link: '🔗 链接', moved: '📥 移入', copied: '📋 复制',
};

export function MaterialsPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: materials, isLoading } = useMaterials(projectId);
  const importMat = useImportMaterial();
  const deleteMat = useDeleteMaterial();
  const [showImport, setShowImport] = useState(false);
  const [filterKind, setFilterKind] = useState('');

  const filtered = filterKind ? (materials ?? []).filter((m) => m.kind === filterKind) : (materials ?? []);

  const handleDelete = (m: ProjectMaterialDTO): void => {
    deleteMat.mutate({ id: m.id, projectId }, {
      onSuccess: () => toast('success', `已删除素材「${m.name}」${m.sourceType === 'moved' || m.sourceType === 'copied' ? '(文件已从素材区移除)' : ''}`),
      onError: (e: any) => toast('error', e.message ?? '删除失败'),
    });
  };

  return (
    <div className="materials-page">
      <div className="materials-toolbar">
        <Field label="按类型筛选">
          <Select value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
            <option value="">全部</option>
            <option value="video">视频</option>
            <option value="audio">音频</option>
            <option value="image">图片</option>
            <option value="document">文档</option>
            <option value="link">链接</option>
            <option value="other">其他</option>
          </Select>
        </Field>
        <Button onClick={() => setShowImport(!showImport)}>{showImport ? '取消导入' : '导入素材'}</Button>
      </div>

      {showImport && <ImportForm projectId={projectId} importMat={importMat} onDone={() => setShowImport(false)} />}

      {isLoading && <p className="muted">加载中…</p>}
      {!isLoading && filtered.length === 0 && (
        <EmptyState icon="📦" title="素材库为空" hint="导入素材后,智能体可在执行 Task 时引用这些素材。支持链接(不复制)、移入(删源)、复制(留源)三种方式。" />
      )}

      {filtered.length > 0 && (
        <div className="materials-grid">
          {filtered.map((m) => (
            <div key={m.id} className="material-card">
              <div className="material-card-head">
                <span className="material-icon">{KIND_ICON[m.kind]}</span>
                <span className="material-name" title={m.sourceUrl ?? m.storagePath ?? ''}>{m.name}</span>
                <Badge tone={m.sourceType === 'link' ? 'info' : 'neutral'}>{SOURCE_LABEL[m.sourceType]}</Badge>
              </div>
              <div className="material-meta">
                <span className="muted">{m.kind}</span>
                {typeof m.meta.sizeBytes === 'number' && <span className="muted">{formatBytes(m.meta.sizeBytes)}</span>}
              </div>
              {m.tags.length > 0 && (
                <div className="material-tags">{m.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</div>
              )}
              {m.sourceUrl && m.sourceType === 'link' && <div className="material-source-url muted" title={m.sourceUrl}>{m.sourceUrl}</div>}
              <div className="material-actions">
                <Button variant="ghost" onClick={() => handleDelete(m)}>删除</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportForm({ projectId, importMat, onDone }: { projectId: string; importMat: ReturnType<typeof useImportMaterial>; onDone: () => void }): React.ReactElement {
  const [mode, setMode] = useState<'link' | 'moved' | 'copied'>('link');
  const [sourcePath, setSourcePath] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');

  const handleSubmit = (): void => {
    importMat.mutate(
      {
        projectId,
        mode,
        sourcePath: sourcePath.trim() || undefined,
        sourceUrl: sourceUrl.trim() || undefined,
        name: name.trim() || undefined,
        tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      },
      {
        onSuccess: () => { toast('success', '素材导入成功'); onDone(); },
        onError: (e: any) => toast('error', e.message ?? '导入失败'),
      },
    );
  };

  return (
    <div className="material-import-form tool-capability-group">
      <div className="material-mode-selector">
        <label>
          <input type="radio" name="mode" checked={mode === 'link'} onChange={() => setMode('link')} />
          🔗 链接 <span className="muted">(存路径/URL,不复制文件,源不动)</span>
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === 'moved'} onChange={() => setMode('moved')} />
          📥 移入 <span className="muted">(搬进素材区,源文件删除)</span>
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === 'copied'} onChange={() => setMode('copied')} />
          📋 复制 <span className="muted">(拷贝进素材区,源文件保留)</span>
        </label>
      </div>
      {mode === 'link' && (
        <Field label="链接 URL 或本地路径" required>
          <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://example.com/source.mp4 或 /path/to/file.mp4" />
        </Field>
      )}
      {mode !== 'link' && (
        <Field label="源文件绝对路径" required>
          <Input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} placeholder="/Users/.../source-video.mp4" />
        </Field>
      )}
      <div className="settings-field-grid">
        <Field label="名称(可选)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="留空用文件名" /></Field>
        <Field label="标签(逗号分隔)"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="需求,原始素材" /></Field>
      </div>
      <div className="settings-primary-actions">
        <Button onClick={handleSubmit} loading={importMat.isPending}>导入</Button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
