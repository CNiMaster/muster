/**
 * 能力中心：Skill / MCP / 工具的统一治理页（opt-out 默认全开 + 工作台级开关）。
 *
 * 设计：
 * - 顶部 Tab 按 kind 分类（Skill / MCP Server / 工具 / Bridge）
 * - 每个插件一行，展示 scope（平台通用 / 工作台独占:工作台名）、成熟度、健康状态
 * - 展开后是「工作台开关矩阵」：
 *   - 工作台少（≤6）：横排工作台名 + 三态开关
 *   - 工作台多（>6）：折叠为「默认全开 ✓ | 已禁用 N 家」+ 展开搜索
 * - 三态：default（绿勾，平台默认）/ disabled（红叉，显式禁用）/ exclusive（蓝标，工作台独占）
 *
 * opt-out 语义：平台插件默认对所有工作台启用；工作台可显式禁用。
 * 组织配置锁：启停需工作台下班（后端校验，前端 toast 提示）。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useCompanies, usePlugins, useToggleCompanyPlugin } from '../hooks/queries';
import { api } from '../api/client';
import type { Plugin, EffectivePlugin, CompanyPluginDecision } from '../api/types';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Input } from '../components/Form';
import { Tabs } from '../components/Tabs';
import { EmptyState, Icons } from '../components/EmptyState';

const MATURITY_TONE: Record<Plugin['maturity'], 'ok' | 'warn' | 'err'> = {
  stable: 'ok',
  experimental: 'warn',
  deprecated: 'err',
};

const MATURITY_LABEL: Record<Plugin['maturity'], string> = {
  stable: '稳定',
  experimental: '实验性',
  deprecated: '已废弃',
};

const KIND_LABEL: Record<Plugin['kind'], string> = {
  skill: 'Skill',
  'mcp-server': 'MCP Server',
  tool: '工具',
  'bridge-action': 'Bridge',
  'ai-generated': 'AI 生成',
};

/** 提取 plugin 描述。 */
function describePlugin(p: Plugin): string {
  if (p.manifest.kind === 'skill') {
    const fm = p.manifest.skill.frontmatter as { description?: string } | undefined;
    return fm?.description ?? p.manifest.skill.body.slice(0, 120);
  }
  if (p.manifest.kind === 'mcp-server') {
    const tools = p.manifest.mcp.tools ?? [];
    return tools.length ? `${tools.length} 个工具：${tools.slice(0, 3).map((t) => t.name).join(', ')}${tools.length > 3 ? '…' : ''}` : p.manifest.mcp.transport;
  }
  return KIND_LABEL[p.kind];
}

export function CapabilityCenterPage(): React.ReactElement {
  const { data: plugins, isLoading } = usePlugins();
  const { data: companies } = useCompanies();

  const grouped = useMemo(() => {
    const byKind = new Map<string, Plugin[]>();
    for (const p of plugins ?? []) {
      const arr = byKind.get(p.kind) ?? [];
      arr.push(p);
      byKind.set(p.kind, arr);
    }
    return byKind;
  }, [plugins]);

  const tabItems = useMemo(() => {
    const order: Plugin['kind'][] = ['skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated'];
    const items = order
      .filter((k) => (grouped.get(k)?.length ?? 0) > 0)
      .map((k) => ({
        key: k,
        label: `${KIND_LABEL[k]} (${grouped.get(k)!.length})`,
        content: <PluginList plugins={grouped.get(k)!} companies={companies ?? []} />,
      }));
    if (items.length === 0) {
      return [{ key: 'empty', label: '暂无', content: <EmptyState icon={Icons.empty} title="暂无能力" hint="安装 MCP server 或在设置页同步工具档案。" /> }];
    }
    return items;
  }, [grouped, companies]);

  return (
    <div className="page capability-center">
      <div className="page-head">
        <h1>能力中心</h1>
        <p className="muted">Skill、MCP Server、工具的统一治理。平台级能力默认对所有工作台启用，可按工作台关闭；也可为指定工作台安装独占能力。</p>
      </div>
      <div className="capability-entry-links">
        <span className="muted">管理已安装</span>
        <span className="sep">·</span>
        <Link to="/marketplace">发现并安装 →</Link>
      </div>
      {isLoading ? (
        <p className="muted">加载能力清单…</p>
      ) : (
        <Tabs items={tabItems} />
      )}
    </div>
  );
}

/** 单个分类下的插件列表，每行带工作台开关矩阵。 */
function PluginList({ plugins, companies }: { plugins: Plugin[]; companies: { id: string; name: string; state: string }[] }): React.ReactElement {
  return (
    <ul className="plugin-govern-list">
      {plugins.map((p) => (
        <PluginGovernRow key={p.id} plugin={p} companies={companies} />
      ))}
    </ul>
  );
}

interface CompanyLite {
  id: string;
  name: string;
  state: string;
}

