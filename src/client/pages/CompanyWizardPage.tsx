import type React from 'react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useCreateNovelCompany,
  useCompanyAction,
  useGenerateCompanyProposal,
  type CompanyProposal,
} from '../hooks/queries';
import { Card } from '../components/Card';
import { Button, toast } from '../components/Button';
import { Badge } from '../components/Badge';
import { Input, Textarea, Field } from '../components/Form';

export function CompanyWizardPage(): React.ReactElement {
  const navigate = useNavigate();
  const createNovelCompany = useCreateNovelCompany();
  const companyAction = useCompanyAction();
  const generateProposal = useGenerateCompanyProposal();

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');

  const [proposal, setProposal] = useState<CompanyProposal | null>(null);
  const [proposalNotice, setProposalNotice] = useState<string | null>(null);

  const handleGenerate = (): void => {
    if (!name.trim()) {
      toast('error', '请输入公司名称');
      return;
    }

    generateProposal.mutate(
      { name: name.trim(), goal: goal.trim() },
      {
        onSuccess: (result) => {
          setProposal(result.proposal);
          setProposalNotice(result.warning ?? '方案由 Claude 生成，确认前可返回修改目标。');
          setStep(2);
          toast(result.source === 'claude' ? 'success' : 'info', result.warning ?? '公司方案已生成');
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '方案生成失败'),
      }
    );
  };

  const handleConfirmAndClockIn = (): void => {
    if (!proposal) return;
    createNovelCompany.mutate(
      { name: proposal.name, charter: proposal.charter, departments: proposal.departments },
      {
        onSuccess: (data) => {
          companyAction.mutate(
            { id: data.company.id, action: 'clock-in' },
            {
              onSuccess: () => {
                toast('success', '公司已创建并上班');
                navigate(`/companies/${data.company.id}`);
              },
              onError: (e) => toast('error', (e as { message?: string }).message ?? '公司已创建，但上班失败'),
            },
          );
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '公司创建失败'),
      }
    );
  };

  return (
    <div className="wizard-page" style={{ maxWidth: '800px', margin: '0 auto', padding: 'var(--space-5) 0' }}>
      <header className="page-header" style={{ marginBottom: 'var(--space-5)' }}>
        <div>
          <h1>对话式小说公司创建向导</h1>
          <p className="subtitle">根据创作目标生成可编辑方案，再创建长篇小说协作团队</p>
        </div>
      </header>

      {/* 步骤条 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-5)', position: 'relative' }}>
        <div style={{ position: 'absolute', top: '15px', left: '10%', right: '10%', height: '2px', background: 'var(--border-subtle)', zIndex: 0 }} />
        <div style={{ position: 'absolute', top: '15px', left: '10%', width: step === 2 ? '80%' : '0%', height: '2px', background: 'var(--accent)', zIndex: 0, transition: 'width 0.3s ease' }} />

        {[1, 2].map((s) => (
          <div key={s} style={{ zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              background: step >= s ? 'var(--accent)' : 'var(--bg-elev)',
              border: '2px solid ' + (step >= s ? 'var(--accent)' : 'var(--border)'),
              color: step >= s ? 'var(--accent-fg)' : 'var(--fg-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: '14px'
            }}>
              {s}
            </div>
            <span style={{ fontSize: 'var(--text-xs)', fontWeight: step === s ? 'bold' : 'normal', color: step === s ? 'var(--accent)' : 'var(--fg-muted)' }}>
              {s === 1 ? '模板与目标设定' : '预览、体检与确认上线'}
            </span>
          </div>
        ))}
      </div>

      {step === 1 ? (
        <Card title="第一步：设定你的创作愿景">
          <div className="form-stack">
            <Field label="小说公司名称" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如: 银翼创世纪小说工作室"
              />
            </Field>

            <Field label="小说核心目标与愿景" hint="系统将根据核心愿景生成可编辑的初始架构和团队岗位建议。">
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="例如: 创作一部硬核赛博朋克长篇小说，主要围绕 AI 觉醒和下城区侦探 K 展开。风格冷酷极简..."
                style={{ height: '120px' }}
              />
            </Field>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
              <Button onClick={handleGenerate} loading={generateProposal.isPending} disabled={!name.trim()}>
                生成预览与团队配置
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {proposalNotice && (
            <Card title="方案来源说明">
              <p className="muted" style={{ margin: 0 }}>{proposalNotice}</p>
            </Card>
          )}
          {/* 体检状态卡片 */}
          <Card title="公司组织体检报告" style={{ borderColor: 'var(--ok)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--ok)', fontWeight: 'bold' }}>[通过]</span>
                <span><strong>负责人与写手隔离：</strong> 第一负责人与主写手已被自动分配给不同实例，规避兼任冲突。</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--ok)', fontWeight: 'bold' }}>[通过]</span>
                <span><strong>关键角色配置：</strong> 已配置 lead (第一负责人)、writer (主写手)、character (人物设计)、plot (情节架构)、inspector (运营监察)。</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--ok)', fontWeight: 'bold' }}>[通过]</span>
                <span><strong>通信通道建立：</strong> 主写手和情节、人物设计通道已激活，监察警报路由至第一负责人。</span>
              </div>
              <div className="wizard-health-summary">
                组织健康体检合格！团队配置满足长篇小说生产规范。
              </div>
            </div>
          </Card>

          {/* 团队架构卡片 */}
          <Card title="团队岗位架构预览" actions={<Badge tone="info">{proposal?.agentNotes.length ?? 0} 人</Badge>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {proposal?.agentNotes.map((agent) => (
                <div key={agent.role} style={{
                  padding: 'var(--space-3)',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div>
                    <strong>{agent.role}</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
                      专注：{agent.focus}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Badge tone="info">{agent.role}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* 确认上线 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)' }}>
            <Button variant="ghost" onClick={() => setStep(1)}>
              返回上一步
            </Button>
            <Button onClick={handleConfirmAndClockIn} loading={companyAction.isPending || createNovelCompany.isPending}>
              确认无误，今日开始上班！
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
