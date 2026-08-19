import type React from 'react';
import { useState } from 'react';
import {
  useBlueprintTopPersonas,
  useAdoptBlueprintPersona,
  useBlueprintCrewStaffing,
  useApplyBlueprintCrew,
  useWorkbench,
} from '../hooks/queries';
import { Button, toast } from './Button';
import { Badge } from './Badge';
import { CardSkeleton } from './Skeleton';

interface Props {
  blueprintId: string;
  currentStaffingIds?: string[];
  projectId?: string;
}

export function BlueprintSpecialistSidebar({ blueprintId, currentStaffingIds = [], projectId }: Props): React.ReactElement {
  const [tab, setTab] = useState<'matches' | 'crew'>('matches');

  const { data: matches, isLoading: isMatchesLoading } = useBlueprintTopPersonas(blueprintId);
  const { data: crewPlan, isLoading: isCrewLoading } = useBlueprintCrewStaffing(blueprintId);
  const { data: workbench } = useWorkbench();

  const adoptMutation = useAdoptBlueprintPersona();
  const applyCrewMutation = useApplyBlueprintCrew(projectId || workbench?.id);

  const handleAdopt = (personaId: string, personaName: string) => {
    adoptMutation.mutate(
      { blueprintId, personaId, personaName },
      {
        onSuccess: () => toast('success', `已将「${personaName}」采纳进班底小组`),
        onError: (err) => toast('error', (err as Error).message),
      },
    );
  };

  const handleApplyCrew = () => {
    if (!crewPlan?.crew || crewPlan.crew.length === 0) return;
    applyCrewMutation.mutate(
      { blueprintId, crew: crewPlan.crew },
      {
        onSuccess: (res) => toast('success', `已成功入职 ${res.appliedCount} 位专家智能体到工作台`),
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
      {/* 头部 Tab 切换 */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', background: 'var(--bg-elev)', padding: 2, borderRadius: 6, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setTab('matches')}
            style={{
              flex: 1,
              padding: '4px 8px',
              fontSize: 12,
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: tab === 'matches' ? 'var(--bg-surface)' : 'transparent',
              color: tab === 'matches' ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: tab === 'matches' ? 600 : 400,
              boxShadow: tab === 'matches' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            }}
          >
            🎯 人设匹配
          </button>
          <button
            type="button"
            onClick={() => setTab('crew')}
            style={{
              flex: 1,
              padding: '4px 8px',
              fontSize: 12,
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: tab === 'crew' ? 'var(--bg-surface)' : 'transparent',
              color: tab === 'crew' ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: tab === 'crew' ? 600 : 400,
              boxShadow: tab === 'crew' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            }}
          >
            👥 编制建议 ({crewPlan?.crew?.length ?? 0})
          </button>
        </div>
        <small className="muted" style={{ fontSize: 11 }}>
          {tab === 'matches'
            ? '根据打法标签与能力词元自动推荐的最佳匹配专家'
            : '为该打法量身定制的完整专家团队岗位与工具配置'}
        </small>
      </div>

      {/* Tab 1: 人设匹配列表 */}
      {tab === 'matches' && (
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
          {isMatchesLoading ? (
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
      )}

      {/* Tab 2: 专家团队编制方案 */}
      {tab === 'crew' && (
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          {isCrewLoading ? (
            <CardSkeleton />
          ) : !crewPlan?.crew || crewPlan.crew.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
              暂无推荐编制方案
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>推荐编制 ({crewPlan.crew.length} 岗)</span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handleApplyCrew}
                  loading={applyCrewMutation.isPending}
                >
                  🚀 一键入职编制
                </Button>
              </div>

              {crewPlan.crew.map((member, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 13 }}>{member.roleName}</strong>
                    <Badge tone="info" style={{ fontSize: 10 }}>{member.domain || '通用'}</Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                    {member.roleDescription}
                  </p>
                  {member.suggestedTools.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                      {member.suggestedTools.map((t) => (
                        <span
                          key={t}
                          style={{
                            fontSize: 9,
                            padding: '1px 4px',
                            borderRadius: 3,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          🛠️ {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
