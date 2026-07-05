import type React from 'react';
import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  useArtifacts,
  useArtifactContent,
  useSaveArtifactContent,
  useCreateArtifact,
  useProject,
  useAgents,
  useArtifactHistory,
} from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Input, Select, Field } from '../components/Form';
import { Tabs } from '../components/Tabs';
import { Modal } from '../components/Modal';
import { EmptyState, Icons } from '../components/EmptyState';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { MarkdownPreview } from '../components/MarkdownPreview';

const EDITABLE_KINDS = ['project_brief', 'synopsis', 'style_profile', 'outline', 'chapter', 'character_sheet', 'worldbuilding', 'timeline', 'foreshadowing'];
const READONLY_KINDS = ['character_relation_view', 'plot_progress_view', 'timeline_view'];

const KIND_LABELS: Record<string, string> = {
  project_brief: '项目说明',
  synopsis: '故事梗概',
  style_profile: '风格档案',
  outline: '计划大纲',
  chapter: '章节',
  character_sheet: '人物档案',
  worldbuilding: '世界观',
  timeline: '时间线',
  foreshadowing: '伏笔资料',
  character_relation_view: '人物关系（只读）',
  plot_progress_view: '剧情进度（只读）',
  timeline_view: '实际时间线（只读）',
};

export function ArtifactsPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const { data: artifacts } = useArtifacts(projectId);
  const { data: agents } = useAgents(project?.companyId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: history } = useArtifactHistory(projectId);
  const editable = (artifacts ?? []).filter((a) => EDITABLE_KINDS.includes(a.kind));
  const readonly = (artifacts ?? []).filter((a) => READONLY_KINDS.includes(a.kind));
  const other = (artifacts ?? []).filter((a) => !EDITABLE_KINDS.includes(a.kind) && !READONLY_KINDS.includes(a.kind));

  return (
    <div className="artifacts-page">
      <header className="page-header">
        <h1>成果工作台 · {project?.name ?? '...'}</h1>
        <Button onClick={() => setCreateOpen(true)}>新建成果</Button>
      </header>

      <Tabs
        items={[
          {
            key: 'editable',
            label: `可编辑（${editable.length}）`,
            content: (
              <ArtifactList
                items={editable}
                agents={agents ?? []}
                onSelect={setSelectedPath}
                empty={<EmptyState icon={Icons.empty} title="还没有可编辑成果" hint="新建章节或大纲开始创作。" />}
              />
            ),
          },
          {
            key: 'readonly',
            label: `派生只读（${readonly.length}）`,
            content: (
              <ArtifactList
                items={readonly}
                agents={agents ?? []}
                onSelect={setSelectedPath}
                empty={<EmptyState icon={Icons.graph} title="还没有派生视图" hint="章节完成后会自动生成人物关系、剧情进度等只读投影。" />}
              />
            ),
          },
          {
            key: 'other',
            label: `其他（${other.length}）`,
            content: (
              <ArtifactList
                items={other}
                agents={agents ?? []}
                onSelect={setSelectedPath}
                empty={<EmptyState icon={Icons.empty} title="无" />}
              />
            ),
          },
          {
            key: 'history',
            label: `修改历史（${history?.length ?? 0}）`,
            content: (
              <HistoryList
                items={history ?? []}
                empty={<EmptyState icon={Icons.empty} title="无发布历史" hint="任务完成后会自动合并改动并生成修改记录。" />}
              />
            ),
          },
        ]}
      />

      {selectedPath && <ArtifactEditor projectId={projectId} path={selectedPath} onClose={() => setSelectedPath(null)} />}
      {createOpen && (
        <CreateArtifactModal
          projectId={projectId}
          onClose={() => setCreateOpen(false)}
          onCreated={(p) => {
            setCreateOpen(false);
            setSelectedPath(p);
          }}
        />
      )}
    </div>
  );
}

