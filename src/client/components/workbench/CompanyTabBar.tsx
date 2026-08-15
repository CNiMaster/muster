/**
 * 工作台改版 批次 2b：工作台标签栏（浏览器式）。
 *
 * 顶部常驻（所有路由）：工作台标签切换 + 新建 + 恢复运营 + 全局项（审批带计数 / 更多 / 设置 / 退出）。
 *
 * L1 生命周期模型（程序代管）：
 * - 工作台状态由程序规划：运行中/收尾中/已暂停；关闭软件时优雅下班（先完成手头任务再退出）。
 * - 上次优雅关机时在运行的工作台带「↻」标记，顶部提供「▶ 恢复运营（N）」一键续跑；
 *   用户手动暂停的工作台只显示「已暂停」，单独手动启动。
 * - 退出按钮 → 进度动画（xx工作台正在下班…✅）→ 全部完成 → "工作已保存，祝您生意兴隆" → 关闭。
 *
 * 标签排序：固定（创建序），状态变化绝不改变位置——只改样式表达（暂停=整体变灰）。
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Company } from '../../api/types';
import { useBeginShutdown, useBusinessReviews, useCompanies, useCompaniesActivity, useProject, useResumeShutdownPaused, useTask } from '../../hooks/queries';
import { Button, toast } from '../Button';
import { companyStateTone, stateLabel } from '../Badge';

const VISIBLE_LIMIT = 6;
const ORDER_STORAGE_KEY = 'muster:company-tab-order';

type ShutdownPhase = 'idle' | 'confirm' | 'draining' | 'bye';

/** 读取用户拖拽排好的工作台顺序（本地持久化）。 */
function readTabOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function CompanyTabBar(): React.ReactElement {
  const { data: companies = [] } = useCompanies();
  const { companyId: routeCompanyId, projectId: routeProjectId, taskId } = useParams();
  const { data: task } = useTask(taskId);
  const effectiveProjectId = routeProjectId ?? task?.projectId;
  const { data: project } = useProject(effectiveProjectId);
  const currentCompanyId = routeCompanyId ?? project?.companyId;
  const { data: pendingReviews = [] } = useBusinessReviews({ status: 'pending' });
  const { data: activity = {} } = useCompaniesActivity();
  const beginShutdown = useBeginShutdown();
  const resume = useResumeShutdownPaused();

  // L3：标签状态三层——工作中（有活跃任务）/ 空闲（在线无任务）/ 已暂停
  const tabStateLabel = (company: Company): string => {
    if (company.state === 'online') return (activity[company.id] ?? 0) > 0 ? '工作中' : '空闲';
    return stateLabel(company.state);
  };

  const active = companies.filter((c) => !c.archivedAt);
  // 拖拽排序：用户排过的在前（保持顺序），新工作台按创建序追加；状态变化永不改位置
  const [tabOrder, setTabOrder] = useState<string[]>(readTabOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  const ordered = active.filter((c) => tabOrder.includes(c.id)).sort((a, b) => tabOrder.indexOf(a.id) - tabOrder.indexOf(b.id));
  const rest = active.filter((c) => !tabOrder.includes(c.id));
  const effectiveActive = [...ordered, ...rest];
  const visible = effectiveActive.slice(0, VISIBLE_LIMIT);
  const overflow = effectiveActive.slice(VISIBLE_LIMIT);
  const pausedCount = active.filter((c) => c.shutdownPaused === 1).length;

  const persistOrder = (ids: string[]): void => {
    setTabOrder(ids);
    try {
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
    } catch {
      /* 存储失败不影响本次会话排序 */
    }
  };
  const handleTabDrop = (targetId: string): void => {
    if (!dragId || dragId === targetId) return;
    const ids = effectiveActive.map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    persistOrder(ids);
    setDragId(null);
  };

  const [phase, setPhase] = useState<ShutdownPhase>('idle');
  const [affected, setAffected] = useState<Array<{ id: string; name: string }>>([]);
  const [states, setStates] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const doExit = async (): Promise<void> => {
    setPhase('draining');
    try {
      const result = await beginShutdown.mutateAsync();
      setAffected(result.affected);
      if (result.total === 0) {
        setPhase('bye');
        return;
      }
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const list = await api.get<Company[]>('/api/companies?status=active');
            const map: Record<string, string> = {};
            for (const c of list) map[c.id] = c.state;
            setStates(map);
            if (result.affected.every((a) => map[a.id] === 'off')) {
              if (pollRef.current) clearInterval(pollRef.current);
              setPhase('bye');
              setTimeout(() => { try { window.close(); } catch { /* 非脚本打开的窗口 close 无效，静默 */ } }, 3000);
            }
          } catch {
            // 服务器已随收尾退出——视为完成
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase('bye');
          }
        })();
      }, 1000);
    } catch (error) {
      toast('error', (error as Error).message);
      setPhase('idle');
    }
  };

  return (
    <header className="company-tabbar">
      <NavLink to="/" className="tabbar-brand" aria-label="Muster 首页">
        <span className="brand-seal" aria-hidden="true">M</span>
      </NavLink>

      <nav className="company-tabs" aria-label="工作台切换">
        {visible.map((company) => (
          <NavLink
            key={company.id}
            to={`/companies/${company.id}`}
            draggable
            onDragStart={() => setDragId(company.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => handleTabDrop(company.id)}
            onDragEnd={() => setDragId(null)}
            className={`company-tab ${company.id === currentCompanyId ? 'is-active' : ''} ${company.state === 'off' ? 'is-paused' : ''} ${dragId === company.id ? 'is-dragging' : ''}`}
            title="拖动可调整顺序"
          >
            <span className="company-tab-name">{company.name}</span>
            <span className={`company-tab-dot tone-${companyStateTone(company.state)} ${company.state === 'online' && (activity[company.id] ?? 0) > 0 ? 'is-live' : ''}`} aria-hidden="true" />
            <span className="company-tab-state">{tabStateLabel(company)}</span>
            {company.shutdownPaused === 1 && company.state !== 'online' && (
              <span className="tabbar-resume-mark" title="上次退出时正在运行，可一键恢复" aria-hidden="true">↻</span>
            )}
          </NavLink>
        ))}
        {overflow.length > 0 && (
          <details className="tab-overflow">
            <summary aria-label="更多工作台">▾</summary>
            <div className="tab-overflow-menu">
              {overflow.map((company) => (
                <NavLink key={company.id} to={`/companies/${company.id}`} className={`company-tab is-overflow ${company.id === currentCompanyId ? 'is-active' : ''} ${company.state === 'off' ? 'is-paused' : ''}`}>
                  <span className="company-tab-name">{company.name}</span>
                  <span className={`company-tab-dot tone-${companyStateTone(company.state)}`} aria-hidden="true" />
                  {company.shutdownPaused === 1 && company.state !== 'online' && <span className="tabbar-resume-mark" aria-hidden="true">↻</span>}
                </NavLink>
              ))}
            </div>
          </details>
        )}
        {pausedCount > 0 && (
          <button type="button" className="tabbar-resume" onClick={() => resume.mutate(undefined, {
            onSuccess: (r: { resumed: number }) => toast('success', r.resumed > 0 ? `已恢复 ${r.resumed} 家工作台运营` : '没有需要恢复的工作台'),
            onError: (error) => toast('error', (error as Error).message),
          })}>
            ▶ 恢复运营（{pausedCount}）
          </button>
        )}
        <NavLink to="/companies/wizard" className="company-tab company-tab-new" aria-label="新建工作台">＋</NavLink>
      </nav>

      <nav className="tabbar-global" aria-label="全局入口">
        <NavLink to="/reviews" className="tabbar-review">
          审批{pendingReviews.length > 0 && <i className="tabbar-count">{pendingReviews.length}</i>}
        </NavLink>
        <details className="tab-overflow">
          <summary>更多</summary>
          <div className="tab-overflow-menu">
            <NavLink to="/companies">工作台名册</NavLink>
            <NavLink to="/agents">智能体库</NavLink>
          </div>
        </details>
        <NavLink to="/settings">设置</NavLink>
        <button type="button" className="tabbar-exit" aria-label="退出并保存" title="退出并保存所有工作" onClick={() => setPhase('confirm')}>⏻</button>
      </nav>

      {phase !== 'idle' && (
        <div className="shutdown-overlay" role="dialog" aria-modal="true" aria-label="退出">
          {phase === 'confirm' && (
            <div className="shutdown-dialog">
              <h2>退出并保存所有工作？</h2>
              <p className="muted">所有工作台会先完成手头任务再下班，之后安全退出。</p>
              <div className="settings-primary-actions">
                <Button variant="ghost" onClick={() => setPhase('idle')}>取消</Button>
                <Button loading={beginShutdown.isPending} onClick={() => void doExit()}>退出</Button>
              </div>
            </div>
          )}
          {phase === 'draining' && (
            <div className="shutdown-dialog">
              <h2>正在下班保存…</h2>
              <ul className="shutdown-progress">
                {affected.map((company) => (
                  <li key={company.id}>
                    <span>{company.name}</span>
                    <span className={states[company.id] === 'off' ? 'is-done' : ''}>
                      {states[company.id] === 'off' ? '✅ 已保存' : '正在下班…'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {phase === 'bye' && (
            <div className="shutdown-dialog shutdown-bye">
              <h2>工作已保存</h2>
              <p>祝您生意兴隆，期待与您的再次相见。</p>
              <p className="muted">下次启动时点「▶ 恢复运营」即可继续。</p>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
