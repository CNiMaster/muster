import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies, useCompanyCockpit, useProject, useBusinessReviews } from '../hooks/queries';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
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
  const { data: companies, isLoading } = useCompanies();
  const activeCompanies = (companies ?? []).filter((c) => !c.archivedAt);
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
          <span className="home-kicker">MUSTER · COMPANY DESK</span>
          <h1>你的公司，<br /><em>现在进展如何？</em></h1>
          <p>查看每支团队的运行现场，进入公司继续决策与交付。</p>
        </div>
        <div className="home-hero-side">
          <Link className="home-create-company" to="/companies/wizard">
            <span className="home-create-icon" aria-hidden="true">＋</span>
            <span><strong>创建新公司</strong><small>从团队蓝图开始</small></span>
            <span aria-hidden="true">↗</span>
          </Link>
          <dl className="home-overview-stats" aria-label="公司概况">
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
          <span><strong>{pendingCount} 项业务产物等待审批</strong><small>你的决定将影响员工接下来的工作</small></span>
          <span aria-hidden="true">处理审批 →</span>
        </Link>
      )}

      <section className="home-company-section" aria-labelledby="home-company-title">
        <header className="home-section-heading">
          <div>
            <span className="home-section-index">01</span>
            <div>
              <h2 id="home-company-title">公司现场</h2>
              <p>状态、团队与项目进度集中在一张卡片里。</p>
            </div>
          </div>
          {activeCompanies.length > 0 && <Link to="/companies">管理全部公司 <span aria-hidden="true">→</span></Link>}
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
              title="还没有在营公司"
              hint="选择适合的公司模板，确认团队蓝图后开始第一个项目。"
              action={<Link className="mu-btn mu-btn-primary mu-btn-md" to="/companies/wizard">创建第一家公司</Link>}
            />
          </div>
        )}
        <div className="home-company-grid">
          {previewCompanies.map((company, index) => <CompanyCard key={company.id} company={company} index={index} />)}
        </div>
        {activeCompanies.length > 4 && (
          <Link className="home-more-companies" to="/companies">
            <span>另有 {activeCompanies.length - 4} 家公司</span><strong>查看完整公司名册 →</strong>
          </Link>
        )}
      </section>

      <footer className="home-system-foot">
        <span><i className={health?.status === 'ok' ? 'is-ok' : ''} />本地服务 {health?.status === 'ok' ? '运行正常' : health?.status ?? '检查中'}</span>
        <span>版本 {health?.version ?? '—'}</span>
        {archivedCount > 0 && <Link to="/companies">{archivedCount} 家已归档公司</Link>}
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
        <div><strong>{data?.employees.total ?? '—'}</strong><span>员工</span><small>{data ? `${data.employees.online} 位在线` : '读取中'}</small></div>
        <div><strong>{data?.projects.total ?? '—'}</strong><span>项目</span><small>{data ? `${data.projects.active} 个进行中` : '读取中'}</small></div>
        <div className={attention > 0 ? 'has-attention' : ''}><strong>{data ? attention : '—'}</strong><span>待关注</span><small>{data ? (attention > 0 ? '需要你判断' : '当前顺畅') : '读取中'}</small></div>
      </div>

      <footer>
        <div className="home-company-next">
          <span>建议下一步</span>
          <strong>{data?.nextAction.label ?? '打开公司驾驶舱'}</strong>
        </div>
        <Link className="home-company-enter" to={data?.nextAction.href ?? `/companies/${company.id}`} aria-label={`进入${company.name}`}>
          <span aria-hidden="true">→</span>
        </Link>
      </footer>
    </article>
  );
}
