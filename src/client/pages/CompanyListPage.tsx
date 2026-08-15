/**
 * 工作台列表页：搜索/筛选/改名/归档/删除/创建入口。
 * 在营工作台默认展示；归档工作台折叠展示（不隐藏）。
 */
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Input } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import {
  useArchiveCompany,
  useCompanyList,
  useDeleteCompany,
  useUnarchiveCompany,
  useUpdateCompany,
} from '../hooks/queries';
import type { Company } from '../api/types';

const COMPANY_KIND_LABELS: Record<string, string> = {
  general: '通用团队',
  software: '软件研发',
  content: '内容创作',
  novel: '长篇小说',
};

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部类型' },
  { value: 'general', label: '通用团队' },
  { value: 'software', label: '软件研发' },
  { value: 'content', label: '内容创作' },
  { value: 'novel', label: '长篇小说' },
];

export function CompanyListPage(): React.ReactElement {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // 搜索/筛选用延迟提交：输入停顿后触发查询。
  const [debouncedQ, setDebouncedQ] = useState('');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const activeFilter = { q: debouncedQ || undefined, kind: kind || undefined, status: 'active' as const };
  const archivedFilter = { q: debouncedQ || undefined, kind: kind || undefined, status: 'archived' as const };
  const { data: active = [], isLoading: activeLoading } = useCompanyList(activeFilter);
  const { data: archived = [], isLoading: archivedLoading } = useCompanyList(archivedFilter);

  return (
    <div className="home">
      <header className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>我的工作台</h1>
          <p className="subtitle">管理所有工作台：改名、归档（暂停营业）、删除或创建新工作台。</p>
        </div>
        <Link className="mu-btn mu-btn-primary mu-btn-md" to="/companies/wizard">
          <span>创建工作台</span>
        </Link>
      </header>

      <Card className="section">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input
            placeholder="搜索工作台名称…"
            value={q}
            onChange={(e) => setQ((e.target as HTMLInputElement).value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select
            className="mu-input"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            style={{ minWidth: 140 }}
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </Card>

      <Card
        title="在营工作台"
        className="section"
        actions={<Badge tone="ok">{active.length}</Badge>}
      >
        {activeLoading && (
          <div className="mu-skel-stack">
            <CardSkeleton />
            <div style={{ height: 8 }} />
            <CardSkeleton />
          </div>
        )}
        {!activeLoading && active.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title={debouncedQ || kind ? '没有匹配的工作台' : '还没有工作台'}
            hint={debouncedQ || kind ? '试试调整搜索或筛选条件。' : '选择工作台模板，组建团队并创建首个项目。'}
          />
        )}
        <ul className="entity-list">
          {active.map((c) => (
            <CompanyRow key={c.id} company={c} />
          ))}
        </ul>
      </Card>

      {archived.length > 0 && (
        <Card className="section">
          <details className="details-collapse" open={showArchived}>
            <summary onClick={() => setShowArchived((v) => !v)} style={{ cursor: 'pointer' }}>
              <span style={{ marginRight: 8 }}>归档工作台</span>
              <Badge tone="neutral">{archived.length}</Badge>
              <span className="muted" style={{ marginLeft: 12, fontSize: '0.85em' }}>
                已暂停营业，可随时重开
              </span>
            </summary>
            {archivedLoading && <CardSkeleton />}
            <ul className="entity-list" style={{ marginTop: 12 }}>
              {archived.map((c) => (
                <CompanyRow key={c.id} company={c} />
              ))}
            </ul>
          </details>
        </Card>
      )}
    </div>
  );
}

function CompanyRow({ company }: { company: Company }): React.ReactElement {
  const isArchived = !!company.archivedAt;
  const update = useUpdateCompany();
  const archive = useArchiveCompany();
  const unarchive = useUnarchiveCompany();
  const remove = useDeleteCompany();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(company.name);

  const startEdit = (): void => {
    setDraftName(company.name);
    setEditing(true);
  };
  const saveName = (): void => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      toast('error', '工作台名称不能为空');
      return;
    }
    if (trimmed === company.name) {
      setEditing(false);
      return;
    }
    update.mutate(
      { id: company.id, name: trimmed },
      {
        onSuccess: () => { toast('success', '已改名'); setEditing(false); },
        onError: (err: unknown) => toast('error', (err as Error).message ?? '改名失败'),
      },
    );
  };

  const doArchive = (): void => {
    if (company.state !== 'off') {
      toast('error', '请先下班再归档');
      return;
    }
    const reason = window.prompt('归档原因（可选，便于以后辨认）') ?? '';
    archive.mutate(
      { id: company.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => toast('success', '已归档（暂停营业）'),
        onError: (err: unknown) => toast('error', (err as Error).message ?? '归档失败'),
      },
    );
  };
  const doUnarchive = (): void => {
    unarchive.mutate(
      { id: company.id },
      {
        onSuccess: () => toast('success', '已取消归档，回到下班状态'),
        onError: (err: unknown) => toast('error', (err as Error).message ?? '取消归档失败'),
      },
    );
  };
  const doDelete = (): void => {
    if (!window.confirm(`确认彻底删除工作台「${company.name}」？\n此操作不可撤销，工作台所有项目、Task、智能体任职将被删除（全局智能体档案保留）。`)) return;
    remove.mutate(
      { id: company.id },
      {
        onSuccess: () => toast('success', '工作台已删除'),
        onError: (err: unknown) => toast('error', (err as Error).message ?? '删除失败'),
      },
    );
  };

  return (
    <li style={{ flexWrap: 'wrap', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 8 }}>
        {editing ? (
          <>
            <Input value={draftName} onChange={(e) => setDraftName((e.target as HTMLInputElement).value)} style={{ flex: 1 }} />
            <Button size="sm" onClick={saveName} loading={update.isPending}>保存</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
          </>
        ) : (
          <Link to={`/companies/${company.id}`} style={{ flex: 1 }}>
            <strong>{company.name}</strong>{' '}
            <span className="muted">({COMPANY_KIND_LABELS[company.kind] ?? company.kind})</span>
          </Link>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isArchived ? (
          <Badge tone="neutral">已归档</Badge>
        ) : (
          <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>
            {stateLabel(company.state)}
          </Badge>
        )}
        {!editing && (
          <>
            {!isArchived && company.state === 'off' && (
              <Button size="sm" variant="ghost" onClick={startEdit} title="改名">改名</Button>
            )}
            {!isArchived && company.state !== 'off' && (
              <span className="muted" style={{ fontSize: '0.8em' }} title="请先下班再改名">上班中不可改名</span>
            )}
            {isArchived ? (
              <>
                <Button size="sm" onClick={doUnarchive} loading={unarchive.isPending}>重开</Button>
                <Button size="sm" variant="danger" onClick={doDelete} loading={remove.isPending}>删除</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={doArchive} loading={archive.isPending}>归档</Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
