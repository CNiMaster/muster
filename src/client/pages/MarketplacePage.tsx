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
import { useMarketplacePresets, useInstallPreset } from '../hooks/queries';
import type { MarketplacePresetView, PresetInstallState } from '../api/types';
import { PRESET_CATEGORIES, type PresetCategory } from '../../shared/marketplace-presets';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { EmptyState } from '../components/EmptyState';

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

export function MarketplacePage(): React.ReactElement {
  const { data: presets, isLoading } = useMarketplacePresets();
  const [activeKind, setActiveKind] = useState<'skill' | 'mcp-server'>('skill');

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
    </div>
  );
}
