/**
 * 外包中心：B2B 跨组织任务委派的契约看板。
 *
 * 两栏布局：
 * - 左栏「委派出去的」（甲方角色 source）：发起委派、查看发出契约状态、验收
 * - 右栏「承接的」（乙方角色 target）：查看收到的契约、接受、查看承接任务
 *
 * 状态流转：pending → accepted → in_progress → delivered → reviewing → completed/changes_requested/rejected
 *
 * 「公司」是软件内的本地组织概念。详见 docs/superpowers/specs/2026-08-10-b2b-outsourcing-design.md。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { useCompanies, useCompany, useOutsourceContracts, useDispatchOutsource, useAcceptContract, useReviewContract, useCancelContract } from '../hooks/queries';
import type { OutsourcingContract, ContractState } from '../api/types';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select, Textarea } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';

const STATE_TONE: Record<ContractState, 'ok' | 'warn' | 'err' | 'info' | 'neutral'> = {
  pending: 'warn',
  accepted: 'info',
  in_progress: 'info',
  delivered: 'warn',
  reviewing: 'warn',
  changes_requested: 'err',
  completed: 'ok',
  rejected: 'err',
  cancelled: 'neutral',
};

const STATE_LABEL: Record<ContractState, string> = {
  pending: '待接受',
  accepted: '已接受',
  in_progress: '执行中',
  delivered: '已交付',
  reviewing: '验收中',
  changes_requested: '需返工',
  completed: '已完成',
  rejected: '已拒绝',
  cancelled: '已取消',
};

export function OutsourcingCenterPage(): React.ReactElement {
  const { data: companies } = useCompanies();
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const activeCompanies = (companies ?? []).filter((c) => !c.archivedAt);
  const companyId = selectedCompanyId || activeCompanies[0]?.id || '';

  return (
    <div className="page outsourcing-center">
      <div className="page-head">
        <h1>外包中心</h1>
        <p className="muted">跨组织任务委派。选择一个公司查看其委派出去（甲方）和承接（乙方）的契约。</p>
      </div>
      {activeCompanies.length === 0 ? (
        <EmptyState icon={Icons.empty} title="暂无在营公司" hint="先创建公司，才能发起或承接外包委派。" />
      ) : (
        <>
          <Field label="选择公司视角">
            <Select value={companyId} onChange={(e) => setSelectedCompanyId(e.target.value)}>
              {activeCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          {companyId && <ContractDashboard companyId={companyId} />}
        </>
      )}
    </div>
  );
}

function ContractDashboard({ companyId }: { companyId: string }): React.ReactElement {
  const sourceContracts = useOutsourceContracts(companyId, 'source');
  const targetContracts = useOutsourceContracts(companyId, 'target');
  const { data: company } = useCompany(companyId);

  return (
    <div className="outsourcing-dashboard">
      <div className="outsourcing-col">
        <h2>委派出去的（甲方）</h2>
        <DispatchForm companyId={companyId} />
        <ContractList
          contracts={sourceContracts.data ?? []}
          role="source"
          loading={sourceContracts.isLoading}
          emptyHint="尚未发起任何外包委派。"
        />
      </div>
      <div className="outsourcing-col">
        <h2>承接的（乙方）{company ? `· ${company.name}` : ''}</h2>
        <ContractList
          contracts={targetContracts.data ?? []}
          role="target"
          loading={targetContracts.isLoading}
          emptyHint="暂无收到的外包委派。"
        />
      </div>
    </div>
  );
}

/** 甲方发起委派表单。 */
function DispatchForm({ companyId }: { companyId: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [vendorCompanyId, setVendorCompanyId] = useState('');
  const [requiredCaps, setRequiredCaps] = useState('');
  const dispatch = useDispatchOutsource();
  const { data: companies } = useCompanies();
  const others = (companies ?? []).filter((c) => c.id !== companyId && !c.archivedAt);

  const handleSubmit = (): void => {
    if (!title.trim() || !brief.trim()) {
      toast('error', '请填写标题和简报');
      return;
    }
    dispatch.mutate(
      {
        companyId,
        input: {
          sourceProjectId: '', // 由调用方在项目页发起时填；这里简化为空（后端会校验）
          title: title.trim(),
          brief: brief.trim(),
          requiredCapabilityIds: requiredCaps.split(',').map((s) => s.trim()).filter(Boolean),
          vendorCompanyId: vendorCompanyId || undefined,
          autoDecide: !vendorCompanyId,
        },
      },
      {
        onSuccess: (data) => {
          if (data.contract) {
            toast('success', `已发起委派（决策路径：${data.decision.path}）`);
          } else if (data.decision.path === 'internal') {
            toast('info', `内部可做：${data.decision.reason ?? ''}`);
          } else {
            toast('info', `无可用乙方：${data.decision.reason ?? ''}`);
          }
          setTitle('');
          setBrief('');
          setVendorCompanyId('');
          setRequiredCaps('');
          setOpen(false);
        },
        onError: (e: any) => toast('error', e.message ?? '发起失败'),
      },
    );
  };

  return (
    <Card className="dispatch-form">
      {!open ? (
        <Button variant="primary" onClick={() => setOpen(true)}>+ 发起外包委派</Button>
      ) : (
        <div className="dispatch-form-body">
          <Field label="任务标题">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：游戏角色 UI 原型设计" />
          </Field>
          <Field label="任务简报（公司需求）">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="详细描述需要乙方完成的工作、交付格式..." rows={3} />
          </Field>
          <Field label="所需能力（逗号分隔，决策树用）">
            <Input value={requiredCaps} onChange={(e) => setRequiredCaps(e.target.value)} placeholder="如：ui-design, game-art" />
          </Field>
          <Field label="指定乙方公司（留空走全自动决策树）">
            <Select value={vendorCompanyId} onChange={(e) => setVendorCompanyId(e.target.value)}>
              <option value="">自动选择（决策树）</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <div className="dispatch-form-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSubmit} disabled={dispatch.isPending}>
              {dispatch.isPending ? '发起中…' : '发起委派'}
            </Button>
          </div>
          <p className="muted dispatch-hint">留空乙方时，系统按「内部能做→外包→招聘」全自动决策树选择。</p>
        </div>
      )}
    </Card>
  );
}

/** 契约列表。 */
function ContractList({
  contracts,
  role,
  loading,
  emptyHint,
}: {
  contracts: OutsourcingContract[];
  role: 'source' | 'target';
  loading: boolean;
  emptyHint: string;
}): React.ReactElement {
  if (loading) return <p className="muted">加载契约…</p>;
  if (contracts.length === 0) return <p className="muted outsourcing-empty">{emptyHint}</p>;
  return (
    <ul className="contract-list">
      {contracts.map((c) => (
        <ContractCard key={c.id} contract={c} role={role} />
      ))}
    </ul>
  );
}

/** 单个契约卡片。 */
function ContractCard({ contract, role }: { contract: OutsourcingContract; role: 'source' | 'target' }): React.ReactElement {
  const accept = useAcceptContract();
  const review = useReviewContract();
  const cancel = useCancelContract();
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const { data: companies } = useCompanies();
  const otherCompany = (companies ?? []).find((c) =>
    c.id === (role === 'source' ? contract.targetCompanyId : contract.sourceCompanyId),
  );

  const handleAccept = (): void => {
    // 简化：用乙方公司第一负责人作为对接人（UI 完整版可下拉选）
    if (!otherCompany?.firstAgentId) {
      toast('error', '乙方公司缺少负责人，无法接受');
      return;
    }
    accept.mutate(
      { contractId: contract.id, vendorLiaisonAgentId: otherCompany.firstAgentId },
      {
        onSuccess: () => toast('success', '已接受委派，承接任务已创建'),
        onError: (e: any) => toast('error', e.message ?? '接受失败'),
      },
    );
  };

  const handleReview = (decision: 'completed' | 'changes_requested' | 'rejected'): void => {
    review.mutate(
      { contractId: contract.id, decision, feedback: feedback || undefined },
      {
        onSuccess: () => {
          toast('success', decision === 'completed' ? '验收通过，契约完成' : decision === 'changes_requested' ? '已要求返工' : '已拒绝交付');
          setShowFeedback(false);
          setFeedback('');
        },
        onError: (e: any) => toast('error', e.message ?? '验收失败'),
      },
    );
  };

  const handleCancel = (): void => {
    cancel.mutate(contract.id, {
      onSuccess: () => toast('success', '契约已取消'),
      onError: (e: any) => toast('error', e.message ?? '取消失败'),
    });
  };

  return (
    <li className="contract-card">
      <div className="contract-card-head">
        <span className="contract-title">{contract.title}</span>
        <Badge tone={STATE_TONE[contract.state]}>{STATE_LABEL[contract.state]}</Badge>
        {contract.revisionRound > 0 && <Badge tone="warn">返工 {contract.revisionRound} 次</Badge>}
      </div>
      <p className="contract-brief muted">{contract.brief}</p>
      <div className="contract-meta">
        <span className="muted">{role === 'source' ? '乙方' : '甲方'}：{otherCompany?.name ?? '?'}</span>
        {contract.requiredCapabilityIds.length > 0 && (
          <span className="muted">能力：{contract.requiredCapabilityIds.join(', ')}</span>
        )}
        {contract.outsourcedTaskId && (
          <span className="muted">承接任务：{contract.outsourcedTaskId.slice(0, 12)}…</span>
        )}
      </div>
      {contract.acceptanceCriteria.length > 0 && (
        <details className="contract-criteria">
          <summary>验收标准（{contract.acceptanceCriteria.length}）</summary>
          <ul>
            {contract.acceptanceCriteria.map((ac) => (
              <li key={ac.id}>{ac.criterion}</li>
            ))}
          </ul>
        </details>
      )}
      {contract.feedback && (
        <p className="contract-feedback muted">反馈：{contract.feedback}</p>
      )}

      {/* 操作区 */}
      <div className="contract-actions">
        {/* 乙方操作：pending → accept */}
        {role === 'target' && contract.state === 'pending' && (
          <Button variant="primary" onClick={handleAccept} disabled={accept.isPending}>接受委派</Button>
        )}
        {/* 甲方操作：delivered → 验收 */}
        {role === 'source' && (contract.state === 'delivered' || contract.state === 'reviewing') && (
          <>
            {!showFeedback ? (
              <>
                <Button variant="primary" onClick={() => handleReview('completed')} disabled={review.isPending}>验收通过</Button>
                <Button variant="subtle" onClick={() => setShowFeedback(true)} disabled={review.isPending}>要求返工</Button>
                <Button variant="danger" onClick={() => handleReview('rejected')} disabled={review.isPending}>拒绝</Button>
              </>
            ) : (
              <div className="feedback-row">
                <Input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="返工反馈意见…" />
                <Button variant="subtle" onClick={() => handleReview('changes_requested')} disabled={review.isPending}>提交返工</Button>
                <Button variant="ghost" onClick={() => setShowFeedback(false)}>取消</Button>
              </div>
            )}
          </>
        )}
        {/* 可取消态 */}
        {['pending', 'accepted', 'in_progress', 'delivered'].includes(contract.state) && (
          <Button variant="ghost" onClick={handleCancel} disabled={cancel.isPending}>取消契约</Button>
        )}
      </div>
    </li>
  );
}
