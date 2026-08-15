import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCompanies, useCompanyCockpit, useProject, useBusinessReviews, useQuickProject } from '../hooks/queries';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { EmptyState, Icons } from '../components/EmptyState';
import { OnboardingGuide } from '../components/OnboardingGuide';
import { FirstRunWizard } from '../components/FirstRunWizard';
import { CardSkeleton } from '../components/Skeleton';
import { readRecentProjectId, writeRecentProjectId } from '../hooks/useRecentProject';
import type { Company } from '../api/types';

interface HealthResp {
  status: string;
  version: string;
  time: string;
}

const COMPANY_KIND_LABELS: Record<string, string> = {
  general: '通用团队',
  software: '软件研发',
  content: '内容创作',
  novel: '长篇小说',
  marketing: '品牌营销',
  consulting: '行业咨询',
};

const COMPANY_KIND_MARKS: Record<string, string> = {
  general: '/images/tmpl_general.jpg',
  software: '/images/tmpl_software.jpg',
  content: '/images/tmpl_content.jpg',
  novel: '/images/tmpl_novel.jpg',
  marketing: '/images/tmpl_marketing.jpg',
  consulting: '/images/tmpl_consulting.jpg',
};

const COMPANY_KIND_DESCRIPTIONS: Record<string, string> = {
  general: '跨职能协作与项目交付',
  software: '产品、研发与质量协同',
  content: '策划、创作与内容发布',
  novel: '长篇故事与连续性创作',
  marketing: '调研、策划、文案与公关传播',
  consulting: '课题研究、数据分析与研报咨询',
};

export function HomePage(): React.ReactElement {
  const navigate = useNavigate();
  const { data: companies, isLoading } = useCompanies();
  const activeCompanies = (companies ?? []).filter((c) => !c.archivedAt);
  const quickProject = useQuickProject();
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickDesc, setQuickDesc] = useState('');
  const { data: pendingReviews = [] } = useBusinessReviews({ status: 'pending' });
  const pendingCount = pendingReviews.length;
  const [recentProjectId, setRecentProjectId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readRecentProjectId(window.localStorage));
  const recentProject = useProject(recentProjectId ?? undefined);
  const [health, setHealth] = useState<HealthResp | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!recentProject.isError || !recentProjectId) return;
    writeRecentProjectId(window.localStorage, null);
    setRecentProjectId(null);
  }, [recentProject.isError, recentProjectId]);

  const previewCompanies = activeCompanies.slice(0, 4);
  const archivedCount = (companies ?? []).length - activeCompanies.length;
  const onlineCount = activeCompanies.filter((company) => company.state === 'online').length;
  const attentionCount = activeCompanies.filter((company) => company.state === 'review_paused' || company.state === 'draining').length;

  return (
    <div className="home home-command-center">
      <header className="home-hero">
        <div className="home-hero-copy">
          <span className="home-kicker">MUSTER · WORK DESK</span>
          <h1>我有件事要办，<br /><em>现在开始。</em></h1>
          <p>从要做的事开始：系统自动安排工作台与合适的智能体，组织由活决定。</p>
        </div>
        <div className="home-hero-side">
          {/* 蓝图组织批次4c：项目优先入口——主 CTA 是"办事"，不是"选工作台"。 */}
          <button
            type="button"
            className="home-create-company"
            onClick={() => setQuickOpen(true)}
          >
            <span className="home-create-icon" aria-hidden="true">＋</span>
            <span><strong>新建项目</strong><small>不用选工作台，直接开工</small></span>
            <span aria-hidden="true">↗</span>
          </button>
          {quickOpen && (
            <div style={{ display: 'grid', gap: 8, padding: 12, border: '1px solid var(--mu-border)', borderRadius: 10, background: 'var(--mu-surface)' }}>
              <input
                className="mu-input"
                placeholder="要做的事（项目名）"
                value={quickName}
                onChange={(e) => setQuickName((e.target as HTMLInputElement).value)}
              />
              <textarea
                className="mu-input"
                placeholder="简单描述目标（可留空，进项目后再补）"
                value={quickDesc}
                onChange={(e) => setQuickDesc((e.target as HTMLTextAreaElement).value)}
                rows={2}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  loading={quickProject.isPending}
                  disabled={quickName.trim().length === 0}
                  onClick={() => {
                    quickProject.mutate(
                      { name: quickName.trim(), description: quickDesc.trim() || undefined },
                      {
                        onSuccess: (result) => {
                          toast('success', result.createdWorkspace ? '已创建默认工作台，项目开工' : '项目已创建');
                          navigate(`/projects/${result.project.id}`);
                        },
                        onError: (e) => toast('error', (e as Error).message),
                      },
                    );
                  }}
                >
                  开工
                </Button>
                <Button variant="ghost" onClick={() => setQuickOpen(false)}>取消</Button>
              </div>
            </div>
          )}
          <dl className="home-overview-stats" aria-label="工作概况">
            <div><dt>在营</dt><dd>{activeCompanies.length}</dd></div>
            <div><dt>工作中</dt><dd>{onlineCount}</dd></div>
            <div><dt>待关注</dt><dd>{attentionCount + pendingCount}</dd></div>
          </dl>
        </div>
      </header>

      <OnboardingGuide hasCompany={activeCompanies.length > 0} />
      <FirstRunWizard />

      {recentProject.data && (
        <div className="home-resume-project">
          <span className="home-resume-mark" aria-hidden="true">↳</span>
          <div>
            <span>继续上次项目</span>
            <strong>{recentProject.data.name}</strong>
          </div>
          <Link to={`/projects/${recentProject.data.id}`}>回到工作现场 <span aria-hidden="true">→</span></Link>
        </div>
      )}

      {pendingCount > 0 && (
        <Link className="home-review-notice" to="/reviews">
          <span className="home-review-pulse" aria-hidden="true" />
          <span><strong>{pendingCount} 项业务产物等待审批</strong><small>你的决定将影响智能体接下来的工作</small></span>
          <span aria-hidden="true">处理审批 →</span>
        </Link>
      )}

      <section className="home-company-section" aria-labelledby="home-company-title">
        <header className="home-section-heading">
          <div>
            <span className="home-section-index">01</span>
            <div>
              <h2 id="home-company-title">工作台现场</h2>
              <p>状态、团队与项目进度集中在一张卡片里。</p>
            </div>
          </div>
          {activeCompanies.length > 0 && <Link to="/companies">管理全部工作台 <span aria-hidden="true">→</span></Link>}
        </header>

        {isLoading && (
          <div className="home-company-grid">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        )}
        {activeCompanies.length === 0 && !isLoading && (
          <div className="home-empty-company">
            <EmptyState
              icon={Icons.empty}
              title="从第一件事开始"
              hint="不用先建工作台：新建项目会自动落在默认工作台，智能体和人设随活匹配。"
              action={(
                <button type="button" className="mu-btn mu-btn-primary mu-btn-md" onClick={() => setQuickOpen(true)}>
                  新建项目
                </button>
              )}
            />
          </div>
        )}
        <div className="home-company-grid">
          {previewCompanies.map((company, index) => <CompanyCard key={company.id} company={company} index={index} />)}
        </div>
        {activeCompanies.length > 4 && (
          <Link className="home-more-companies" to="/companies">
            <span>另有 {activeCompanies.length - 4} 家工作台</span><strong>查看完整工作台名册 →</strong>
          </Link>
        )}
      </section>

      <footer className="home-system-foot">
        <span><i className={health?.status === 'ok' ? 'is-ok' : ''} />本地服务 {health?.status === 'ok' ? '运行正常' : health?.status ?? '检查中'}</span>
        <span>版本 {health?.version ?? '—'}</span>
        {archivedCount > 0 && <Link to="/companies">{archivedCount} 家已归档工作台</Link>}
      </footer>
    </div>
  );
}

