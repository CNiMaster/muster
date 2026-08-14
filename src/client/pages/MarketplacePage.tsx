/**
 * 能力商城（MarketplacePage）—— 发现并引入能力。
 *
 * 设计见 docs/superpowers/specs/2026-08-14-capability-marketplace-design.md。
 * 分类：一级 tab（Skill / MCP Server），二级按 PresetCategory 分组；卡片统一字段 +
 * 「muster 已安装 / 同名冲突 / 可安装」状态徽章；一键安装（平台 scope 默认，opt-out 治理
 * 在能力中心）。同名异源弹冲突确认 → 装新停旧。
 *
 * 执行原则：muster 注入 = 兜底保证"能力一定在"；CLI 用它自己的无所谓，不算冲突。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { useMarketplacePresets, useInstallPreset, useMarketplaceCatalog, useInstallClaudePlugin } from '../hooks/queries';
import type { MarketplacePresetView, MarketplaceSearchEntry, PresetInstallState } from '../api/types';
import { PRESET_CATEGORIES, type PresetCategory } from '../../shared/marketplace-presets';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Form';

const KIND_LABEL: Record<'skill' | 'mcp-server', string> = { skill: 'Skill 技能', 'mcp-server': 'MCP Server 连接器' };

const CURATED_LABEL: Record<MarketplacePresetView['curatedBy'], string> = {
  anthropic: 'Anthropic 官方',
  modelcontextprotocol: 'MCP 官方',
};

function stateBadge(state: PresetInstallState): React.ReactNode {
  if (state === 'installed') return <Badge tone="ok">muster 已安装</Badge>;
  if (state === 'conflict') return <Badge tone="warn">同名冲突</Badge>;
  return <Badge tone="neutral">可安装</Badge>;
}

function PresetCard({ preset }: { preset: MarketplacePresetView }): React.ReactElement {
  const install = useInstallPreset();
  const [busy, setBusy] = useState(false);

  const doInstall = async (replaceExisting: boolean): Promise<void> => {
    setBusy(true);
    try {
      await install.mutateAsync({ presetId: preset.id, replaceExisting });
      toast('success', `已安装：${preset.name}（去能力中心启用/配置）`);
    } catch (error) {
      toast('error', (error as Error).message ?? '安装失败');
    } finally {
      setBusy(false);
    }
  };

  const onInstallClick = (): void => {
    if (preset.installState === 'installed') return;
    if (preset.installState === 'conflict') {
      const ok = window.confirm(
        `muster 内已有同名条目「${preset.existing?.name ?? preset.name}」（来源：${preset.existing?.source ?? '未知'}）。\n` +
          `选择「装新停旧」将在所选范围停用旧条目、安装本条目。继续？`,
      );
      if (!ok) return;
      void doInstall(true);
      return;
    }
    void doInstall(false);
  };

  return (
    <Card className="marketplace-card" title={<strong>{preset.name}</strong>} actions={stateBadge(preset.installState)}>
      <p className="muted marketplace-desc">{preset.description}</p>
      <div className="marketplace-tags">
        <Badge tone="info">{CURATED_LABEL[preset.curatedBy]}</Badge>
        {preset.tags.slice(0, 3).map((t) => (
          <span key={t} className="marketplace-tag">{t}</span>
        ))}
      </div>
      {preset.install.type === 'mcp-command' && (
        <code className="marketplace-cmd">{preset.install.command} {preset.install.args.join(' ')}</code>
      )}
      {preset.permissions.length > 0 && (
        <div className="marketplace-perms">
          <span className="muted">权限：</span>
          {preset.permissions.map((p) => (
            <span key={p} className="marketplace-perm">{p}</span>
          ))}
        </div>
      )}
      {preset.quality && preset.quality.successRate !== null && (
        <div className="marketplace-quality">
          <Badge tone={preset.quality.successRate >= 0.8 ? 'ok' : preset.quality.successRate >= 0.5 ? 'warn' : 'err'}>
            成功率 {Math.round(preset.quality.successRate * 100)}%
          </Badge>
          <span className="muted">已用 {preset.quality.totalCalls} 次</span>
        </div>
      )}
      <div className="marketplace-actions">
        {preset.installState === 'installed' ? (
          <Link to="/capabilities" className="mu-btn mu-btn-ghost">去管理</Link>
        ) : (
          <Button variant={preset.installState === 'conflict' ? 'danger' : 'primary'} loading={busy} onClick={onInstallClick}>
            {preset.installState === 'conflict' ? '装新停旧' : '一键安装'}
          </Button>
        )}
      </div>
    </Card>
  );
}

function CategoryGroup({ category, presets }: { category: PresetCategory; presets: MarketplacePresetView[] }): React.ReactNode {
  if (presets.length === 0) return null;
  const meta = PRESET_CATEGORIES[category];
  return (
    <section className="marketplace-group">
      <header>
        <h2>{meta.label} <span className="muted">({presets.length})</span></h2>
        <p className="muted">{meta.blurb}</p>
      </header>
      <div className="marketplace-grid">
        {presets.map((p) => (
          <PresetCard key={p.id} preset={p} />
        ))}
      </div>
    </section>
  );
}

/** 非预置 catalog 条目（registry / 官方 skills 目录 / Claude Code 插件）：浏览型行；Claude Code 插件可安装。 */
function CatalogRow({ entry }: { entry: MarketplaceSearchEntry }): React.ReactElement {
  const installClaude = useInstallClaudePlugin();
  const sourceLabel = entry.source === 'mcp-registry'
    ? 'MCP 官方 Registry'
    : entry.source === 'anthropics-skills' ? 'Anthropic 官方 skills' : 'Claude Code 官方插件';
  const href = entry.source === 'mcp-registry'
    ? `https://registry.modelcontextprotocol.io/servers/${encodeURIComponent(entry.ref)}`
    : entry.source === 'anthropics-skills'
      ? `https://github.com/anthropics/skills/tree/main/skills/${encodeURIComponent(entry.ref)}`
      : `https://github.com/anthropics/claude-code/tree/main/plugins/${encodeURIComponent(entry.ref)}`;

  const onInstall = async (replaceExisting: boolean): Promise<void> => {
    try {
      await installClaude.mutateAsync({ pluginName: entry.ref, replaceExisting });
      toast('success', `已安装：${entry.name}（映射为 skill 注入；去能力中心管理）`);
    } catch (error) {
      toast('error', (error as Error).message ?? '安装失败');
    }
  };

  const isClaude = entry.source === 'claude-code-plugins';
  return (
    <li className="marketplace-catalog-row">
      <div className="marketplace-catalog-main">
        <span className="marketplace-catalog-name">{entry.name}</span>
        <Badge tone="info">{sourceLabel}</Badge>
        {stateBadge(entry.installState)}
      </div>
      <p className="muted">{entry.description}</p>
      <div className="marketplace-catalog-actions">
        {isClaude && entry.installState !== 'installed' && (
          <Button
            variant={entry.installState === 'conflict' ? 'danger' : 'primary'}
            size="sm"
            loading={installClaude.isPending}
            onClick={() => {
              if (entry.installState === 'conflict') {
                if (!window.confirm(`muster 内已有同名条目「${entry.name}」——「装新停旧」将停用旧条目并安装。继续？`)) return;
                void onInstall(true);
              } else {
                void onInstall(false);
              }
            }}
          >
            {entry.installState === 'conflict' ? '装新停旧' : '一键安装'}
          </Button>
        )}
        {isClaude && entry.installState === 'installed' && (
          <Link to="/capabilities" className="mu-btn mu-btn-ghost mu-btn-sm">去管理</Link>
        )}
        <a className="marketplace-catalog-link" href={href} target="_blank" rel="noreferrer">查看来源 ↗</a>
      </div>
    </li>
  );
}

