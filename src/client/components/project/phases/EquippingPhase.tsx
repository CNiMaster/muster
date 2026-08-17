/**
 * equipping 阶段：列出 plugin 让用户启用/禁用（B4）。
 *
 * 消费 B3 的 usePlugins + useEnabledCompanyPlugins + useToggleCompanyPlugin。
 * 工作台下班期间才能启停（后端校验，UI 提示）。
 */
import { Card } from '../../Card';
import { Badge } from '../../Badge';
import { usePlugins, useEnabledCompanyPlugins, useToggleCompanyPlugin } from '../../../hooks/queries';
import type { Plugin } from '../../../api/types';

/** 提取 plugin 描述（skill 取 frontmatter.description，否则用 kind）。 */
function describePlugin(p: Plugin): string {
  if (p.manifest.kind === 'skill') {
    const fm = p.manifest.skill.frontmatter as { description?: string } | undefined;
    return fm?.description ?? p.manifest.skill.body.slice(0, 80);
  }
  return p.kind;
}

export function EquippingPhase({
  enabledPlugins,
  onEnabledPluginsChange,
}: {
  enabledPlugins: string[];
  onEnabledPluginsChange: (ids: string[]) => void;
}): React.ReactElement {
  const plugins = usePlugins();
  const enabled = useEnabledCompanyPlugins();
  const toggle = useToggleCompanyPlugin();

  const enabledSet = new Set(enabledPlugins);

  const handleToggle = (pluginId: string, turnOn: boolean): void => {
    toggle.mutate(
      { pluginId, enabled: turnOn },
      {
        onSuccess: () => {
          const next = turnOn
            ? Array.from(new Set([...enabledPlugins, pluginId]))
            : enabledPlugins.filter((id) => id !== pluginId);
          onEnabledPluginsChange(next);
        },
      },
    );
  };

  return (
    <Card className="phase-content equipping-phase">
      <h3>装备阶段</h3>
      <p className="muted">为项目启用所需能力（plugin）。启停需工作台下班。至少启用一个才能继续。</p>
      {plugins.isLoading && <p className="muted">加载能力清单…</p>}
      {plugins.data?.length === 0 && <p className="muted">暂无可用能力。可到能力中心安装或用 AI 起草。</p>}
      <ul className="plugin-pick-list">
        {plugins.data?.map((p) => {
          const isOn = enabledSet.has(p.id) || enabled.data?.includes(p.id);
          return (
            <li key={p.id} className="plugin-pick-item">
              <label className="plugin-pick-label">
                <input
                  type="checkbox"
                  checked={!!isOn}
                  disabled={toggle.isPending}
                  onChange={(e) => handleToggle(p.id, e.target.checked)}
                />
                <span className="plugin-pick-name">{p.name}</span>
                <Badge tone={p.kind === 'mcp-server' ? 'info' : 'neutral'}>{p.kind}</Badge>
                {p.maturity === 'experimental' && <Badge tone="warn">实验性</Badge>}
              </label>
              <p className="plugin-pick-desc muted">{describePlugin(p)}</p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
