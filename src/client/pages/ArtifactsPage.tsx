import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  useArtifacts,
  useArtifactContent,
  useSaveArtifactContent,
  useCreateArtifact,
  useProject,
  useAgents,
  useArtifactHistory,
  useOpenArtifactExternally,
  useRollbackArtifact,
  useArtifactGallery,
  type ArtifactGalleryGroup,
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

/** 通用成果类型(Phase 4 泛化:非小说工作台也可见)。 */
const GENERIC_KINDS = ['markdown', 'text', 'json', 'image', 'pdf', 'video', 'audio', 'binary'];

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
  markdown: 'Markdown 文档',
  text: '纯文本',
  json: 'JSON 数据',
  image: '图片',
  pdf: 'PDF 文档',
  video: '视频',
  audio: '音频',
  binary: '二进制文件',
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
            key: 'gallery',
            label: '画廊',
            content: (
              <GalleryView projectId={projectId} onSelect={setSelectedPath} />
            ),
          },
          {
            key: 'history',
            label: `修改历史（${history?.length ?? 0}）`,
            content: (
              <HistoryList
                items={history ?? []}
                projectId={projectId}
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

function GalleryView({ projectId, onSelect }: { projectId: string; onSelect: (path: string) => void }): React.ReactNode {
  const [groupBy, setGroupBy] = useState<'time' | 'type'>('time');
  const { data: groups, isLoading } = useArtifactGallery(projectId, groupBy);

  if (isLoading) return <p className="muted">加载画廊…</p>;
  if (!groups || groups.length === 0) {
    return <EmptyState icon={Icons.graph} title="画廊为空" hint="任务发布成品后，这里会按时间或类型归档展示。" />;
  }

  return (
    <div className="artifact-gallery">
      <div className="materials-toolbar" style={{ marginBottom: 'var(--space-3)' }}>
        <Field label="分组方式">
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'time' | 'type')}>
            <option value="time">按时间</option>
            <option value="type">按类型</option>
          </Select>
        </Field>
      </div>
      {(groups as ArtifactGalleryGroup[]).map((group) => (
        <div key={group.key} className="tool-capability-group" style={{ marginBottom: 'var(--space-3)' }}>
          <div className="tool-capability-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{group.label}</span>
            <Badge tone="neutral">{group.count}</Badge>
          </div>
          <div className="materials-grid" style={{ marginTop: 'var(--space-2)' }}>
            {group.items.map((a) => {
              const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.path);
              const isVid = /\.(mp4|mov|avi|mkv|webm|flv)$/i.test(a.path);
              return (
                <div key={a.id} className="material-card" onClick={() => onSelect(a.path)} style={{ cursor: 'pointer' }} role="button" tabIndex={0}>
                  <div className="material-card-head">
                    <span className="material-icon">{isImg ? '🖼️' : isVid ? '🎬' : '📄'}</span>
                    <span className="material-name" title={a.path}>{a.path}</span>
                  </div>
                  {isImg && (
                    <img src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(a.path)}`} alt={a.path} style={{ maxWidth: '100%', borderRadius: 4, marginTop: 'var(--space-2)' }} />
                  )}
                  {isVid && (
                    <video controls preload="metadata" src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(a.path)}`} style={{ maxWidth: '100%', borderRadius: 4, marginTop: 'var(--space-2)' }} />
                  )}
                  <div className="material-meta">
                    <Badge tone="info">{KIND_LABELS[a.kind] ?? a.kind}</Badge>
                    <span className="muted">{new Date(a.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ArtifactList({
  items,
  agents,
  onSelect,
  empty,
}: {
  items: { id: string; kind: string; path: string; ownerAgentId: string | null; createdTaskId: string | null; updatedAt: string }[];
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
            {/* R3：来源任务维度——成果由哪个任务产出 */}
            {a.createdTaskId && (
              <Link className="mu-btn mu-btn-ghost mu-btn-sm" to={`/tasks/${a.createdTaskId}`} onClick={(e) => e.stopPropagation()}>
                来源任务
              </Link>
            )}
            {readonly && <Badge tone="warn">只读</Badge>}
            <span className="subtle">{new Date(a.updatedAt).toLocaleDateString()}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactEditor({ projectId, path, onClose }: { projectId: string; path: string; onClose: () => void }): React.ReactNode {
  const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
  const isPdf = /\.pdf$/i.test(path);
  const isVideo = /\.(mp4|mov|avi|mkv|webm|flv)$/i.test(path);
  const isAudio = /\.(mp3|wav|aac|flac|ogg|m4a)$/i.test(path);
  const isBinary = isImage || isPdf || isVideo || isAudio;

  const { data, isLoading } = useArtifactContent(projectId, isBinary ? null : path);
  const save = useSaveArtifactContent();
  const openExternal = useOpenArtifactExternally();
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

  const openNow = (): void => {
    openExternal.mutate(
      { projectId, path },
      {
        onSuccess: () => toast('success', '已用系统默认应用打开'),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '打开失败'),
      },
    );
  };

  return (
    <Modal open onClose={onClose} title={path} size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button variant="ghost" onClick={openNow} loading={openExternal.isPending} title="调用系统默认应用打开此文件">
            用默认应用打开
          </Button>
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
        ) : isVideo ? (
          <div className="mu-artifact-video-preview">
            <video controls src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} />
          </div>
        ) : isAudio ? (
          <div className="mu-artifact-audio-preview">
            <audio controls src={`/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(path)}`} />
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
            <optgroup label="通用">
              {GENERIC_KINDS.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k] ?? k}</option>
              ))}
            </optgroup>
            <optgroup label="小说专用">
              {EDITABLE_KINDS.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k] ?? k}</option>
              ))}
            </optgroup>
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
  projectId,
}: {
  items: {
    id: string;
    taskId: string;
    commitHash: string;
    mergedFiles: string[];
    conflicts: string[];
    blocked: boolean;
    rolledBack: boolean;
    status: 'published' | 'open' | 'resolved' | 'escalated';
    resolutionTaskId: string | null;
    resolvedByTaskId: string | null;
    resolvedAt: string | null;
    publishedAt: string;
  }[];
  empty: React.ReactNode;
  projectId: string;
}): React.ReactNode {
  const rollback = useRollbackArtifact();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (items.length === 0) return empty;
  const doRollback = (publishId: string): void => {
    rollback.mutate(
      { projectId, publishId },
      {
        onSuccess: () => {
          toast('success', '已回滚到该提交之前的状态');
          setConfirmingId(null);
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '回滚失败'),
      },
    );
  };

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
              {h.rolledBack ? (
                <Badge tone="neutral">已回滚</Badge>
              ) : h.status === 'resolved' ? (
                <Badge tone="ok">已裁决发布</Badge>
              ) : h.status === 'escalated' ? (
                <Badge tone="err">待人工介入</Badge>
              ) : h.status === 'open' ? (
                <Badge tone="warn">第一负责人裁决中</Badge>
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
          {h.status === 'open' && h.resolutionTaskId && (
            <div style={{ fontSize: 'var(--text-xs)' }}>
              已派给第一负责人：{' '}
              <a href={`#/tasks/${h.resolutionTaskId}`} style={{ color: 'var(--accent)' }}>
                进入裁决 Task
              </a>
            </div>
          )}
          {h.status === 'escalated' && h.resolutionTaskId && (
            <div style={{ fontSize: 'var(--text-xs)' }}>
              自动裁决已停止：{' '}
              <a href={`#/tasks/${h.resolutionTaskId}`} style={{ color: 'var(--accent)' }}>
                进入裁决 Task 重试
              </a>
            </div>
          )}
          {h.status === 'resolved' && h.resolvedByTaskId && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
              裁决 Task：<a href={`#/tasks/${h.resolvedByTaskId}`}>{h.resolvedByTaskId}</a>
            </div>
          )}
          {!h.blocked && !h.rolledBack && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
              {confirmingId === h.id ? (
                <>
                  <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>确认回滚此提交？</span>
                  <Button variant="ghost" onClick={() => setConfirmingId(null)}>取消</Button>
                  <Button variant="danger" onClick={() => doRollback(h.id)} loading={rollback.isPending}>
                    确认回滚
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmingId(h.id)} title="用 git revert 撤销此次发布">
                  回滚到此版本
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
