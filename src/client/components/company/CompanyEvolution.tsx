/**
 * E5.4 公司进化（组织记忆控制面）。
 *
 * 四个块：优化报告（补阶段五遗留的审批 UI）/ 晋升候选 / 结构变更历史（回滚）/ 锁定管理。
 * 兑现"自动落地 + 历史可还原 + 手动锁定"的用户侧承诺——此前这些只有后端，无 UI 无 API。
 */
import type React from 'react';
import { useState } from 'react';
import { Card } from '../Card';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Field, Input, Select } from '../Form';
import { EmptyState } from '../EmptyState';
import {
  useOptimizationReports,
  useOptimizationReport,
  useApproveReport,
  useDismissReport,
  useModifyReportItem,
  useRejectReportItem,
  usePromotionCandidates,
  useDismissCandidate,
  useReopenCandidate,
  useStructureChanges,
  useRollbackStructure,
  useLocks,
  useCreateLock,
  useDeleteLock,
  useCompanyCockpit,
} from '../../hooks/queries';

const ITEM_STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'neutral'> = {
  executed: 'ok',
  failed: 'err',
  pending: 'warn',
  pending_offline: 'warn',
  skipped: 'neutral',
  rejected: 'neutral',
  approved: 'info',
};

/** E5.4 支持的自动回滚类型（与后端 applyStructureRollback 对齐）。 */
const ROLLBACKABLE_ENTITY_TYPES = ['tool_registry', 'capability_binding', 'memory_entry'];

export function CompanyEvolution({ companyId }: { companyId: string }): React.ReactElement {
  return (
    <div className="form-stack">
      <OptimizationReportsBlock companyId={companyId} />
      <PromotionCandidatesBlock companyId={companyId} />
      <StructureHistoryBlock />
      <LocksBlock />
    </div>
  );
}

// ── 优化报告（审批）──────────────────────────────────────────────────