function CatalogResults({ catalog, presets }: { catalog: { presets: MarketplaceSearchEntry[]; registry: MarketplaceSearchEntry[]; skillsCatalog: MarketplaceSearchEntry[]; claudePlugins: MarketplaceSearchEntry[] }; presets: MarketplacePresetView[] }): React.ReactElement {
  const presetById = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  const presetHits = catalog.presets
    .map((e) => presetById.get(e.ref))
    .filter((p): p is MarketplacePresetView => Boolean(p));
  const hasAny = presetHits.length > 0 || catalog.registry.length > 0 || catalog.skillsCatalog.length > 0 || catalog.claudePlugins.length > 0;
  if (!hasAny) return <EmptyState type="general" title="没有找到匹配的能力" hint="换个关键词试试，或浏览上方策展目录。" />;
  return (
    <div className="marketplace-catalog">
      {presetHits.length > 0 && (
        <section className="marketplace-group">
          <header><h2>策展精品 <span className="muted">({presetHits.length})</span></h2></header>
          <div className="marketplace-grid">{presetHits.map((p) => <PresetCard key={p.id} preset={p} />)}</div>
        </section>
      )}
      {catalog.claudePlugins.length > 0 && (
        <section className="marketplace-group">
          <header>
            <h2>Claude Code 官方插件 <span className="muted">({catalog.claudePlugins.length})</span></h2>
            <p className="muted">来自 anthropics/claude-code 官方插件市场（Anthropic 策展）。安装后映射为 skill 注入——CLI 自带同名插件时用它自己的不影响目标，muster 副本给其它执行器兜底。</p>
          </header>
          <ul className="marketplace-catalog-list">{catalog.claudePlugins.map((e) => <CatalogRow key={e.id} entry={e} />)}</ul>
        </section>
      )}
      {catalog.registry.length > 0 && (
        <section className="marketplace-group">
          <header>
            <h2>MCP 官方 Registry <span className="muted">({catalog.registry.length})</span></h2>
            <p className="muted">来自 registry.modelcontextprotocol.io（namespace 认证 + 人工下架治理）。M3 仅浏览，安装后续开放。</p>
          </header>
          <ul className="marketplace-catalog-list">{catalog.registry.map((e) => <CatalogRow key={e.id} entry={e} />)}</ul>
        </section>
      )}
      {catalog.skillsCatalog.length > 0 && (
        <section className="marketplace-group">
          <header>
            <h2>Anthropic 官方 skills <span className="muted">({catalog.skillsCatalog.length})</span></h2>
            <p className="muted">来自 anthropics/skills 官方仓库。M3 仅浏览，安装后续开放。</p>
          </header>
          <ul className="marketplace-catalog-list">{catalog.skillsCatalog.map((e) => <CatalogRow key={e.id} entry={e} />)}</ul>
        </section>
      )}
    </div>
  );
}