function ArtifactList({
  items,
  agents,
  onSelect,
  empty,
}: {
  items: { id: string; kind: string; path: string; ownerAgentId: string | null; updatedAt: string }[];
  agents: { id: string; name: string; role: string }[];
  onSelect: (path: string) => void;
  empty: React.ReactNode;
}): React.ReactNode {
  if (items.length === 0) return empty;
  return (
    <ul className="entity-list">
      {items.map((a) => {
        const owner = agents.find((x) => x.id === a.ownerAgentId);
        const readonly = READONLY_KINDS.includes(a.kind);
        return (
          <li key={a.id} onClick={() => onSelect(a.path)} style={{ cursor: 'pointer' }}>
            <div style={{ flex: 1 }}>
              <strong>{a.path}</strong> <span className="muted">{KIND_LABELS[a.kind] ?? a.kind}</span>
            </div>
            {owner && <Badge tone="info">{owner.name} [{owner.role}]</Badge>}
            {readonly && <Badge tone="warn">只读</Badge>}
            <span className="subtle">{new Date(a.updatedAt).toLocaleDateString()}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactEditor({ projectId, path, onClose }: { projectId: string; path: string; onClose: () => void }): React.ReactNode {
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path);
  const isPdf = /\.pdf$/i.test(path);
  const isBinary = isImage || isPdf;

  const { data, isLoading } = useArtifactContent(projectId, isBinary ? null : path);
  const save = useSaveArtifactContent();
  const [draft, setDraft] = useState<string | null>(null);
  const artifacts = useArtifacts(projectId);
  const art = artifacts.data?.find((a) => a.path === path);
  const readonly = art ? READONLY_KINDS.includes(art.kind) : false;

  useEffect(() => {
    if (data) setDraft(data.content);
  }, [data]);

  const dirty = draft !== null && data && draft !== data.content;

  const saveNow = (): void => {
    if (draft === null) return;
    save.mutate(
      { projectId, path, content: draft },
      {
        onSuccess: () => toast('success', '已保存'),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '保存失败'),
      },
    );
  };

  return (
    <Modal open onClose={onClose} title={path} size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {!readonly && !isBinary && (
            <Button onClick={saveNow} disabled={!dirty} loading={save.isPending}>
              保存
            </Button>
          )}
        </>
      }
    >
      {isBinary ? (
        isImage ? (
          <div className="mu-artifact-image-preview">
            <img src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} alt={path} />
          </div>
        ) : (
          <iframe src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} title={path} className="mu-artifact-pdf-preview" />
        )
      ) : isLoading || draft === null ? (
        <div className="muted">加载中…</div>
      ) : readonly ? (
        <MarkdownPreview source={draft} />
      ) : (
        <Tabs
          items={[
            { key: 'edit', label: '编辑', content: <MarkdownEditor value={draft} onChange={setDraft} minHeight={420} /> },
            { key: 'preview', label: '预览', content: <MarkdownPreview source={draft} /> },
          ]}
        />
      )}
    </Modal>
  );
}

function CreateArtifactModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}): React.ReactNode {
  const create = useCreateArtifact();
  const [path, setPath] = useState('chapters/01.md');
  const [kind, setKind] = useState('chapter');
  const [content, setContent] = useState('# 新章节\n\n开始创作…\n');

  const submit = (): void => {
    create.mutate(
      { projectId, path, kind, content },
      {
        onSuccess: () => {
          toast('success', '成果已创建');
          onCreated(path);
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '创建失败'),
      },
    );
  };

  return (
    <Modal open onClose={onClose} title="新建成果" size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={!path.trim()} loading={create.isPending}>创建</Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="路径" required hint="相对项目根目录，例如 chapters/01.md">
          <Input value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <Field label="类型" required>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {EDITABLE_KINDS.map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k] ?? k}</option>
            ))}
          </Select>
        </Field>
        <Field label="初始内容">
          <MarkdownEditor value={content} onChange={setContent} minHeight={240} />
        </Field>
      </div>
    </Modal>
  );
}

function HistoryList({
  items,
  empty,
}: {
  items: {
    id: string;
    taskId: string;
    commitHash: string;
    mergedFiles: string[];
    conflicts: string[];
    blocked: boolean;
    publishedAt: string;
  }[];
  empty: React.ReactNode;
}): React.ReactNode {
  if (items.length === 0) return empty;
  return (
    <ul className="entity-list">
      {items.map((h) => (
        <li key={h.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span className="muted" style={{ marginRight: 'var(--space-2)' }}>提交:</span>
              <code style={{ background: 'var(--bg-soft)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>
                {h.commitHash.slice(0, 7)}
              </code>
              <span className="muted" style={{ marginLeft: 'var(--space-4)', marginRight: 'var(--space-2)' }}>关联任务:</span>
              <a href={`#/tasks/${h.taskId}`} style={{ color: 'var(--accent)' }}>
                {h.taskId}
              </a>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              {h.blocked ? (
                <Badge tone="err">冲突阻塞</Badge>
              ) : (
                <Badge tone="ok">已合并发布</Badge>
              )}
              <span className="subtle">{new Date(h.publishedAt).toLocaleString()}</span>
            </div>
          </div>
          {h.mergedFiles.length > 0 && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
              <strong>合并文件:</strong> {h.mergedFiles.join(', ')}
            </div>
          )}
          {h.conflicts.length > 0 && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--err)' }}>
              <strong>冲突阻塞文件:</strong> {h.conflicts.join(', ')}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
