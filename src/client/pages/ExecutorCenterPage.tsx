import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge, StateBadge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Input, Select } from '../components/Form';
import { SettingsRow, SettingsFold, SettingsSectionLabel } from '../components/SettingsRow';
import { CredentialStorePanel } from '../components/settings/CredentialStorePanel';
import { useGenerateCliProposal, useCredentialDefinitions, useSystemSettings, useSaveSystemSettings, type CliProposal, type ProposalResult } from '../hooks/queries';
import {
  concurrencyLabel,
  probeClassificationLabel,
  EXECUTOR_CAPABILITIES,
  suggestDefaultCapabilities,
  profileModels,
  profilePrimaryModel,
  normalizeApiModels,
  type CapabilityProbeResult,
  type ExecutorDetection,
  type ExecutorManifest,
  type ExecutorProbe,
  type ExecutorProfile,
  type CredentialReference,
} from '../../shared/executor';

/**
 * 执行器接入中心（2026-08-25 向导化重做；08-31 CLI/API 分标签页）。
 * CLI 标签：扫描启用（安装前强制再检测防重复安装）+ 已接入列表 + 清单外工具（AI 引导/手动兜底）。
 * API 标签：接入表单（5 个基础字段 + Key 粘贴即用，创建即自动测通；高级参数全折叠）+ 已接入列表。
 * 共用区：档位与兜底、钥匙凭据、接入原理。概念白话化：档案→接入配置、绑定→启用、探针→测试。
 */
