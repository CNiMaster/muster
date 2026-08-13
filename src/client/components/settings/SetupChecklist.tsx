/**
 * 优化⑤：设置就绪清单——动态指出"下一步该配什么、点哪里"。
 *
 * 回答"设置不够智能"：不铺 20 个折叠区，先给一张 checklist（执行器/权限/公司/上线），
 * 全就绪时自动隐藏不打扰；缺哪项直接链到对应中心。
 */
import type React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { useCompanies, useExecutorProfiles, usePermissionPolicies } from '../../hooks/queries';

export function SetupChecklist(): React.ReactElement | null {
  const { data: executors = [] } = useExecutorProfiles();
  const { data: policies = [] } = usePermissionPolicies();
  const { data: companies = [] } = useCompanies();
  const active = companies.filter((c) => !c.archivedAt);
  const online = active.filter((c) => c.state === 'online');

  const items: Array<{ ok: boolean; label: string; href: string; action?: string }> = [
    { ok: executors.length > 0, label: '执行器（agent 的运行环境）', href: '/executors', action: '去配置' },
    { ok: policies.length > 0, label: '权限策略（审批规则）', href: '/permissions', action: '去配置' },
    { ok: active.length > 0, label: '公司（选模板一键开跑）', href: '/companies/wizard', action: '去创建' },
    { ok: online.length > 0, label: '公司上线（agent 开始工作）', href: '/companies', action: '去启动' },
  ];
  const done = items.filter((i) => i.ok).length;
  if (done === items.length) return null; // 全就绪时隐藏，不打扰

  return (
    <Card title={<>就绪清单 <Badge tone={done >= 2 ? 'ok' : 'warn'}>{done}/{items.length}</Badge></>}>
      <ul className="setup-checklist">
        {items.map((item) => (
          <li key={item.label} className={item.ok ? 'is-done' : ''}>
            <span className="setup-checklist-mark" aria-hidden="true">{item.ok ? '✓' : '○'}</span>
            <span>{item.label}</span>
            {!item.ok && item.action && <Link to={item.href}>{item.action}</Link>}
          </li>
        ))}
      </ul>
      <p className="muted">以上就绪后，选一个公司模板点「一键开跑」，就能开始和团队对话派活。</p>
    </Card>
  );
}
