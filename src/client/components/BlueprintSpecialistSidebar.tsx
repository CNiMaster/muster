import type React from 'react';
import { useBlueprintTopPersonas, useAdoptBlueprintPersona } from '../hooks/queries';
import { Button, toast } from './Button';
import { Badge } from './Badge';
import { CardSkeleton } from './Skeleton';

interface Props {
  blueprintId: string;
  currentStaffingIds?: string[];
}

export function BlueprintSpecialistSidebar({ blueprintId, currentStaffingIds = [] }: Props): React.ReactElement {
  const { data: matches, isLoading } = useBlueprintTopPersonas(blueprintId);
  const adoptMutation = useAdoptBlueprintPersona();

  const handleAdopt = (personaId: string, personaName: string) => {
    adoptMutation.mutate(
      { blueprintId, personaId, personaName },
      {
        onSuccess: () => toast('success', `已将「${personaName}」采纳进班底小组`),
        onError: (err) => toast('error', (err as Error).message),
      },
    );
  };

  return (
    <aside
      className="blueprint-specialist-sidebar"
      style={{
        width: 320,
        borderLeft: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflowY: 'auto',
      }}
    >
      <div style={{ padding: '16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>🎯 人设库高匹配推荐</strong>
          <Badge tone="info" style={{ fontSize: 10 }}>Top Matches</Badge>
        </div>
        <small className="muted" style={{ fontSize: 12 }}>
          根据打法标签与能力词元自动推荐的最佳匹配专家
        </small>
      </div>

      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {isLoading ? (
          <CardSkeleton />
        ) : !matches || matches.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
            暂未找到高匹配度人设
          </div>
        ) : (
          matches.map(({ persona, score, matchedTokens }) => {
            const isAlreadyStaffed = currentStaffingIds.includes(persona.id);
            return (
              <div
                key={persona.id}
                style={{
                  background: 'var(--bg-elev)',
                  border: isAlreadyStaffed ? '1px solid var(--ok)' : '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 18 }}>{persona.emoji || '👤'}</span>
                    <div>
                      <strong style={{ fontSize: 13, display: 'block' }}>{persona.name}</strong>
                      {persona.domain && (
                        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{persona.domain}</span>
                      )}
                    </div>
                  </div>
                  <Badge tone={score >= 0.3 ? 'ok' : 'neutral'} style={{ fontSize: 10 }}>
                    {Math.round(score * 100)}% 匹配
                  </Badge>
                </div>

                {persona.description && (
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                    {persona.description.slice(0, 70)}
                    {persona.description.length > 70 ? '...' : ''}
                  </p>
                )}

                {matchedTokens.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {matchedTokens.slice(0, 3).map((token) => (
                      <span
                        key={token}
                        style={{
                          fontSize: 10,
                          padding: '1px 5px',
                          borderRadius: 4,
                          background: 'rgba(59, 130, 246, 0.1)',
                          color: 'var(--accent)',
                        }}
                      >
                        #{token}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 2, display: 'flex', justifyContent: 'flex-end' }}>
                  {isAlreadyStaffed ? (
                    <span style={{ fontSize: 11, color: 'var(--ok)', fontWeight: 600 }}>✓ 已在班底</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => handleAdopt(persona.id, persona.name)}
                      loading={adoptMutation.isPending}
                    >
                      + 采纳进班底
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