export function ExecutorCenterPage(): React.ReactElement {
  const qc = useQueryClient();
  const manifests = useQuery({ queryKey: ['executor-manifests'], queryFn: () => api.get<ExecutorManifest[]>('/api/executors/manifests') });
  const profiles = useQuery({ queryKey: ['executor-profiles'], queryFn: () => api.get<ExecutorProfile[]>('/api/executors/profiles') });
  const [detections, setDetections] = useState<Record<string, ExecutorDetection>>({});
  const [probeIds, setProbeIds] = useState<Record<string, string>>({});

  // CLI 一键安装：每个 manifestId 一份状态（running/成功/失败 + 日志 + AI 诊断）
  const [installStates, setInstallStates] = useState<Record<string, {
    status: 'idle' | 'running' | 'done' | 'error';
    logs: string[];
    diagnosis: { reason: string; suggestions: string[] } | null;
  }>>({});

  // 自定义 CLI
  const [customName, setCustomName] = useState('自定义 CLI');
  const [customPath, setCustomPath] = useState('');
  const [customArgs, setCustomArgs] = useState('{prompt}');
  const generateCli = useGenerateCliProposal();
  const [assistantPrompt, setAssistantPrompt] = useState('');

  // API 接入表单
  const [apiKind, setApiKind] = useState<'openai-compatible-api' | 'gemini-api'>('openai-compatible-api');
  const [apiName, setApiName] = useState('');
  const [apiBaseURL, setApiBaseURL] = useState('https://api.openai.com/v1');
  /** R5 模型清单（一档多模型）：首行=主模型；行级上下文窗口可选（留空继承档案级）。 */
  const [apiModels, setApiModels] = useState<Array<{ model: string; contextWindowTokens?: number; source?: 'manual' | 'fetched'; visible?: boolean }>>([{ model: 'gpt-4o' }]);
  /** R5 档案级上下文窗口（所有模型兜底；历史上从未有 UI）。空=默认 128k。 */
  const [apiContextWindow, setApiContextWindow] = useState<number | ''>('');
  /** 主模型（首行）——能力建议/探测等单模型消费方用。 */
  const apiModel = apiModels[0]?.model ?? '';
  const [apiKeyEnv, setApiKeyEnv] = useState('OPENAI_API_KEY');
  /** 用户直接粘贴的 Key（muster 存本机数据目录 env 文件，不上传）；空=沿用已有环境变量。 */
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const { data: credentialDefs } = useCredentialDefinitions({ category: 'llm' });
  // 变量名变化/初载时查询是否已在环境变量或本机密钥文件中设置过
  useEffect(() => {
    const name = apiKeyEnv.trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) { setKeyConfigured(null); return; }
    let alive = true;
    api.get<{ configured: boolean }>(`/api/executors/credentials/status?name=${encodeURIComponent(name)}`)
      .then((r) => { if (alive) setKeyConfigured(r.configured); })
      .catch(() => { if (alive) setKeyConfigured(null); });
    return () => { alive = false; };
  }, [apiKeyEnv]);
  const [apiConcurrency, setApiConcurrency] = useState<'parallel' | 'profile-serial' | 'global-serial'>('parallel');
  const [apiMaxConcurrency, setApiMaxConcurrency] = useState(4);
  const [apiConcurrencyLocked, setApiConcurrencyLocked] = useState(false);
  const [apiThinkingDepth, setApiThinkingDepth] = useState<'off' | 'low' | 'medium' | 'high'>('off');
  /** R2a API 格式：openai-compatible 的请求形状（Chat Completions=默认 / Responses=OpenAI Responses API）。 */
  const [apiFormat, setApiFormat] = useState<'chat-completions' | 'responses'>('chat-completions');
  const [apiCapabilities, setApiCapabilities] = useState<string[]>([]);
  useEffect(() => {
    setApiCapabilities((old) => {
      const merged = new Set(old);
      for (const s of suggestDefaultCapabilities(apiKind, apiModel)) merged.add(s);
      return [...merged];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKind, apiModel]);
  // B2 池化统一：能力筛选 chips + 按档位分组排序（健康度>能力数>名称）
  const [capFilter, setCapFilter] = useState<string[]>([]);
  const { data: systemSettings } = useSystemSettings();
  const groupedList = useMemo(() => {
    const tierOf = (id: string): 'high' | 'standard' | 'low' | null => {
      if (systemSettings?.executorTierHighId === id) return 'high';
      if (systemSettings?.executorTierStandardId === id) return 'standard';
      if (systemSettings?.executorTierLowId === id) return 'low';
      return null;
    };
    const order: Array<{ key: 'high' | 'standard' | 'low' | 'unassigned'; label: string }> = [
      { key: 'high', label: 'high' },
      { key: 'standard', label: 'standard' },
      { key: 'low', label: 'low' },
      { key: 'unassigned', label: 'unassigned' },
    ];
    const buckets = new Map<string, ExecutorProfile[]>();
    order.forEach((g) => buckets.set(g.key, []));
    for (const p of (profiles.data ?? [])) {
      if (capFilter.length > 0 && !capFilter.every((c) => (p.config.capabilities as string[] | undefined)?.includes(c))) continue;
      buckets.get(tierOf(p.id) ?? 'unassigned')!.push(p);
    }
    const out: Array<{ kind: 'header' | 'profile'; tier: string; profile?: ExecutorProfile; headerLabel?: string }> = [];
    for (const g of order) {
      const group = buckets.get(g.key)!;
      group.sort((a, b) => {
        const health = (a.health === 'unhealthy' ? 1 : 0) - (b.health === 'unhealthy' ? 1 : 0);
        if (health !== 0) return health;
        const capDiff = ((b.config.capabilities as string[] | undefined)?.length ?? 0) - ((a.config.capabilities as string[] | undefined)?.length ?? 0);
        if (capDiff !== 0) return capDiff;
        return a.name.localeCompare(b.name);
      });
      if (group.length > 0) {
        out.push({ kind: 'header', tier: g.key, headerLabel: TIER_LABELS[g.key] ?? g.label });
        for (const p of group) out.push({ kind: 'profile', tier: g.key, profile: p });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.data, capFilter, systemSettings]);

  /** 已接入列表按标签（cli/api）过滤：保留有匹配条目的档位分组头。 */
  const readyEntries = (kind: 'cli' | 'api') => {
    const out: typeof groupedList = [];
    let pendingHeader: (typeof groupedList)[number] | null = null;
    for (const entry of groupedList) {
      if (entry.kind === 'header') { pendingHeader = entry; continue; }
      const p = (entry as { profile: ExecutorProfile }).profile;
      if (manifests.data?.find((m) => m.id === p.manifestId)?.kind === kind) {
        if (pendingHeader) { out.push(pendingHeader); pendingHeader = null; }
        out.push(entry);
      }
    }
    return out;
  };

  /** 单个已接入执行器行（CLI / API 两标签共用；按钮按形态裁剪）。 */
  const renderProfileRow = (profile: ExecutorProfile): React.ReactElement => {
    const profileModelList = profileModels(profile.config);
    const hasModel = profileModelList.length > 0;
    const manifestKind = manifests.data?.find((m) => m.id === profile.manifestId)?.kind;
    const isApi = manifestKind === 'api';
    return (
      <li key={profile.id} style={{ display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong>{profile.name}</strong>
            {profile.health === 'unhealthy' && (
              <span
                style={{ marginLeft: 8, fontSize: 11, color: 'var(--warn, orange)' }}
                title={profile.healthNote ?? '连续失败/认证失效，任务已自动换用备选执行器'}
              >
                ⚠️ 异常（已自动切备选）
              </span>
            )}
            <div className="muted">{String(profile.config.binaryPath ?? profile.manifestId)}</div>
            {isApi && profileModelList.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {profileModelList.filter((m) => m.visible !== false).map((m) => (
                  <span
                    key={m.model}
                    title={m.contextWindowTokens ? `上下文窗口 ${m.contextWindowTokens.toLocaleString()} token` : '窗口继承档案级/默认'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'var(--bg-soft)', color: 'var(--fg-muted)' }}
                  >
                    {m.model}{m.contextWindowTokens ? ` · ${(m.contextWindowTokens / 1000).toFixed(0)}k` : ''}
                    <button
                      type="button"
                      title={`单独测试 ${m.model}`}
                      style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: 11 }}
                      onClick={() => testConnection.mutate({ id: profile.id, kind: 'model', model: m.model })}
                    >
                      测
                    </button>
                  </span>
                ))}
                {profileModelList.some((m) => m.visible === false) && (
                  <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }} title="已识别待选的模型在工作台下拉不显示；编辑档案可选用">
                    ＋{profileModelList.filter((m) => m.visible === false).length} 待选用
                  </span>
                )}
              </div>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'connectivity' })} loading={testConnection.isPending}>测试</Button>
          {hasModel && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'model' })} loading={testConnection.isPending}>测模型</Button>}
          {isApi && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'capability' })} loading={testConnection.isPending}>测能力</Button>}
          {isApi && (
            <Button size="sm" variant="ghost" onClick={() => {
              setKindTab('api');
              setEditingProfileId(profile.id);
              setApiKind(profile.manifestId as 'openai-compatible-api' | 'gemini-api');
              setApiName(profile.name);
              setApiBaseURL(String(profile.config.baseURL ?? 'https://api.openai.com/v1'));
              setApiModels(() => {
                const list = profileModels(profile.config).map((m) => ({
                  model: m.model,
                  ...(m.contextWindowTokens ? { contextWindowTokens: m.contextWindowTokens } : {}),
                  ...(m.source ? { source: m.source } : {}),
                  ...(m.visible === false ? { visible: false } : {}),
                }));
                return list.length > 0 ? list : [{ model: '' }];
              });
              setApiContextWindow(profile.contextWindowTokens ?? '');
              setApiKeyEnv(String(profile.credentialRef?.reference ?? ''));
              setApiConcurrency(profile.concurrencyMode ?? 'parallel');
              setApiMaxConcurrency(profile.maxConcurrency ?? 4);
              setApiConcurrencyLocked(profile.concurrencyLocked ?? false);
              setApiThinkingDepth(
                (['off', 'low', 'medium', 'high'] as const).includes(profile.config.thinkingDepth as never)
                  ? (profile.config.thinkingDepth as 'off' | 'low' | 'medium' | 'high')
                  : 'off',
              );
              setApiContextCache(
                (['auto', 'on', 'off'] as const).includes(profile.config.contextCache as never)
                  ? (profile.config.contextCache as 'auto' | 'on' | 'off')
                  : 'auto',
              );
              setApiFormat(profile.config.apiFormat === 'responses' ? 'responses' : 'chat-completions');
              setApiCapabilities(Array.isArray(profile.config.capabilities) ? profile.config.capabilities.filter((c): c is string => typeof c === 'string') : []);
              // 打开编辑即静默拉一次最新清单（陈旧内容自动刷新；失败不打扰，手填内容不受影响）
              void refreshModels(false, {
                provider: profile.manifestId === 'gemini-api' ? 'gemini' : 'openai',
                baseURL: String(profile.config.baseURL ?? ''),
                credentialEnv: String(profile.credentialRef?.reference ?? ''),
              });
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}>编辑</Button>
          )}
          {deleteConfirmId === profile.id ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(null)}>取消</Button>
              <Button size="sm" onClick={() => deleteProfile.mutate(profile.id)} loading={deleteProfile.isPending}>确认删除</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(profile.id)}>删除</Button>
          )}
        </div>
        <ProbeResult probeId={probeIds[`${profile.id}:connectivity`]} />
        {hasModel && <ProbeResult probeId={probeIds[`${profile.id}:model`]} />}
        {isApi && <ProbeResult probeId={probeIds[`${profile.id}:capability`]} />}
        {isApi && <CapabilityBadges capability={profile.capability?.capabilityJson ?? null} />}
      </li>
    );
  };
  const [apiContextCache, setApiContextCache] = useState<'auto' | 'on' | 'off'>('auto');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  // CLI / API 分标签页（2026-08-31 UI 收口）：接入流程按工具形态分开，档位/凭据两标签共用
  const [kindTab, setKindTab] = useState<'cli' | 'api'>('cli');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  /** 刚创建的 API 配置 id：创建成功自动触发连通测试并把结果展示在表单下方。 */
  const [newlyCreatedId, setNewlyCreatedId] = useState<string | null>(null);

  // 2026-08-31 执行器收口：三档分配 + 兜底引擎/路径 唯一配置点从设置页迁到这里
  const [tierHigh, setTierHigh] = useState('');
  const [tierStandard, setTierStandard] = useState('');
  const [tierLow, setTierLow] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState('claude-cli');
  const [fallbackBin, setFallbackBin] = useState('');
  useEffect(() => {
    if (!systemSettings) return;
    setTierHigh(systemSettings.executorTierHighId ?? '');
    setTierStandard(systemSettings.executorTierStandardId ?? '');
    setTierLow(systemSettings.executorTierLowId ?? '');
    setFallbackProvider(systemSettings.defaultProvider ?? 'claude-cli');
    setFallbackBin(systemSettings.claudeBin ?? '');
  }, [systemSettings]);
  const saveTierFallback = useSaveSystemSettings();
  const handleSaveTierFallback = (): void => {
    if (!fallbackBin.trim()) { toast('error', '执行工具路径不能为空'); return; }
    saveTierFallback.mutate(
      // 仅提交本卡管辖的键（服务端合并语义保存，其余设置不受影响）
      { claudeBin: fallbackBin.trim(), defaultProvider: fallbackProvider, executorTierHighId: tierHigh, executorTierStandardId: tierStandard, executorTierLowId: tierLow },
      { onSuccess: () => toast('success', '档位与兜底已保存并实时生效'), onError: (error: any) => toast('error', error.message ?? '保存失败') },
    );
  };

  const detect = useMutation({
    mutationFn: (id: string) => api.post<ExecutorDetection>(`/api/executors/${id}/detect`),
    onSuccess: (result, id) => setDetections((old) => ({ ...old, [id]: result })),
    onError: (e: unknown) => toast('error', (e as Error).message ?? '检测失败'),
  });
  const bind = useMutation({
    mutationFn: (id: string) => api.post<ExecutorProfile>(`/api/executors/${id}/bind-system`),
    onSuccess: (profile) => { void qc.invalidateQueries({ queryKey: ['executor-profiles'] }); toast('success', `已启用 ${profile.name}，任务可以直接使用了`); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '启用失败'),
  });
  const detectAll = useMutation({
    mutationFn: () => api.post<Array<ExecutorDetection & { manifestId: string }>>('/api/executors/detect-all'),
    onSuccess: (results) => {
      setDetections((old) => {
        const next = { ...old };
        for (const r of results) {
          const { manifestId, ...rest } = r;
          next[manifestId] = rest;
        }
        return next;
      });
      const found = results.filter((r) => r.found).length;
      toast('success', found > 0 ? `检测到 ${found} 个已装工具，点「立即启用」即可使用` : '本机没扫到已装工具；未安装的可点「自动安装」');
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '扫描失败'),
  });

  /** 一键安装 CLI：fetch POST 后手动解析 SSE 事件流，逐行更新日志。 */
  const installCli = async (manifestId: string): Promise<void> => {
    setInstallStates((old) => ({ ...old, [manifestId]: { status: 'running', logs: ['正在连接安装通道…'], diagnosis: null } }));
    const appendLog = (line: string): void => setInstallStates((old) => ({
      ...old,
      [manifestId]: { ...old[manifestId], logs: [...(old[manifestId]?.logs ?? []), line] },
    }));
    try {
      // 防重复安装护栏（2026-08-31）：安装前强制再检测一次——已装（含此前检测误判漏报）直接绑定跳过安装
      const recheck = await api.post<ExecutorDetection>(`/api/executors/${manifestId}/detect`);
      setDetections((old) => ({ ...old, [manifestId]: recheck }));
      if (recheck.found && recheck.path) {
        appendLog(`检测到已安装（${recheck.version ?? recheck.path}），无需重复安装，直接启用`);
        await api.post(`/api/executors/${manifestId}/bind-system`);
        setInstallStates((old) => ({ ...old, [manifestId]: { ...old[manifestId], status: 'done', logs: [...(old[manifestId]?.logs ?? []), '已启用'] } }));
        void qc.invalidateQueries({ queryKey: ['executor-profiles'] });
        toast('success', '检测到本机已装好，已直接启用（跳过安装）');
        return;
      }
      appendLog('本机未检测到，开始安装…');
      const res = await fetch(`/api/executors/${manifestId}/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok || !res.body) throw new Error(`安装请求失败：${res.status} ${res.statusText}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const chunk of parts) {
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as { type: string; line?: string; message?: string; exitCode?: number | null; env?: { platform: string; hasBrew: boolean; hasNpm: boolean; hasCurl: boolean; nodeVersion: string | null } };
            if (event.type === 'log' && event.line) appendLog(event.line);
            else if (event.type === 'env' && event.env) appendLog(`环境：${event.env.platform} · brew:${event.env.hasBrew ? '有' : '无'} · npm:${event.env.hasNpm ? '有' : '无'} · node:${event.env.nodeVersion ?? '未知'}`);
            else if (event.type === 'exit' && event.exitCode != null) appendLog(`退出码：${event.exitCode}`);
            else if (event.type === 'done' && event.message) {
              appendLog(`✓ ${event.message}`);
              setInstallStates((old) => ({ ...old, [manifestId]: { ...old[manifestId], status: 'done' } }));
              finished = true;
              void qc.invalidateQueries({ queryKey: ['executor-profiles'] });
              void detect.mutate(manifestId);
            } else if (event.type === 'error' && event.message) {
              appendLog(`✗ ${event.message}`);
              setInstallStates((old) => ({ ...old, [manifestId]: { ...old[manifestId], status: 'error' } }));
              finished = true;
              void diagnose(manifestId, event.message, event.exitCode);
            }
          } catch {
            // 忽略非 JSON 事件行
          }
        }
      }
      if (!finished) {
        appendLog('✗ 连接中断，安装状态未知。');
        setInstallStates((old) => ({ ...old, [manifestId]: { ...old[manifestId], status: 'error' } }));
      }
    } catch (error) {
      appendLog(`✗ ${(error as Error).message}`);
      setInstallStates((old) => ({ ...old, [manifestId]: { ...old[manifestId], status: 'error' } }));
    }
  };

  /** 安装失败后的 AI 诊断。 */
  const diagnose = async (manifestId: string, errorMessage: string, exitCode: number | null | undefined): Promise<void> => {
    try {
      const manifest = manifests.data?.find((m) => m.id === manifestId);
      const command = manifest?.officialInstall?.commands[0] ?? '';
      const result = await api.post<{ reason: string; suggestions: string[] }>('/api/executors/install-diagnose', {
        manifestId,
        command,
        output: errorMessage,
        exitCode,
      });
      setInstallStates((old) => ({ ...old, [manifestId]: { ...old[manifestId], diagnosis: result } }));
    } catch {
      // 诊断失败不阻塞：保留安装错误信息即可
    }
  };
  const createCustom = useMutation({
    mutationFn: () => api.post<ExecutorProfile>('/api/executors/profiles', {
      name: customName,
      manifestId: 'custom-cli',
      config: { binaryPath: customPath, provider: 'custom-cli', customArgs: customArgs.split('\n').map((v) => v.trim()).filter(Boolean) },
      concurrencyMode: 'profile-serial',
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['executor-profiles'] }); toast('success', '自定义工具已创建'); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const testConnection = useMutation({
    mutationFn: ({ id, kind, model }: { id: string; kind: 'connectivity' | 'model' | 'capability'; model?: string }) =>
      api.post<ExecutorProbe>(`/api/executors/profiles/${id}/probes`, { force: true, kind, ...(model ? { model } : {}) }),
    onSuccess: (probe, input) => {
      setProbeIds((old) => ({ ...old, [`${input.id}:${input.kind}${input.model ? `:${input.model}` : ''}`]: probe.id }));
      if (input.kind === 'connectivity') {
        if (probe.status === 'connected') toast('success', '测试通过！这个接口可以用了');
        else if (probe.status === 'failed') toast('error', '测试未通过——多半是 Key 没设好；检查上面的 Key 粘贴框与 Key 变量名再来一次');
      }
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '测试失败'),
  });
  // 模型自动识别（2026-08-31 选用制）：拉取的模型进「待选池」（visible=false，工作台下拉不显示），
  // 用户在表单里点「选用」才可见；手动添加的恒显示且优先。再次识别时旧待选池整体退役换成最新清单
  // （陈旧内容自动刷新），已选用/手填的行原样保留（部分网关 /models 不回列全部，靠手填补）。
  const [discovering, setDiscovering] = useState(false);
  const applyDiscovered = (models: string[]): void => {
    setApiModels((old) => {
      const tokenByName = new Map(old.filter((r) => r.model.trim()).map((r) => [r.model.trim(), r.contextWindowTokens]));
      const kept = old.filter((r) => !r.model.trim() || r.source !== 'fetched' || r.visible !== false);
      const existing = new Set(kept.map((r) => r.model.trim()).filter(Boolean));
      const fresh = models
        .filter((m) => !existing.has(m))
        .map((m) => ({ model: m, source: 'fetched' as const, visible: false, ...(tokenByName.get(m) ? { contextWindowTokens: tokenByName.get(m) } : {}) }));
      return [...kept, ...fresh];
    });
  };
  const refreshModels = async (announce: boolean, overrides?: { provider?: 'openai' | 'gemini'; baseURL?: string; credentialEnv?: string }): Promise<void> => {
    const provider = overrides?.provider ?? (apiKind === 'gemini-api' ? 'gemini' : 'openai');
    setDiscovering(true);
    try {
      const result = await api.post<{ models: string[] }>('/api/executors/models/discover', {
        provider,
        baseURL: (overrides?.baseURL ?? apiBaseURL).trim(),
        credentialEnv: (overrides?.credentialEnv ?? apiKeyEnv).trim(),
        ...(apiKeyValue.trim() ? { keyValue: apiKeyValue.trim() } : {}),
      });
      if (result.models.length === 0) {
        if (announce) toast('error', '服务商返回了空清单——检查 Key 与接口地址');
        return;
      }
      applyDiscovered(result.models);
      if (announce) toast('success', `已识别 ${result.models.length} 个模型（手填的额外模型保留在后面）`);
    } catch (error) {
      if (announce) toast('error', (error as Error).message ?? '自动识别失败');
    } finally {
      setDiscovering(false);
    }
  };

  const createApi = useMutation({    mutationFn: async () => {
      // 用户粘贴了 Key：先落本机密钥文件并热注入进程 env（创建后自动测试立即生效）
      if (apiKeyValue.trim()) {
        await api.post('/api/executors/credentials/save', { name: apiKeyEnv.trim(), value: apiKeyValue.trim() });
      }
      const credentialRef: CredentialReference = { kind: 'env', reference: apiKeyEnv.trim() };
      // R5：models 全清单 + model 双写主模型（旧消费方兼容）；可见行在前（主模型=首行）。
      // 边界：可见行被删光时把首个待选行转正，避免主模型落在一个工作台看不见的模型上
      const models = normalizeApiModels(apiModels);
      const primaryModel = models[0]?.model ?? '';
      const config: Record<string, unknown> = apiKind === 'openai-compatible-api'
        ? { provider: 'openai', baseURL: apiBaseURL.trim(), model: primaryModel, models }
        : { provider: 'gemini', model: primaryModel, models };
      config.thinkingDepth = apiThinkingDepth;
      config.contextCache = apiContextCache;
      if (apiKind === 'openai-compatible-api') config.apiFormat = apiFormat;
      if (apiCapabilities.length > 0) config.capabilities = apiCapabilities;
      return api.post<ExecutorProfile>('/api/executors/profiles', {
        name: apiName.trim(),
        manifestId: apiKind,
        config,
        credentialRef,
        concurrencyMode: apiConcurrency,
        maxConcurrency: apiMaxConcurrency,
        concurrencyLocked: apiConcurrencyLocked,
        ...(apiContextWindow !== '' ? { contextWindowTokens: apiContextWindow } : {}),
      });
    },
    onSuccess: (profile) => {
      void qc.invalidateQueries({ queryKey: ['executor-profiles'] });
      setEditingProfileId(null);
      setApiKeyValue('');
      setKeyConfigured(true);
      // 创建即自动测通：成功后立即跑连通测试，结果直接展示在表单下方
      setNewlyCreatedId(profile.id);
      testConnection.mutate({ id: profile.id, kind: 'connectivity' });
      toast('success', '已保存，正在自动测试连通性…');
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const updateApi = useMutation({
    mutationFn: (profileId: string) => {
      const credentialRef: CredentialReference = { kind: 'env', reference: apiKeyEnv.trim() };
      // R5：models 全清单 + model 双写主模型；档案级窗口随行提交
      const models = normalizeApiModels(apiModels);
      const primaryModel = models[0]?.model ?? '';
      const config: Record<string, unknown> = apiKind === 'openai-compatible-api'
        ? { provider: 'openai', baseURL: apiBaseURL.trim(), model: primaryModel, models }
        : { provider: 'gemini', model: primaryModel, models };
      config.thinkingDepth = apiThinkingDepth;
      config.contextCache = apiContextCache;
      if (apiKind === 'openai-compatible-api') config.apiFormat = apiFormat;
      if (apiCapabilities.length > 0) config.capabilities = apiCapabilities;
      return api.put<ExecutorProfile>(`/api/executors/profiles/${profileId}`, {
        name: apiName.trim(),
        config,
        credentialRef,
        concurrencyMode: apiConcurrency,
        maxConcurrency: apiMaxConcurrency,
        concurrencyLocked: apiConcurrencyLocked,
        ...(apiContextWindow !== '' ? { contextWindowTokens: apiContextWindow } : {}),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['executor-profiles'] });
      setEditingProfileId(null);
      toast('success', '接入配置已更新');
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '更新失败'),
  });
  const deleteProfile = useMutation({
    mutationFn: (profileId: string) => api.delete<{ ok: boolean }>(`/api/executors/profiles/${profileId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['executor-profiles'] });
      setDeleteConfirmId(null);
      setEditingProfileId(null);
      toast('success', '已删除');
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '删除失败'),
  });
  const copy = async (command: string): Promise<void> => {
    await navigator.clipboard.writeText(command);
    toast('success', '命令已复制');
  };
  const fillCustomForm = (proposal: CliProposal): void => {
    setCustomName(proposal.displayName);
    setCustomPath(proposal.binaryName);
    setCustomArgs(proposal.argTemplate.join('\n'));
    toast('success', '已填入下方表单，确认路径后创建');
  };

  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h1>执行器接入中心</h1>
          <p className="subtitle">选好工具、给上钥匙、测试通过——接好即用。</p>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 8, margin: '2px 0 12px' }} role="tablist" aria-label="接入类型">
        <button type="button" role="tab" aria-selected={kindTab === 'cli'} className={`ptws-hero-tab ${kindTab === 'cli' ? 'is-active' : ''}`} onClick={() => setKindTab('cli')}>命令行工具（CLI）</button>
        <button type="button" role="tab" aria-selected={kindTab === 'api'} className={`ptws-hero-tab ${kindTab === 'api' ? 'is-active' : ''}`} onClick={() => setKindTab('api')}>API 接口</button>
      </div>

      {kindTab === 'cli' && (
      <>
      <Card
        title="命令行工具 · 扫描并启用"
        actions={
          <Button variant="ghost" size="sm" onClick={() => detectAll.mutate()} loading={detectAll.isPending}>
            {detectAll.isPending ? '正在检查…' : '检查下方工具是否已装'}
          </Button>
        }
      >
        <p className="muted">
          「扫描」就是逐个运行下方每款工具的版本命令，报告装没装、装在哪：装过的点「立即启用」，没装的点「自动安装」（官方方式，不用手动敲命令）。
          muster 只认识下面这几款；不在这份清单里的工具，用底部「接入清单之外的新工具」添加。
        </p>
        <div className="executor-grid">
          {(manifests.data ?? []).filter((m) => m.kind === 'cli').map((manifest) => {
            const detection = detections[manifest.id];
            const install = manifest.officialInstall;
            const bound = profiles.data?.some((profile) => profile.manifestId === manifest.id && (!detection?.path || profile.config.binaryPath === detection.path));
            const installState = installStates[manifest.id];
            const installing = installState?.status === 'running';
            return (
              <article className="executor-card" key={manifest.id}>
                <div className="executor-card-head">
                  <span className="executor-mark" aria-hidden="true">{manifest.displayName.slice(0, 1)}</span>
                  <div className="executor-card-title">
                    <strong>{manifest.displayName}</strong>
                    <div className="muted">{concurrencyLabel(manifest.concurrency)}</div>
                  </div>
                  <Badge tone={bound ? 'ok' : detection?.found ? 'info' : 'neutral'}>{bound ? '✓ 可用' : detection?.found ? '已安装' : manifest.detection ? '未扫描' : '手动添加'}</Badge>
                </div>
                <div className="executor-card-body">
                  {detection?.found ? (
                    <>
                      <p className="diagnostic-text">{detection.version}<br /><span className="muted">{detection.path}</span></p>
                      {install?.loginCommand && !bound && (
                        <div className="install-command">
                          <code title={install.loginCommand}>{install.loginCommand}</code>
                          <Button size="sm" variant="ghost" onClick={() => void copy(install.loginCommand)}>复制登录命令</Button>
                        </div>
                      )}
                      {bound && <p className="muted" style={{ margin: 0 }}>登录状态由工具自己管理，muster 不干预。</p>}
                    </>
                  ) : (
                    <>
                      {!installState?.status || installState.status === 'idle' ? (
                        <>
                          <p className="muted">还没装。可以点「自动安装」，或展开看官方命令手动装。</p>
                          {install && (
                            <details className="install-collapse">
                              <summary>官方安装命令</summary>
                              <div className="official-install-guide">
                                {install.commands.map((command: string) => (
                                  <div className="install-command" key={command}>
                                    <code>{command}</code>
                                    <Button size="sm" variant="ghost" onClick={() => void copy(command)}>复制</Button>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </>
                      ) : (
                        <div className="install-progress">
                          <div className="install-progress-head">
                            <Badge tone={installState.status === 'running' ? 'warn' : installState.status === 'done' ? 'ok' : 'err'}>
                              {installState.status === 'running' ? '安装中' : installState.status === 'done' ? '已安装' : '失败'}
                            </Badge>
                            <span>{installing ? '正在安装…' : installState.status === 'done' ? '安装完成' : '安装失败'}</span>
                          </div>
                          <pre className="install-log" aria-live="polite">{(installState.logs ?? []).join('\n')}</pre>
                          {installState.diagnosis && (
                            <div className="install-diagnosis">
                              <strong>AI 诊断：</strong>
                              <p>{installState.diagnosis.reason}</p>
                              <ul>{installState.diagnosis.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
                            </div>
                          )}
                          {installState.status === 'error' && !installState.diagnosis && (
                            <p className="muted">正在调用 AI 分析失败原因…</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="executor-card-foot">
                  <a href={install?.guideUrl ?? manifest.officialSource} target="_blank" rel="noreferrer">官方说明</a>
                  <div className="settings-primary-actions">
                    {/* 已启用（bound）不显示任何扫描/安装动作——已装工具挂「自动安装」是重复安装风险入口 */}
                    {!bound && !detection?.found && manifest.detection && <Button variant="ghost" onClick={() => detect.mutate(manifest.id)} loading={detect.isPending}>重新扫描</Button>}
                    {detection?.found && !bound && <Button onClick={() => bind.mutate(manifest.id)} loading={bind.isPending}>立即启用</Button>}
                    {!bound && !detection?.found && install && (
                      <Button onClick={() => void installCli(manifest.id)} loading={installing} disabled={installing}>
                        {installing ? '安装中…' : installState?.status === 'error' ? '重试安装' : '自动安装'}
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        <p className="muted" style={{ margin: '10px 0 0' }}>
          启用后就完成了——任务会按下方「档位与兜底」自动选用工具，无需再配置。
        </p>
      </Card>

      <Card title="已接入的命令行工具" className="section">
        <ul className="entity-list">
          {readyEntries('cli').length === 0 && <li className="muted">还没有已启用的命令行工具——上面扫到后点「立即启用」就会出现在这里。</li>}
          {readyEntries('cli').map((entry) => entry.kind === 'header'
            ? <li key={`hdr-${entry.tier}`} className="muted" style={{ padding: '6px 2px 2px', fontSize: 11, letterSpacing: 0.5 }}>{(entry as { headerLabel: string }).headerLabel}</li>
            : renderProfileRow((entry as { profile: ExecutorProfile }).profile)
          )}
        </ul>
      </Card>

      <SettingsFold summary="接入清单之外的新工具（自定义 CLI · AI 引导）">
        <Card title="AI 引导接入">
          <p className="muted">
            内置清单没收录的工具（如 aider、qwen-code）：描述一下它，AI 自动生成接入参数。
            要求：非交互运行、退出码为 0、输出结构化 JSON；不接管原生审批。
          </p>
          <SettingsRow badge="required" title="工具描述" hint="例如：opencode / 我团队自研的 qwen-code">
            <textarea value={assistantPrompt} onChange={(e) => setAssistantPrompt(e.target.value)} placeholder="例如：opencode，模型无关的开源 agent" style={{ width: '100%' }} />
          </SettingsRow>
          <div className="settings-primary-actions">
            <Button variant="ghost" onClick={() => generateCli.mutate({ prompt: assistantPrompt })} loading={generateCli.isPending} disabled={!assistantPrompt.trim()}>生成接入方案</Button>
          </div>
          {generateCli.data && <CliProposalView result={generateCli.data} onFill={fillCustomForm} onCopy={copy} />}
        </Card>
        <Card title="手动填写接入参数">
          <SettingsRow badge="required" title="名称">
            <Input value={customName} onChange={(e) => setCustomName(e.target.value)} />
          </SettingsRow>
          <SettingsRow badge="required" title="命令位置" hint="绝对路径或命令名，如 /usr/local/bin/my-agent 或 opencode">
            <Input value={customPath} onChange={(e) => setCustomPath(e.target.value)} placeholder="/usr/local/bin/my-agent" />
          </SettingsRow>
          <SettingsRow badge="required" title="参数模板（每行一项）" hint={'支持占位符：{prompt} {cwd} {taskId} {sessionId}'}>
            <textarea value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} placeholder={'--print\n{prompt}\n--cwd\n{cwd}'} style={{ width: '100%' }} />
          </SettingsRow>
          <div className="settings-primary-actions">
            <Button onClick={() => createCustom.mutate()} disabled={!customPath.trim()} loading={createCustom.isPending}>创建</Button>
          </div>
        </Card>
      </SettingsFold>
      </>
      )}

      {kindTab === 'api' && (
      <>
      <Card title={editingProfileId ? '修改 API 接入' : '接入新的 API（可选，想用 API 模型时才填）'} className="section">
        <SettingsRow badge="required" title="接口类型">
          <Select value={apiKind} onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value as typeof apiKind;
            setApiKind(v);
            if (v === 'openai-compatible-api') { setApiBaseURL('https://api.openai.com/v1'); setApiModels([{ model: 'gpt-4o' }]); setApiKeyEnv('OPENAI_API_KEY'); }
            else { setApiModels([{ model: 'gemini-2.0-flash' }]); setApiKeyEnv('GEMINI_API_KEY'); }
            setApiFormat('chat-completions');
          }}>
            <option value="openai-compatible-api">OpenAI 兼容</option>
            <option value="gemini-api">Gemini</option>
          </Select>
        </SettingsRow>
        <SettingsRow badge="required" title="起个名字" hint="随便取，方便自己认，如 DeepSeek / 通义 / Kimi">
          <Input value={apiName} onChange={(e) => setApiName(e.target.value)} placeholder="如 DeepSeek" />
        </SettingsRow>
        {apiKind === 'openai-compatible-api' && (
          <SettingsRow badge="required" title="接口地址" hint="服务商接入文档里有；用 OpenAI 官方就保持默认">
            <Input value={apiBaseURL} onChange={(e) => setApiBaseURL(e.target.value)} placeholder="https://api.openai.com/v1" />
          </SettingsRow>
        )}
        <SettingsRow badge="required" title="模型清单" hint="第一行是主模型；手动添加的恒显示。「自动识别」拉取的进待选池，点「选用」才进工作台下拉；每行窗口留空=继承档案级">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Button size="sm" variant="ghost" loading={discovering} title="从服务商拉取最新模型进待选池；已选用与手填的行不受影响"
                onClick={() => void refreshModels(true)}>🔄 自动识别</Button>
              <Button size="sm" variant="ghost" onClick={() => setApiModels((old) => [...old, { model: '', source: 'manual' as const }])}>＋ 添加模型</Button>
            </div>
            {apiModels.map((row, idx) => ({ row, idx })).filter(({ row }) => row.visible !== false).map(({ row, idx }) => (
              <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                  value={row.model}
                  list="executor-model-suggestions"
                  placeholder={idx === 0 ? '主模型，如 gpt-4o / deepseek-chat / gemini-2.0-flash' : '再加一个模型'}
                  onChange={(e) => setApiModels((old) => old.map((r, i) => (i === idx ? { ...r, model: e.target.value, source: 'manual' as const } : r)))}
                  style={{ flex: '1 1 200px', minWidth: 0 }}
                />
                {idx === 0 && <Badge tone="neutral">主模型</Badge>}
                <Input
                  type="number"
                  min={1000}
                  value={row.contextWindowTokens ?? ''}
                  placeholder="窗口(可选)"
                  title="该模型的上下文窗口（token）；留空继承档案级"
                  onChange={(e) => setApiModels((old) => old.map((r, i) => (i === idx ? { ...r, contextWindowTokens: e.target.value === '' ? undefined : Number(e.target.value) } : r)))}
                  style={{ width: 140, flex: '0 0 140px' }}
                />
                {idx !== 0 && (
                  <Button variant="ghost" onClick={() => setApiModels((old) => old.map((r, i) => (i === idx ? { ...r, visible: false } : r)))} title="从工作台模型下拉隐藏（保留在待选池）">隐藏</Button>
                )}
                {apiModels.length > 1 && (
                  <Button size="sm" variant="ghost" onClick={() => setApiModels((old) => old.filter((_, i) => i !== idx))} title="删除该模型">✕</Button>
                )}
              </div>
            ))}
            {apiModels.some((row) => row.visible === false) && (
              <>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  已识别待选 {apiModels.filter((row) => row.visible === false).length} 个——工作台下拉不显示；点「选用」加入，再次识别会整体刷新这一池（手填与已选用不受影响）
                </div>
                {apiModels.map((row, idx) => ({ row, idx })).filter(({ row }) => row.visible === false).map(({ row, idx }) => (
                  <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Input
                      value={row.model}
                      list="executor-model-suggestions"
                      onChange={(e) => setApiModels((old) => old.map((r, i) => (i === idx ? { ...r, model: e.target.value } : r)))}
                      style={{ flex: '1 1 200px', minWidth: 0 }}
                    />
                    <Input
                      type="number"
                      min={1000}
                      value={row.contextWindowTokens ?? ''}
                      placeholder="窗口(可选)"
                      title="该模型的上下文窗口（token）；留空继承档案级"
                      onChange={(e) => setApiModels((old) => old.map((r, i) => (i === idx ? { ...r, contextWindowTokens: e.target.value === '' ? undefined : Number(e.target.value) } : r)))}
                      style={{ width: 120, flex: '0 1 120px' }}
                    />
                    <Button variant="ghost" onClick={() => setApiModels((old) => old.map((r, i) => (i === idx ? { ...r, visible: true } : r)))} title="加入工作台模型下拉">选用</Button>
                    <Button variant="ghost" onClick={() => setApiModels((old) => old.filter((_, i) => i !== idx))} title="删除该模型">✕</Button>
                  </div>
                ))}
              </>
            )}
          </div>
        </SettingsRow>
        <datalist id="executor-model-suggestions">
          {[...new Set([
            ...(apiKind === 'openai-compatible-api'
              ? ['gpt-4o', 'gpt-4o-mini', 'o3', 'deepseek-chat', 'qwen-max', 'glm-4.7']
              : ['gemini-2.0-flash', 'gemini-2.5-pro']),
            ...apiModels.map((r) => r.model.trim()),
          ])].filter(Boolean).map((m) => <option key={m} value={m} />)}
        </datalist>
        <SettingsRow badge="required" title="API Key" hint={'直接粘贴即可：muster 只存本机数据目录（~/.muster/env，不上传、不进数据库）。' + (keyConfigured ? ' 当前已设置过，可留空不改动。' : '')}>
          <Input
            type="password"
            value={apiKeyValue}
            onChange={(e) => setApiKeyValue(e.target.value)}
            placeholder={keyConfigured === false ? '尚未设置，粘贴你的 Key' : keyConfigured ? '已设置（粘贴新值可更换）' : '粘贴你的 API Key'}
            autoComplete="off"
          />
        </SettingsRow>
        {apiKeyValue.trim() && (
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 0', textAlign: 'right' }}>
            粘贴的 Key 会随「创建并测试」保存到本机并立即生效。
          </p>
        )}

        <div className="settings-primary-actions">
          {editingProfileId ? (
            <>
              <Button variant="ghost" onClick={() => setEditingProfileId(null)}>取消编辑</Button>
              <Button onClick={() => updateApi.mutate(editingProfileId)} loading={updateApi.isPending} disabled={!apiName.trim() || !apiKeyEnv.trim()}>保存修改</Button>
            </>
          ) : (
            <Button onClick={() => createApi.mutate()} loading={createApi.isPending} disabled={!apiName.trim() || !apiKeyEnv.trim()}>
              {editingProfileId ? '保存修改' : '创建并测试'}
            </Button>
          )}
        </div>
        {newlyCreatedId && <ProbeResult probeId={probeIds[`${newlyCreatedId}:connectivity`]} />}

        <SettingsFold summary="高级选项（并发 · Key 变量名 · 思考深度 · 能力声明——默认值即可，不用动）">
          <SettingsRow title="Key 变量名" hint="如果你习惯自己管理环境变量，改这里；粘贴框留空时用的就是它">
            <Input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="如 OPENAI_API_KEY" />
          </SettingsRow>
          <SettingsRow title="并发模式" hint="多个任务能不能同时用这个接口：一般保持默认">
            <Select value={apiConcurrency} onChange={(e) => setApiConcurrency((e.target as HTMLSelectElement).value as typeof apiConcurrency)}>
              <option value="parallel">允许同时跑（推荐）</option>
              <option value="profile-serial">同一配置排队</option>
              <option value="global-serial">全局排队</option>
            </Select>
          </SettingsRow>
          <SettingsRow title="最大并发" hint="同时最多跑几个任务；套餐只许 1 个并发就填 1">
            <Input type="number" min={1} max={64} value={apiMaxConcurrency} onChange={(e) => setApiMaxConcurrency(Number(e.target.value))} />
          </SettingsRow>
          <SettingsRow title="锁定并发" hint="打开后始终用满最大并发数，不会被系统自动调低（防高并发卡死）">
            <Select value={apiConcurrencyLocked ? 'locked' : 'unlocked'} onChange={(e) => setApiConcurrencyLocked((e.target as HTMLSelectElement).value === 'locked')}>
              <option value="unlocked">不锁定（推荐）</option>
              <option value="locked">锁定</option>
            </Select>
          </SettingsRow>
          {apiKind === 'openai-compatible-api' && (
            <SettingsRow title="API 格式" hint="服务商两种接口都支持时保持默认；只有 OpenAI 官方新接口（/responses）才选 Responses">
              <Select value={apiFormat} onChange={(e) => setApiFormat((e.target as HTMLSelectElement).value as typeof apiFormat)}>
                <option value="chat-completions">Chat Completions（推荐）</option>
                <option value="responses">Responses</option>
              </Select>
            </SettingsRow>
          )}
          <SettingsRow title="档案级上下文窗口" hint="该档案所有模型的兜底窗口（token）；单模型不同窗口用模型清单行级窗口覆盖。留空=默认 128k">
            <Input
              type="number"
              min={1000}
              value={apiContextWindow}
              placeholder="默认 128000"
              onChange={(e) => setApiContextWindow(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </SettingsRow>
          <SettingsRow title="思考深度" hint="仅支持的模型生效（o 系列/thinking 模型），其他模型自动忽略">
            <Select value={apiThinkingDepth} onChange={(e) => setApiThinkingDepth((e.target as HTMLSelectElement).value as typeof apiThinkingDepth)}>
              <option value="off">关闭</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </Select>
          </SettingsRow>
          <SettingsRow title="上下文缓存" hint="保持默认可节省成本">
            <Select value={apiContextCache} onChange={(e) => setApiContextCache((e.target as HTMLSelectElement).value as typeof apiContextCache)}>
              <option value="auto">自动（推荐）</option>
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </Select>
          </SettingsRow>
          <SettingsRow title="能力声明" hint="按模型名已自动预填，一般不用改；带图任务走 vision，画图/语音等走工具层不在此声明">
            <div className="form-row" style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              {EXECUTOR_CAPABILITIES.map((cap) => (
                <label key={cap.id} className="checkbox-row" style={{ marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={apiCapabilities.includes(cap.id)}
                    onChange={(e) => setApiCapabilities((old) => (e.target.checked ? [...old, cap.id] : old.filter((c) => c !== cap.id)))}
                  />
                  {cap.label}
                </label>
              ))}
            </div>
          </SettingsRow>
        </SettingsFold>
      </Card>

      <Card title="已接入的 API 接口" className="section">
        <details className="details-collapse" style={{ marginBottom: 8 }}>
          <summary className="muted">按能力筛选</summary>
          <div className="form-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {EXECUTOR_CAPABILITIES.map((cap) => {
              const active = capFilter.includes(cap.id);
              return (
                <label
                  key={cap.id}
                  style={{ cursor: 'pointer', fontSize: 12, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent-subtle, var(--bg-elev))' : 'transparent', borderRadius: 999, padding: '2px 10px' }}
                >
                  <input type="checkbox" checked={active} style={{ display: 'none' }}
                    onChange={() => setCapFilter((old) => (old.includes(cap.id) ? old.filter((c) => c !== cap.id) : [...old, cap.id]))} />
                  {cap.label}
                </label>
              );
            })}
          </div>
        </details>
        <p className="muted" style={{ margin: '0 0 6px' }}>按用途分了三档（重要环节 / 普通任务 / 轻活）；不分配档位也能正常被任务选用。指派给具体智能体在工作台组织架构页操作。</p>
        <ul className="entity-list">
          {readyEntries('api').length === 0 && <li className="muted">还没有已接入的 API——上面填好后点「创建并测试」就会出现在这里。</li>}
          {readyEntries('api').map((entry) => entry.kind === 'header'
            ? <li key={`hdr-${entry.tier}`} className="muted" style={{ padding: '6px 2px 2px', fontSize: 11, letterSpacing: 0.5 }}>{(entry as { headerLabel: string }).headerLabel}</li>
            : renderProfileRow((entry as { profile: ExecutorProfile }).profile)
          )}
        </ul>
      </Card>
      </>
      )}

      <Card title="档位与兜底" className="section">
        <p className="muted">三档告诉系统「什么活派给哪个执行器」；都不设置就全部跟随系统默认。兜底只在没有任何匹配执行器时启用，保证任务总能跑起来。</p>
        {([
          { id: 'high', badge: 'recommended' as const, title: '高级档', hint: '计划、验收、裁决这类重要环节用的执行器', value: tierHigh, set: setTierHigh },
          { id: 'standard', badge: undefined, title: '标准档', hint: '普通任务的默认执行器', value: tierStandard, set: setTierStandard },
          { id: 'low', badge: undefined, title: '低档', hint: '蜂群工蜂、快速咨询这类轻活用的执行器', value: tierLow, set: setTierLow },
        ]).map((tier) => {
          const picked = (profiles.data ?? []).find((p) => p.id === tier.value);
          const pickedKind = picked ? manifests.data?.find((m) => m.id === picked.manifestId)?.kind : undefined;
          const models = picked ? profileModels(picked.config).filter((m) => m.visible !== false).map((m) => m.model) : [];
          return (
            <SettingsRow key={tier.id} badge={tier.badge} title={tier.title} hint={tier.hint}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                <Select value={tier.value} onChange={(e) => tier.set(e.target.value)}>
                  <option value="">跟随系统默认</option>
                  {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                {picked && (
                  <div className="muted" style={{ fontSize: 11 }}>
                    {pickedKind === 'cli'
                      ? '命令行工具——用自己登录的默认模型，无需配置'
                      : models.length > 0
                        ? `该档将用这些模型：${models.join(' / ')}`
                        : '该接口还没选用模型——到 API 标签编辑档案，从待选池「选用」'}
                  </div>
                )}
              </div>
            </SettingsRow>
          );
        })}
        <SettingsSectionLabel>兜底（没有匹配执行器时使用）</SettingsSectionLabel>
        <SettingsRow title="默认执行引擎" hint="智能体未指定执行器时的兜底引擎；用 CLI 一般保持 Claude Code CLI 不变">
          <Select value={fallbackProvider} onChange={(e) => setFallbackProvider(e.target.value)}>
            <option value="claude-cli">Claude Code CLI</option>
            <option value="codex-cli">Codex CLI</option>
            <option value="antigravity-cli">Antigravity CLI</option>
            <option value="custom-cli">自定义 CLI</option>
            <option value="openai">OpenAI 兼容 API</option>
            <option value="gemini">Gemini API</option>
          </Select>
        </SettingsRow>
        <SettingsRow title="执行工具路径" hint="兜底 CLI 的命令位置，系统会自动检测；只有测试连接失败时才需要手动调整">
          <Input value={fallbackBin} placeholder="claude" onChange={(e) => setFallbackBin(e.target.value)} />
        </SettingsRow>
        <div className="settings-primary-actions">
          <Button onClick={handleSaveTierFallback} loading={saveTierFallback.isPending}>保存档位与兜底</Button>
        </div>
      </Card>

      <Card title="钥匙与凭据（统一管理）" className="section">
        <p className="muted">所有 API 接入的 Key 都在这里登记环境变量名并设默认派发；明文 Key 不存库，由系统环境变量提供。API 接入表单里引用的就是这里登记的名字。</p>
        <CredentialStorePanel />
      </Card>

      <SettingsFold summary="进阶 · 接入原理与流程图">
        <Card title="接入原理（四步详解）">
          <div style={{ marginBottom: '16px', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border-subtle, #eee)', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
            <img
              src="/images/executor_flow.jpg"
              alt="执行器接入四步流程：1.检测系统安装 2.API凭据配置 3.连通测试 4.绑定到智能体"
              style={{ width: '100%', height: 'auto', display: 'block', maxHeight: '220px', objectFit: 'cover' }}
            />
          </div>
          <ol>
            <li><strong>CLI 类</strong>（CLI 标签页）：扫描本机 → 未装则自动安装（安装前会再检测一次，已装直接启用不重复装）→ 登录用工具官方命令。</li>
            <li><strong>API 类</strong>（API 标签页）：填基础信息 + 粘贴 Key。</li>
            <li><strong>测试</strong>：创建时自动测连通；也可在已接入列表里随时手动「测试 / 测模型 / 测能力」。</li>
            <li><strong>指派给智能体</strong>：工作台组织架构页展开智能体，在「固定执行器」下拉选择；不指派则由档位自动选。</li>
          </ol>
          <ul className="muted">
            <li>CLI 的登录、签名和自动更新沿用官方机制；muster 只记录路径和版本。</li>
            <li>多个智能体可共用同一工具；会话、工作目录、日志、记忆仍按智能体与任务隔离。</li>
          </ul>
        </Card>
      </SettingsFold>
    </div>
  );
}

const TIER_LABELS: Record<string, string> = {
  high: '▲ 高级档 · 重要环节用（计划/验收/裁决）',
  standard: '● 标准档 · 普通任务',
  low: '▼ 低档 · 轻活（蜂群工蜂/咨询）',
  unassigned: '— 未分配档位（同样可用）',
};

function CliProposalView({ result, onFill, onCopy }: {
  result: ProposalResult<CliProposal>;
  onFill: (proposal: CliProposal) => void;
  onCopy: (command: string) => Promise<void>;
}): React.ReactElement {
  const { proposal, source, warning } = result;
  return (
    <div className="assistant-proposal">
      <div className="executor-card-head">
        <div className="executor-card-title">
          <strong>{proposal.displayName}</strong>
          <div className="muted">检测命令：{proposal.binaryName} {proposal.detectionArgs.join(' ')}</div>
        </div>
        <Badge tone={source === 'claude' ? 'ok' : 'info'}>{source === 'claude' ? 'AI 生成' : source === 'builtin_template' ? '内置模板' : '离线模板'}</Badge>
      </div>
      {warning && <p className="muted">{warning}</p>}
      {proposal.installCommands.map((command: string) => (
        <div className="install-command" key={command}>
          <code title={command}>{command}</code>
          <Button size="sm" variant="ghost" onClick={() => void onCopy(command)}>复制</Button>
        </div>
      ))}
      {proposal.loginCommand && (
        <div className="install-command">
          <code title={proposal.loginCommand}>{proposal.loginCommand}</code>
          <Button size="sm" variant="ghost" onClick={() => void onCopy(proposal.loginCommand)}>复制登录命令</Button>
        </div>
      )}
      <p className="muted">参数模板：<code>{proposal.argTemplate.join(' ')}</code></p>
      {proposal.notes && <p className="muted">{proposal.notes}</p>}
      <div className="settings-primary-actions">
        <Button variant="ghost" onClick={() => void onCopy(proposal.argTemplate.join('\n'))}>复制参数模板</Button>
        <Button onClick={() => onFill(proposal)}>填入手动表单</Button>
      </div>
    </div>
  );
}

function ProbeResult({ probeId }: { probeId?: string }): React.ReactElement | null {
  const probe = useQuery({
    queryKey: ['executor-probe', probeId],
    queryFn: () => api.get<ExecutorProbe>(`/api/executors/probes/${probeId}`),
    enabled: !!probeId,
    refetchInterval: (query) => ['queued', 'testing'].includes(query.state.data?.status ?? '') ? 500 : false,
  });
  if (!probeId) return null;
  const value = probe.data;
  if (!value) return <div className="diagnostic-text" aria-live="polite">正在测试…</div>;
  const kindLabel = value.kind === 'model' ? '指定模型' : value.kind === 'capability' ? '能力探针' : '连通测试';
  return (
    <div className="diagnostic-text" aria-live="polite">
      <span>{kindLabel}：</span>
      <StateBadge domain="probe" state={value.status} />
      {value.model && <span> {value.model}</span>}
      {value.classification && <><br />{probeClassificationLabel(value.classification)}{value.stderr ? `：${value.stderr}` : ''}</>}
      {value.kind === 'capability' && value.status === 'connected' && value.capability && <CapabilityBadges capability={value.capability} />}
      {value.completedAt && <><br /><span className="muted">{new Date(value.completedAt).toLocaleString()} · {value.durationMs}ms</span></>}
    </div>
  );
}

/**
 * 能力徽章：展示 API 执行器的能力矩阵（函数调用 / 工具循环 / 结构化输出 / 指令遵循），
 * 并明确标注能力边界（不能执行命令/构建/部署等需连接 CLI）。
 */
function CapabilityBadges({ capability }: { capability: CapabilityProbeResult | null }): React.ReactElement | null {
  if (!capability) return null;
  const levelTone = capability.instructionLevel === 'high' ? 'ok' : capability.instructionLevel === 'medium' ? 'info' : 'warn';
  const levelLabel = capability.instructionLevel === 'high' ? '高' : capability.instructionLevel === 'medium' ? '中' : '低';
  return (
    <div className="diagnostic-text" style={{ marginTop: 4 }}>
      <span className="muted">能力：</span>
      <Badge tone={capability.functionCalling ? 'ok' : 'warn'}>{capability.functionCalling ? '✓ 函数调用' : '✗ 函数调用'}</Badge>{' '}
      <Badge tone={capability.toolLoop ? 'ok' : 'warn'}>{capability.toolLoop ? '✓ 工具循环' : '✗ 工具循环'}</Badge>{' '}
      <Badge tone={capability.structuredOutput ? 'ok' : 'warn'}>{capability.structuredOutput ? '✓ 结构化输出' : '✗ 结构化输出'}</Badge>{' '}
      <Badge tone={levelTone}>指令遵循：{levelLabel}</Badge>
      <div className="muted" style={{ marginTop: 4 }}>{capability.note}</div>
      <details style={{ marginTop: 4 }}>
        <summary className="muted">可执行 {capability.supportedTasks.length} 项 · 不可执行 {capability.unsupportedTasks.length} 项</summary>
        <div style={{ marginTop: 4 }}>
          <div className="muted">✓ 可执行：</div>
          <ul style={{ margin: '2px 0 6px 18px' }}>{capability.supportedTasks.map((t) => <li key={t}>{t}</li>)}</ul>
          <div className="muted">✗ 不可执行（建议连接 CLI）：</div>
          <ul style={{ margin: '2px 0 6px 18px' }}>{capability.unsupportedTasks.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      </details>
    </div>
  );
}
