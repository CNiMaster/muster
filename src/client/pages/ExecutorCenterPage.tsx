import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge, StateBadge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Input, Select } from '../components/Form';
import { SettingsRow, SettingsFold } from '../components/SettingsRow';
import { useGenerateCliProposal, useCredentialDefinitions, useSystemSettings, type CliProposal, type ProposalResult } from '../hooks/queries';
import {
  concurrencyLabel,
  probeClassificationLabel,
  EXECUTOR_CAPABILITIES,
  suggestDefaultCapabilities,
  type CapabilityProbeResult,
  type ExecutorDetection,
  type ExecutorManifest,
  type ExecutorProbe,
  type ExecutorProfile,
  type CredentialReference,
} from '../../shared/executor';

/**
 * 执行器接入中心（2026-08-25 向导化重做）。
 * 新手旅程三步：① 选工具（CLI 自动扫描/自动安装；API 走第二步）→ ② 给钥匙（API 表单 5 个基础字段，
 * Key 经环境变量提供并给手把手指引）→ ③ 创建即自动测通。高级参数全部折叠；概念白话化：
 * 档案→接入配置、绑定→启用、探针→测试。全部原有 mutation/handler 保留，仅重排呈现。
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
  const [apiModel, setApiModel] = useState('gpt-4o');
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
  const [apiContextCache, setApiContextCache] = useState<'auto' | 'on' | 'off'>('auto');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  /** 刚创建的 API 配置 id：创建成功自动触发连通测试并把结果展示在表单下方。 */
  const [newlyCreatedId, setNewlyCreatedId] = useState<string | null>(null);

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
    mutationFn: ({ id, kind }: { id: string; kind: 'connectivity' | 'model' | 'capability' }) =>
      api.post<ExecutorProbe>(`/api/executors/profiles/${id}/probes`, { force: true, kind }),
    onSuccess: (probe, input) => {
      setProbeIds((old) => ({ ...old, [`${input.id}:${input.kind}`]: probe.id }));
      if (input.kind === 'connectivity') {
        if (probe.status === 'connected') toast('success', '测试通过！这个接口可以用了');
        else if (probe.status === 'failed') toast('error', '测试未通过——多半是 Key 没设好，照上方「把 Key 给 muster」三步再来一次');
      }
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '测试失败'),
  });
  const createApi = useMutation({
    mutationFn: async () => {
      // 用户粘贴了 Key：先落本机密钥文件并热注入进程 env（创建后自动测试立即生效）
      if (apiKeyValue.trim()) {
        await api.post('/api/executors/credentials/save', { name: apiKeyEnv.trim(), value: apiKeyValue.trim() });
      }
      const credentialRef: CredentialReference = { kind: 'env', reference: apiKeyEnv.trim() };
      const config: Record<string, unknown> = apiKind === 'openai-compatible-api'
        ? { provider: 'openai', baseURL: apiBaseURL.trim(), model: apiModel.trim() }
        : { provider: 'gemini', model: apiModel.trim() };
      config.thinkingDepth = apiThinkingDepth;
      config.contextCache = apiContextCache;
      if (apiCapabilities.length > 0) config.capabilities = apiCapabilities;
      return api.post<ExecutorProfile>('/api/executors/profiles', {
        name: apiName.trim(),
        manifestId: apiKind,
        config,
        credentialRef,
        concurrencyMode: apiConcurrency,
        maxConcurrency: apiMaxConcurrency,
        concurrencyLocked: apiConcurrencyLocked,
      });
    },
    onSuccess: (profile) => {
      void qc.invalidateQueries({ queryKey: ['executor-profiles'] });
      setEditingProfileId(null);
      setApiKeyValue('');
      setKeyConfigured(true);
      // 向导第 3 步自动化：创建成功立即自动测通，结果直接展示在表单下方
      setNewlyCreatedId(profile.id);
      testConnection.mutate({ id: profile.id, kind: 'connectivity' });
      toast('success', '已保存，正在自动测试连通性…');
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const updateApi = useMutation({
    mutationFn: (profileId: string) => {
      const credentialRef: CredentialReference = { kind: 'env', reference: apiKeyEnv.trim() };
      const config: Record<string, unknown> = apiKind === 'openai-compatible-api'
        ? { provider: 'openai', baseURL: apiBaseURL.trim(), model: apiModel.trim() }
        : { provider: 'gemini', model: apiModel.trim() };
      config.thinkingDepth = apiThinkingDepth;
      config.contextCache = apiContextCache;
      if (apiCapabilities.length > 0) config.capabilities = apiCapabilities;
      return api.put<ExecutorProfile>(`/api/executors/profiles/${profileId}`, {
        name: apiName.trim(),
        config,
        credentialRef,
        concurrencyMode: apiConcurrency,
        maxConcurrency: apiMaxConcurrency,
        concurrencyLocked: apiConcurrencyLocked,
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
          <p className="subtitle">接好一个工具只要三步：选它 → 给钥匙 → 测试通过即可使用。</p>
        </div>
      </header>

      <Card
        title="第 1 步 · 用哪个工具（命令行类）"
        actions={
          <Button variant="ghost" size="sm" onClick={() => detectAll.mutate()} loading={detectAll.isPending}>
            {detectAll.isPending ? '正在扫描…' : '扫描本机已装工具'}
          </Button>
        }
      >
        <p className="muted">点上方按钮自动扫描电脑里装好的工具；扫到就点「立即启用」，没装的点「自动安装」（官方方式，不用手动敲命令）。</p>
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
                  <Badge tone={bound ? 'ok' : detection?.found ? 'info' : 'neutral'}>{bound ? '✓ 可用' : detection?.found ? '已安装' : '未扫描'}</Badge>
                </div>
                <div className="executor-card-body">
                  {detection?.found ? (
                    <>
                      <p className="diagnostic-text">{detection.version}<br /><span className="muted">{detection.path}</span></p>
                      {install?.loginCommand && !bound && (
                        <div className="install-command">
                          <code>{install.loginCommand}</code>
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
                    {!detection?.found && <Button variant="ghost" onClick={() => detect.mutate(manifest.id)} loading={detect.isPending}>重新扫描</Button>}
                    {detection?.found && !bound && <Button onClick={() => bind.mutate(manifest.id)} loading={bind.isPending}>立即启用</Button>}
                    {!detection?.found && install && (
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
          启用后就完成了——任务会按「模型与档位」自动选用工具，无需再配置。
        </p>
      </Card>

      <Card title="第 2 步 · 连接 AI 接口（可选，想用 API 时才填）" className="section">
        <SettingsRow badge="required" title="接口类型">
          <Select value={apiKind} onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value as typeof apiKind;
            setApiKind(v);
            if (v === 'openai-compatible-api') { setApiBaseURL('https://api.openai.com/v1'); setApiModel('gpt-4o'); setApiKeyEnv('OPENAI_API_KEY'); }
            else { setApiModel('gemini-2.0-flash'); setApiKeyEnv('GEMINI_API_KEY'); }
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
        <SettingsRow badge="required" title="模型名" hint="填该服务的模型标识，如 gpt-4o / deepseek-chat / gemini-2.0-flash">
          <Input value={apiModel} list="executor-model-suggestions" onChange={(e) => setApiModel(e.target.value)} />
        </SettingsRow>
        <datalist id="executor-model-suggestions">
          {(apiKind === 'openai-compatible-api'
            ? ['gpt-4o', 'gpt-4o-mini', 'o3', 'deepseek-chat', 'qwen-max', 'glm-4.7']
            : ['gemini-2.0-flash', 'gemini-2.5-pro']
          ).map((m) => <option key={m} value={m} />)}
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
        <SettingsRow title="Key 变量名" hint="高级选项：如果你习惯自己管理环境变量，改这里后留空上面的粘贴框即可">
          <Input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="如 OPENAI_API_KEY" />
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
              {editingProfileId ? '保存修改' : '第 3 步 · 创建并测试'}
            </Button>
          )}
        </div>
        {newlyCreatedId && <ProbeResult probeId={probeIds[`${newlyCreatedId}:connectivity`]} />}

        <SettingsFold summary="高级选项（并发 · 思考深度 · 能力声明——默认值即可，不用动）">
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

      <Card title="已就绪的工具" className="section">
        <p className="muted">按用途分了三档（重要环节 / 普通任务 / 轻活）；不分配档位也能正常被任务选用。指派给具体智能体在工作台组织架构页操作。</p>

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
        <ul className="entity-list">
          {groupedList.map((entry) => {
            if (entry.kind === 'header') {
              return (
                <li key={`hdr-${entry.tier}`} className="muted" style={{ padding: '6px 2px 2px', fontSize: 11, letterSpacing: 0.5 }}>
                  {(entry as any).headerLabel}
                </li>
              );
            }
            const profile = (entry as any).profile as ExecutorProfile;
            const hasModel = typeof profile.config.model === 'string' && Boolean(String(profile.config.model).trim());
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
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'connectivity' })} loading={testConnection.isPending}>测试</Button>
                  {hasModel && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'model' })} loading={testConnection.isPending}>测模型</Button>}
                  {isApi && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'capability' })} loading={testConnection.isPending}>测能力</Button>}
                  {isApi && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      setEditingProfileId(profile.id);
                      setApiKind(profile.manifestId as 'openai-compatible-api' | 'gemini-api');
                      setApiName(profile.name);
                      setApiBaseURL(String(profile.config.baseURL ?? 'https://api.openai.com/v1'));
                      setApiModel(String(profile.config.model ?? ''));
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
                      setApiCapabilities(Array.isArray(profile.config.capabilities) ? profile.config.capabilities.filter((c): c is string => typeof c === 'string') : []);
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
          })}
          {profiles.data?.length === 0 && <li className="muted">还没有可用工具。完成上面第 1 或第 2 步就会出现在这里。</li>}
        </ul>
      </Card>

      <SettingsFold summary="进阶 · 接入清单之外的新工具与详细原理">
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
        <Card title="接入原理（四步详解）">
          <div style={{ marginBottom: '16px', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border-subtle, #eee)', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
            <img
              src="/images/executor_flow.jpg"
              alt="执行器接入四步流程：1.检测系统安装 2.API凭据配置 3.连通测试 4.绑定到智能体"
              style={{ width: '100%', height: 'auto', display: 'block', maxHeight: '220px', objectFit: 'cover' }}
            />
          </div>
          <ol>
            <li><strong>CLI 类</strong>：扫描本机 → 未装则自动安装并登录 → 「立即启用」。</li>
            <li><strong>API 类</strong>：第 2 步填基础信息 + 按指引设置环境变量 Key。</li>
            <li><strong>测试</strong>：创建时自动测连通；也可在「已就绪的工具」里随时手动「测试 / 测模型 / 测能力」。</li>
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
          <code>{command}</code>
          <Button size="sm" variant="ghost" onClick={() => void onCopy(command)}>复制</Button>
        </div>
      ))}
      {proposal.loginCommand && (
        <div className="install-command">
          <code>{proposal.loginCommand}</code>
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