export function MarketplacePage(): React.ReactElement {
  const { data: presets, isLoading } = useMarketplacePresets();
  const [activeKind, setActiveKind] = useState<'skill' | 'mcp-server'>('skill');
  const [query, setQuery] = useState('');
  const catalog = useMarketplaceCatalog(query);

  const grouped = useMemo(() => {
    const byCat = new Map<PresetCategory, MarketplacePresetView[]>();
    for (const p of presets ?? []) {
      if (p.kind !== activeKind) continue;
      const arr = byCat.get(p.category) ?? [];
      arr.push(p);
      byCat.set(p.category, arr);
    }
    return byCat;
  }, [presets, activeKind]);

  const counts = useMemo(() => {
    const c = { skill: 0, 'mcp-server': 0 };
    for (const p of presets ?? []) c[p.kind]++;
    return c;
  }, [presets]);

  const categoryOrder: PresetCategory[] = activeKind === 'skill'
    ? ['document', 'dev-test']
    : ['mcp-files', 'mcp-data', 'plugin-workflow'];

  if (isLoading) return <div className="loading">加载中…</div>;

  return (
    <div className="marketplace-page">
      <header className="marketplace-head">
        <div>
          <h1>能力商城</h1>
          <p className="muted">
            发现并引入官方精品能力。安装后到 <Link to="/capabilities">能力中心</Link> 启用与配置。
            {' '}muster 安装的能力作为兜底注入；CLI 自带同类能力时用它自己的也能达成目标。
          </p>
        </div>
        <Link to="/capabilities" className="mu-btn mu-btn-ghost">← 返回能力中心</Link>
      </header>

      <div className="marketplace-search">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索官方能力（名称 / 描述 / 标签）——命中 MCP Registry 与 Anthropic skills 目录…"
          aria-label="搜索能力商城"
        />
      </div>

      {query.trim().length > 0 ? (
        catalog.isLoading ? (
          <p className="muted">搜索官方源中…</p>
        ) : (
          <CatalogResults catalog={catalog.data ?? { presets: [], registry: [], skillsCatalog: [], claudePlugins: [] }} presets={presets ?? []} />
        )
      ) : (
        <>
          <Tabs
            activeKey={activeKind}
            onChange={(k) => setActiveKind(k as 'skill' | 'mcp-server')}
            items={[
              { key: 'skill', label: `${KIND_LABEL.skill} (${counts.skill})`, content: <></> },
              { key: 'mcp-server', label: `${KIND_LABEL['mcp-server']} (${counts['mcp-server']})`, content: <></> },
            ]}
          />

          {categoryOrder.map((cat) => (
            <CategoryGroup key={cat} category={cat} presets={grouped.get(cat) ?? []} />
          ))}

          {(presets ?? []).length === 0 && (
            <EmptyState type="general" title="暂无策展条目" hint="预置目录为空。" />
          )}
        </>
      )}
    </div>
  );
}