function OptimizationReportsBlock({ companyId }: { companyId: string }): React.ReactElement {
  const { data: reports = [], isLoading } = useOptimizationReports(companyId);
  const { data: cockpit } = useCompanyCockpit(companyId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = reports.find((r: any) => r.id === activeId) ?? null;
  const pendingCount = cockpit?.optimization?.pendingActions ?? 0;

  return (
    <Card title={<>运营优化报告{pendingCount > 0 ? <> <Badge tone="warn">{pendingCount} 条待审批</Badge></> : null}</>}>
      <p className="muted">每日自动生成 + 晋升批次；审批后按建议自动调整组织</p>
      {isLoading ? <p className="muted">加载中…</p> : reports.length === 0 ? (
        <EmptyState icon="◌" title="还没有报告" hint="公司上线运行后，每天会生成一份运营优化报告；经验记忆达晋升阈值时也会产生晋升批次。" />
      ) : (
        <div className="form-stack">
          <div className="report-list">
            {reports.map((r: any) => (
              <button key={r.id} type="button" className={`report-row ${activeId === r.id ? 'is-active' : ''}`} onClick={() => setActiveId(r.id)}>
                <Badge tone={r.status === 'generated' ? 'info' : r.status === 'approved' ? 'ok' : 'neutral'}>{r.status}</Badge>
                <span className="mono">{r.createdAt?.slice(0, 10) ?? r.id.slice(0, 8)}</span>
                <span className="truncate">{r.report?.summary ?? ''}</span>
              </button>
            ))}
          </div>
          {active && <ReportDetail reportId={active.id} />}
        </div>
      )}
    </Card>
  );
}

function ReportDetail({ reportId }: { reportId: string }): React.ReactElement {
  const { data, isLoading } = useOptimizationReport(reportId);
  const approve = useApproveReport();
  const dismiss = useDismissReport();
  const modify = useModifyReportItem();
  const reject = useRejectReportItem();
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [paramsText, setParamsText] = useState('');

  if (isLoading || !data) return <p className="muted">加载中…</p>;
  const report = data.report as any;
  const items = (data.actionItems ?? []) as any[];
  const evolution = report.report?.stats?.evolution;

  return (
    <div className="form-stack">
      <p>{report.report?.summary ?? '（无摘要）'}</p>
      {evolution ? (
        <p className="muted">
          组织记忆：经验 {evolution.lessonsLearned} 条 · 返工反思 {evolution.reworkReflections} 次 · 待晋升 {evolution.pendingPromotions} · 已固化 {evolution.promotedActions}
        </p>
      ) : null}
      {items.length === 0 ? <p className="muted">无建议项。</p> : (
        <div className="form-stack">
          {items.map((item: any) => (
            <div key={item.id} className="evolution-item">
              <div>
                <Badge tone={ITEM_STATUS_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>{' '}
                <strong>{item.description}</strong>
                <p className="muted">{item.reason}</p>
              </div>
              {item.status === 'pending' && (
                <div className="evolution-item-actions">
                  <Button variant="ghost" size="sm" onClick={() => { setEditingItem(item.id); setParamsText(JSON.stringify(item.params ?? {}, null, 2)); }}>参数</Button>
                  <Button variant="ghost" size="sm" onClick={() => reject.mutate({ id: reportId, itemId: item.id }, { onSuccess: () => toast('success', '已拒绝'), onError: (e) => toast('error', (e as Error).message) })}>拒绝</Button>
                  <Button size="sm" onClick={() => approve.mutate({ id: reportId, selectedItemIds: [item.id] }, { onSuccess: () => toast('success', '已执行'), onError: (e) => toast('error', (e as Error).message) })} loading={approve.isPending}>审批执行</Button>
                </div>
              )}
            </div>
          ))}
          {editingItem && (
            <div className="form-stack">
              <Field label="执行参数（JSON）" hint="如 bind_habitual_tool 需补 toolId/capabilityId">
                <textarea value={paramsText} onChange={(e) => setParamsText(e.target.value)} rows={4} style={{ width: '100%' }} />
              </Field>
              <div>
                <Button size="sm" onClick={() => { try { modify.mutate({ id: reportId, itemId: editingItem, params: JSON.parse(paramsText) }, { onSuccess: () => { setEditingItem(null); toast('success', '参数已更新'); }, onError: (e) => toast('error', (e as Error).message) }); } catch { toast('error', 'JSON 格式错误'); } }}>保存参数</Button>{' '}
                <Button size="sm" variant="ghost" onClick={() => setEditingItem(null)}>取消</Button>
              </div>
            </div>
          )}
        </div>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(reportId, { onSuccess: () => toast('success', '已忽略本报告'), onError: (e) => toast('error', (e as Error).message) })}>忽略本报告</Button>
      </div>
    </div>
  );
}

// ── 晋升候选 ─────────────────────────────────────────────────────────

function PromotionCandidatesBlock({ companyId }: { companyId: string }): React.ReactElement {
  // E5 补齐：按公司过滤（跨公司/未归属候选不显示在任何公司页——它们也不进任何 promote 批次）。
  const { data: candidates = [], isLoading } = usePromotionCandidates(undefined, companyId);
  const dismiss = useDismissCandidate();
  const reopen = useReopenCandidate();

  return (
    <Card title="晋升候选">
      <p className="muted">本公司重复经验达阈值后自动聚类；pending 会在每日报告后自动落地，可忽略/恢复</p>
      {isLoading ? <p className="muted">加载中…</p> : candidates.length === 0 ? (
        <EmptyState icon="◌" title="暂无晋升候选" hint="员工积累经验记忆后，同 fingerprint 重复 3 次或跨 2 人会生成候选。" />
      ) : (
        <div className="form-stack">
          {candidates.map((cand: any) => (
            <div key={cand.id} className="evolution-item">
              <div>
                <Badge tone={cand.status === 'pending' ? 'warn' : 'neutral'}>{cand.status}</Badge>{' '}
                <span className="mono">{cand.fingerprint}</span>
                <p className="muted">重复 {cand.count} 次 · {cand.distinctProfiles} 人 · 样本：{(cand.sampleContents?.[0] ?? '').slice(0, 100)}</p>
              </div>
              <div>
                {cand.status === 'pending'
                  ? <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(cand.id, { onSuccess: () => toast('success', '已忽略该候选'), onError: (e) => toast('error', (e as Error).message) })}>忽略</Button>
                  : <Button variant="ghost" size="sm" onClick={() => reopen.mutate(cand.id, { onSuccess: () => toast('success', '已恢复该候选'), onError: (e) => toast('error', (e as Error).message) })}>恢复</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── 结构变更历史（回滚）──────────────────────────────────────────────

function StructureHistoryBlock(): React.ReactElement {
  // E5 补齐：按实体过滤（API 支持 entityType/entityId；全局列表默认最近 50 条）。
  const [filterType, setFilterType] = useState('');
  const [filterId, setFilterId] = useState('');
  const appliedFilter = filterType.trim() && filterId.trim()
    ? { entityType: filterType.trim(), entityId: filterId.trim() }
    : {};
  const { data: changes = [], isLoading } = useStructureChanges(appliedFilter);
  const rollback = useRollbackStructure();

  return (
    <Card title="结构变更历史">
      <p className="muted">自动落地改了什么、何时、为何；支持的类型可一键回滚</p>
      <div className="settings-field-grid">
        <Field label="按实体类型过滤">
          <Select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">全部类型</option>
            <option value="tool_registry">tool_registry</option>
            <option value="capability_binding">capability_binding</option>
            <option value="memory_entry">memory_entry</option>
            <option value="workflow">workflow</option>
          </Select>
        </Field>
        <Field label="实体 ID" hint="与类型同时填写才生效">
          <Input value={filterId} onChange={(e) => setFilterId(e.target.value)} placeholder="entityId（可选）" />
        </Field>
        {Object.keys(appliedFilter).length > 0 && (
          <div><Button variant="ghost" size="sm" onClick={() => { setFilterType(''); setFilterId(''); }}>清除过滤</Button></div>
        )}
      </div>
      {isLoading ? <p className="muted">加载中…</p> : changes.length === 0 ? (
        <EmptyState icon="◌" title="还没有结构变更" hint="晋升建议自动落地或回滚时会记录到这里。" />
      ) : (
        <div className="form-stack">
          {changes.map((ch: any) => {
            const rollbackable = ROLLBACKABLE_ENTITY_TYPES.includes(ch.entityType) && ch.field !== '__rollback__';
            return (
              <div key={ch.id} className="evolution-item">
                <div>
                  <span className="mono">{ch.entityType}/{ch.entityId}</span> <strong>{ch.field}</strong>
                  <p className="muted">
                    {String(ch.oldValue ?? '∅').slice(0, 60)} → {String(ch.newValue ?? '∅').slice(0, 60)}
                    {' · '}{ch.source}{ch.reason ? ` · ${ch.reason}` : ''}{' · v'}{ch.version}{' · '}{ch.changedAt?.slice(0, 16)}
                  </p>
                </div>
                {/* 复核修复：v1 记录也要能回滚（toVersion=0 即"撤销这次变更"——最常见的 undo）。
                    此前 `ch.version > 1` 把 v1 挡掉，导致单次自动落地根本无法在 UI 撤销。 */}
                {rollbackable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={rollback.isPending}
                    onClick={() => rollback.mutate(
                      { entityType: ch.entityType, entityId: ch.entityId, toVersion: ch.version - 1 },
                      {
                        onSuccess: (out: any) => toast('success', out.unsupported?.length ? `已回滚 ${out.applied.length} 项；${out.unsupported.length} 项不支持自动回滚，请手动` : '已回滚'),
                        onError: (e) => toast('error', (e as Error).message),
                      },
                    )}
                  >
                    回滚
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ── 锁定管理 ─────────────────────────────────────────────────────────

function LocksBlock(): React.ReactElement {
  const { data: locks = [], isLoading } = useLocks();
  const createLock = useCreateLock();
  const deleteLock = useDeleteLock();
  const [entityType, setEntityType] = useState('tool_registry');
  const [entityId, setEntityId] = useState('');
  const [scope, setScope] = useState<'personal' | 'org'>('org');
  const [fieldsText, setFieldsText] = useState('');
  const [reason, setReason] = useState('');

  const submit = (): void => {
    if (!entityId.trim()) {
      toast('error', 'entityId 不能为空');
      return;
    }
    const lockedFields = fieldsText.split(',').map((s) => s.trim()).filter(Boolean);
    createLock.mutate(
      { entityType, entityId: entityId.trim(), scope, lockedFields, reason: reason.trim() || undefined },
      { onSuccess: () => { setEntityId(''); setFieldsText(''); setReason(''); toast('success', '已锁定'); }, onError: (e) => toast('error', (e as Error).message) },
    );
  };

  return (
    <Card title="锁定管理">
      <div className="form-stack">
        <p className="muted">锁定的实体/字段不会被自动落地修改（个人锁 / 组织锁）；空字段清单 = 全锁</p>
        <div className="settings-field-grid">
          <Field label="实体类型">
            <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="tool_registry">tool_registry（工具）</option>
              <option value="capability_binding">capability_binding（能力绑定）</option>
              <option value="memory_entry">memory_entry（记忆）</option>
              <option value="workflow">workflow（工作流）</option>
              <option value="agent_profile">agent_profile（员工档案）</option>
            </Select>
          </Field>
          <Field label="实体 ID" hint="如 tool_registry 的工具 id；memory_entry 用 profileId">
            <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="entityId" />
          </Field>
          <Field label="作用域">
            <Select value={scope} onChange={(e) => setScope(e.target.value as 'personal' | 'org')}>
              <option value="org">组织锁（org）</option>
              <option value="personal">个人锁（personal）</option>
            </Select>
          </Field>
          <Field label="锁定字段" hint="逗号分隔；留空 = 全锁">
            <Input value={fieldsText} onChange={(e) => setFieldsText(e.target.value)} placeholder="is_default" />
          </Field>
          <Field label="原因">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="为什么锁（可选）" />
          </Field>
        </div>
        <div><Button size="sm" onClick={submit} loading={createLock.isPending}>加锁</Button></div>
        {isLoading ? <p className="muted">加载中…</p> : locks.length === 0 ? (
          <p className="muted">暂无锁定。</p>
        ) : (
          locks.map((lock: any) => (
            <div key={lock.id} className="evolution-item">
              <div>
                <Badge tone={lock.scope === 'org' ? 'err' : 'warn'}>{lock.scope}</Badge>{' '}
                <span className="mono">{lock.entityType}/{lock.entityId}</span>
                <p className="muted">{lock.lockedFields.length === 0 ? '全锁' : `字段：${lock.lockedFields.join(', ')}`}{lock.reason ? ` · ${lock.reason}` : ''}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => deleteLock.mutate({ entityType: lock.entityType, entityId: lock.entityId, scope: lock.scope }, { onSuccess: () => toast('success', '已解锁'), onError: (e) => toast('error', (e as Error).message) })}>解锁</Button>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