function CompanyCard({ company, index }: { company: Company; index: number }): React.ReactElement {
  const cockpit = useCompanyCockpit(company.id);
  const data = cockpit.data;
  const attention = (data?.projects.attention ?? 0) + (data?.approvals.pending ?? 0) + (data?.employees.blocked ?? 0);

  return (
    <article
      className={`home-company-card company-kind-${company.kind}`}
      style={{ '--company-order': index } as React.CSSProperties}
    >
      <div className="home-company-card-topline" aria-hidden="true" />
      <header>
        <div className="home-company-mark" aria-hidden="true" style={{ overflow: 'hidden', padding: 0 }}>
          {COMPANY_KIND_MARKS[company.kind] ? (
            <img src={COMPANY_KIND_MARKS[company.kind]} alt={company.kind} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
          ) : (
            company.name.slice(0, 1)
          )}
        </div>
        <div className="home-company-identity">
          <span>{COMPANY_KIND_LABELS[company.kind] ?? company.kind}</span>
          <Link to={`/companies/${company.id}`}>{company.name}</Link>
          <small>{COMPANY_KIND_DESCRIPTIONS[company.kind] ?? 'Agent 团队与项目协作'}</small>
        </div>
        <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>
          {stateLabel(company.state)}
        </Badge>
      </header>

      <div className="home-company-metrics" aria-label={`${company.name}运行概况`}>
        <div><strong>{data?.employees.total ?? '—'}</strong><span>智能体</span><small>{data ? `${data.employees.online} 位在线` : '读取中'}</small></div>
        <div><strong>{data?.projects.total ?? '—'}</strong><span>项目</span><small>{data ? `${data.projects.active} 个进行中` : '读取中'}</small></div>
        <div className={attention > 0 ? 'has-attention' : ''}><strong>{data ? attention : '—'}</strong><span>待关注</span><small>{data ? (attention > 0 ? '需要你判断' : '当前顺畅') : '读取中'}</small></div>
      </div>

      <footer>
        <div className="home-company-next">
          <span>建议下一步</span>
          <strong>{data?.nextAction.label ?? '打开工作台驾驶舱'}</strong>
        </div>
        <Link className="home-company-enter" to={data?.nextAction.href ?? `/companies/${company.id}`} aria-label={`进入${company.name}`}>
          <span aria-hidden="true">→</span>
        </Link>
      </footer>
    </article>
  );
}