/** 单个插件行：展示 + 工作台开关矩阵。 */
function PluginGovernRow({ plugin, companies }: { plugin: Plugin; companies: CompanyLite[] }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const activeCompanies = companies.filter((c) => c.state !== 'archived');
  const isExclusive = plugin.scope.level === 'company';

  return (
    <li className="plugin-govern-row">
      <div className="plugin-govern-summary">
        <button
          className="plugin-govern-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className={`caret ${expanded ? 'is-open' : ''}`}>▸</span>
        </button>
        <div className="plugin-govern-main">
          <div className="plugin-govern-title">
            <span className="plugin-govern-name">{plugin.name}</span>
            {plugin.maturity !== 'stable' && (
              <Badge tone={MATURITY_TONE[plugin.maturity]}>{MATURITY_LABEL[plugin.maturity]}</Badge>
            )}
            {isExclusive ? (
              <Badge tone="info" title={`工作台独占：${plugin.scope.level === 'company' ? plugin.scope.companyId : ''}`}>工作台独占</Badge>
            ) : (
              <Badge tone="neutral">平台通用</Badge>
            )}
            {plugin.healthError && <Badge tone="err" title={plugin.healthError}>连接异常</Badge>}
          </div>
          <p className="plugin-govern-desc muted">{describePlugin(plugin)}</p>
        </div>
      </div>
      {expanded && (
        isExclusive ? (
          <ExclusiveDetail plugin={plugin} />
        ) : (
          <CompanyMatrix plugin={plugin} companies={activeCompanies} />
        )
      )}
    </li>
  );
}

/** 工作台开关矩阵（opt-out 三态）。 */
function CompanyMatrix({ plugin, companies }: { plugin: Plugin; companies: CompanyLite[] }): React.ReactElement {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(companies.length <= 6);

  // 每个 CompanyToggle 内部用 useCompanyEffectiveDecision 查该工作台决策；
  // React Query 按 ['effective-plugins', companyId] 去重缓存，同工作台只请求一次。
  const filtered = companies.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  if (companies.length === 0) {
    return <p className="muted">暂无在营工作台。先创建工作台后再来配置。</p>;
  }

  return (
    <div className="company-matrix">
      {companies.length > 6 && (
        <div className="company-matrix-head">
          <Input
            placeholder="搜索工作台…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开全部（${companies.length} 家）`}
          </Button>
        </div>
      )}
      {!expanded && companies.length > 6 ? (
        <p className="muted company-matrix-collapsed">
          默认全开 ✓ · 点击「展开全部」逐工作台管理
        </p>
      ) : (
        <ul className="company-toggle-list">
          {filtered.map((c) => (
            <CompanyToggle key={c.id} plugin={plugin} company={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 单个工作台的三态开关。 */
function CompanyToggle({ plugin, company }: { plugin: Plugin; company: CompanyLite }): React.ReactElement {
  const toggle = useToggleCompanyPlugin();
  const effective = useCompanyEffectiveDecision(company.id, plugin.id);
  const decision: CompanyPluginDecision = effective.decision;
  const companyOff = company.state === 'off';

  const handleToggle = (): void => {
    // disabled/default → 启用（撤销禁用）；enabled → 禁用
    const turnOn = decision === 'disabled';
    toggle.mutate(
      { companyId: company.id, pluginId: plugin.id, enabled: turnOn },
      {
        onSuccess: () => toast('success', `${company.name}：${turnOn ? '已启用' : '已禁用'} ${plugin.name}`),
        onError: (e: any) => {
          const msg = e?.message ?? '操作失败';
          if (msg.includes('上班期间')) {
            toast('error', `${company.name} 上班中，请先让工作台下班再修改能力配置`);
          } else {
            toast('error', msg);
          }
        },
      },
    );
  };

  const tone = decision === 'disabled' ? 'err' : decision === 'exclusive' ? 'info' : 'ok';
  const label = decision === 'disabled' ? '已禁用' : decision === 'exclusive' ? '独占' : decision === 'enabled' ? '已启用' : '默认开';
  const on = decision !== 'disabled';

  return (
    <li className="company-toggle-row">
      <span className="company-toggle-name">{company.name}</span>
      <Badge tone={company.state === 'off' ? 'neutral' : 'ok'}>{company.state === 'off' ? '下班' : '上班'}</Badge>
      <button
        className={`toggle-pill ${on ? 'is-on' : 'is-off'}`}
        onClick={handleToggle}
        disabled={toggle.isPending || !companyOff}
        title={!companyOff ? '工作台上班期间不能修改能力配置' : undefined}
        aria-label={`${on ? '禁用' : '启用'} ${plugin.name} for ${company.name}`}
      >
        <span className="toggle-pill-knob" />
      </button>
      <Badge tone={tone}>{label}</Badge>
    </li>
  );
}

/** 工作台独占插件详情。 */
function ExclusiveDetail({ plugin }: { plugin: Plugin }): React.ReactElement {
  return (
    <div className="exclusive-detail">
      <p className="muted">工作台独占插件，仅对 <code>{plugin.scope.level === 'company' ? plugin.scope.companyId : ''}</code> 可见可用。其他工作台看不到此插件。</p>
      {plugin.manifest.kind === 'mcp-server' && (
        <details>
          <summary>MCP 配置</summary>
          <pre className="code-block">{JSON.stringify(plugin.manifest.mcp, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

// ── 辅助：单工作台单插件决策查询 ─────────────────────────────────────────────
// 当前用 effective endpoint 全量取一次再过滤（工作台数适中时够用；工作台极多时应改批量预取）。

function useCompanyEffectiveDecision(companyId: string, pluginId: string): { decision: CompanyPluginDecision } {
  const { data } = useQuery({
    queryKey: ['effective-plugins', companyId],
    queryFn: () => api.get<EffectivePlugin[]>(`/api/plugins/companies/${companyId}/plugins/effective`),
    staleTime: 10_000,
  });
  // 不在 effective 列表里 = 被禁用（平台插件）
  const found = (data ?? []).find((p: EffectivePlugin) => p.id === pluginId);
  const decision: CompanyPluginDecision = found ? found.companyDecision : 'disabled';
  return { decision };
}
