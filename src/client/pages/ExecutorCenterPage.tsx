import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge, StateBadge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import { useGenerateCliProposal, type CliProposal, type ProposalResult } from '../hooks/queries';
import {
  concurrencyLabel,
  probeClassificationLabel,
  type CapabilityProbeResult,
  type ExecutorDetection,
  type ExecutorManifest,
  type ExecutorProbe,
  type ExecutorProfile,
  type CredentialReference,
} from '../../shared/executor';

/**
 * 执行器接入中心。
 * 两块视图：
 *  1. 执行器库（CLI 类 + API 类）：检测/连通测试/如何连接说明。
 *  2. 已绑定执行器：测试结果，员工绑定在公司组织架构页做（不在此重复）。
 * 执行器连通测试只测一次，员工复用其结果，不再各自测试。
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

  // API 凭据执行器
  const [apiKind, setApiKind] = useState<'openai-compatible-api' | 'gemini-api'>('openai-compatible-api');
  const [apiName, setApiName] = useState('OpenAI 兼容 API');
  const [apiBaseURL, setApiBaseURL] = useState('https://api.openai.com/v1');
  const [apiModel, setApiModel] = useState('gpt-4o');
  const [apiKeyEnv, setApiKeyEnv] = useState('OPENAI_API_KEY');

  const detect = useMutation({
    mutationFn: (id: string) => api.post<ExecutorDetection>(`/api/executors/${id}/detect`),
    onSuccess: (result, id) => setDetections((old) => ({ ...old, [id]: result })),
    onError: (e: unknown) => toast('error', (e as Error).message ?? '检测失败'),
  });
  const bind = useMutation({
    mutationFn: (id: string) => api.post<ExecutorProfile>(`/api/executors/${id}/bind-system`),
    onSuccess: (profile) => { void qc.invalidateQueries({ queryKey: ['executor-profiles'] }); toast('success', `已绑定 ${profile.name}`); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '绑定失败'),
  });
  // 一键检测全部：并行检测所有可检测 CLI，合并进 detections
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
      toast('success', `检测完成：${results.length} 个 CLI，检测到 ${found} 个已安装`);
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '检测失败'),
  });

  /** 一键安装 CLI：fetch POST 后手动解析 SSE 事件流，逐行更新日志。 */
  const installCli = async (manifestId: string): Promise<void> => {
    setInstallStates((old) => ({ ...old, [manifestId]: { status: 'running', logs: ['正在连接安装通道…'], diagnosis: null } }));
    // 提升到 try 外：正常流与 catch 分支共用（避免日志重复拼装）
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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['executor-profiles'] }); toast('success', '自定义 CLI 档案已创建'); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const createApi = useMutation({
    mutationFn: () => {
      const credentialRef: CredentialReference = { kind: 'env', reference: apiKeyEnv.trim() };
      const config: Record<string, unknown> = apiKind === 'openai-compatible-api'
        ? { provider: 'openai', baseURL: apiBaseURL.trim(), model: apiModel.trim() }
        : { provider: 'gemini', model: apiModel.trim() };
      return api.post<ExecutorProfile>('/api/executors/profiles', {
        name: apiName.trim(),
        manifestId: apiKind,
        config,
        credentialRef,
        concurrencyMode: 'profile-serial',
      });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['executor-profiles'] }); toast('success', 'API 执行器已创建，可在公司组织架构绑定给员工'); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const testConnection = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'connectivity' | 'model' | 'capability' }) =>
      api.post<ExecutorProbe>(`/api/executors/profiles/${id}/probes`, { force: true, kind }),
    onSuccess: (probe, input) => setProbeIds((old) => ({ ...old, [`${input.id}:${input.kind}`]: probe.id })),
    onError: (e: unknown) => toast('error', (e as Error).message ?? '联通测试失败'),
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
          <p className="subtitle">在此统一检测执行器连通性、配置 API 凭据。员工在公司组织架构页绑定执行器，复用这里的测试结果，无需逐个测试。</p>
        </div>
      </header>

      <Card
        title="执行器库（CLI）"
        actions={
          <Button variant="ghost" size="sm" onClick={() => detectAll.mutate()} loading={detectAll.isPending}>
            {detectAll.isPending ? '正在检测全部…' : '一键检测全部'}
          </Button>
        }
      >
        <p className="muted">点击「一键检测全部」自动扫描系统里的 CLI；未安装的可用「一键安装」用官方方式自动安装，无需手动复制命令。</p>
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
                    <div className="muted">官方系统安装 · {concurrencyLabel(manifest.concurrency)}</div>
                  </div>
                  <Badge tone={bound ? 'ok' : detection?.found ? 'info' : 'neutral'}>{bound ? '已绑定' : detection?.found ? '已安装' : '待检测'}</Badge>
                </div>
                <div className="executor-card-body">
                  {detection?.found ? (
                    <>
                      <p className="diagnostic-text">{detection.version}<br /><span className="muted">{detection.path}</span></p>
                      {install?.loginCommand && (
                        <div className="install-command">
                          <code>{install.loginCommand}</code>
                          <Button size="sm" variant="ghost" onClick={() => void copy(install.loginCommand)}>复制登录命令</Button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {!installState?.status || installState.status === 'idle' ? (
                        <>
                          <p className="muted">未检测到安装。可一键自动安装（官方方式），或展开手动复制命令。</p>
                          {install && (
                            <details className="install-collapse">
                              <summary>官方安装方式（{install.commands.length} 种）</summary>
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
                  <a href={install?.guideUrl ?? manifest.officialSource} target="_blank" rel="noreferrer">打开官方安装说明</a>
                  <div className="settings-primary-actions">
                    <Button variant="ghost" onClick={() => detect.mutate(manifest.id)} loading={detect.isPending}>检测系统安装</Button>
                    {detection?.found && !bound && <Button onClick={() => bind.mutate(manifest.id)} loading={bind.isPending}>绑定此安装</Button>}
                    {!detection?.found && install && (
                      <Button onClick={() => void installCli(manifest.id)} loading={installing} disabled={installing}>
                        {installing ? '安装中…' : installState?.status === 'error' ? '重试安装' : '一键安装'}
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </Card>

      <Card title="API 凭据执行器" className="section">
        <p className="muted">OpenAI 兼容 / Gemini API 执行器。Muster 只存环境变量名（不存明文），实际密钥由系统环境变量提供。绑定到员工后即可使用。</p>
        <div className="form-stack">
          <div className="form-row">
            <Field label="执行器类型">
              <Select value={apiKind} onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value as typeof apiKind;
                setApiKind(v);
                if (v === 'openai-compatible-api') { setApiName('OpenAI 兼容 API'); setApiBaseURL('https://api.openai.com/v1'); setApiModel('gpt-4o'); setApiKeyEnv('OPENAI_API_KEY'); }
                else { setApiName('Gemini API'); setApiModel('gemini-2.0-flash'); setApiKeyEnv('GEMINI_API_KEY'); }
              }}>
                <option value="openai-compatible-api">OpenAI 兼容 API</option>
                <option value="gemini-api">Gemini API</option>
              </Select>
            </Field>
            <Field label="档案名称"><Input value={apiName} onChange={(e) => setApiName(e.target.value)} /></Field>
          </div>
          {apiKind === 'openai-compatible-api' && (
            <Field label="Base URL"><Input value={apiBaseURL} onChange={(e) => setApiBaseURL(e.target.value)} placeholder="https://api.openai.com/v1" /></Field>
          )}
          <div className="form-row">
            <Field label="默认模型"><Input value={apiModel} onChange={(e) => setApiModel(e.target.value)} /></Field>
            <Field label="API Key 环境变量名（不存明文）">
              <Input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="如 OPENAI_API_KEY" />
            </Field>
          </div>
          <div className="settings-primary-actions">
            <Button onClick={() => createApi.mutate()} loading={createApi.isPending} disabled={!apiName.trim() || !apiKeyEnv.trim()}>创建 API 执行器</Button>
          </div>
        </div>
      </Card>

      <Card title="已绑定执行器" className="section">
        <p className="muted">连通测试在这里做一次；员工绑定后复用结果。哪些员工在用某个执行器，请到对应公司的「组织架构」查看。</p>
        <ul className="entity-list">
          {profiles.data?.map((profile) => {
            const hasModel = typeof profile.config.model === 'string' && Boolean(String(profile.config.model).trim());
            const manifestKind = manifests.data?.find((m) => m.id === profile.manifestId)?.kind;
            const isApi = manifestKind === 'api';
            return (
              <li key={profile.id} style={{ display: 'block' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{profile.name}</strong>
                    <div className="muted">{String(profile.config.binaryPath ?? profile.manifestId)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'connectivity' })} loading={testConnection.isPending}>联通测试</Button>
                  {hasModel && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'model' })} loading={testConnection.isPending}>测试模型</Button>}
                  {isApi && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'capability' })} loading={testConnection.isPending}>测试能力</Button>}
                </div>
                <ProbeResult probeId={probeIds[`${profile.id}:connectivity`]} />
                {hasModel && <ProbeResult probeId={probeIds[`${profile.id}:model`]} />}
                {isApi && <ProbeResult probeId={probeIds[`${profile.id}:capability`]} />}
                {isApi && <CapabilityBadges capability={profile.capability?.capabilityJson ?? null} />}
              </li>
            );
          })}
          {profiles.data?.length === 0 && <li className="muted">还没有绑定的执行器。上方检测 CLI 或创建 API 执行器后，会出现在这里。</li>}
        </ul>
      </Card>

      <Card title="接入其他 CLI" className="section">
        <p className="muted">
          面向内置清单未收录的第三方 CLI（如 <code>aider</code>、<code>qwen-code</code>）。配置后 Muster 会以参数数组启动它，不经过 shell。
          <strong>限制：</strong>非交互运行、退出码须为 0、且 stdout 必须是结构化 <code>AgentRunResult</code> JSON；不接管原生审批。不确定怎么填时，用下方「AI 引导接入」自动生成。
        </p>
        <details className="details-collapse">
          <summary>AI 引导接入：描述你的 CLI，自动生成配置</summary>
          <div className="form-stack">
            <Field label="CLI 描述" hint="例如：opencode / aider / 我团队用的 qwen-code">
              <textarea value={assistantPrompt} onChange={(e) => setAssistantPrompt(e.target.value)} placeholder="例如：opencode，模型无关的开源 agent" />
            </Field>
            <div className="settings-primary-actions">
              <Button variant="ghost" onClick={() => generateCli.mutate({ prompt: assistantPrompt })} loading={generateCli.isPending} disabled={!assistantPrompt.trim()}>生成接入方案</Button>
            </div>
            {generateCli.data && <CliProposalView result={generateCli.data} onFill={fillCustomForm} onCopy={copy} />}
          </div>
        </details>
        <div className="form-stack">
          <div className="settings-field-grid">
            <Field label="档案名称"><Input value={customName} onChange={(e) => setCustomName(e.target.value)} /></Field>
            <Field label="可执行文件绝对路径或命令名"><Input value={customPath} onChange={(e) => setCustomPath(e.target.value)} placeholder="/usr/local/bin/my-agent 或命令名（如 opencode）" /></Field>
          </div>
          <Field label="参数模板（每行一项）" hint="只支持整项占位符：{prompt}、{cwd}、{taskId}、{sessionId}">
            <textarea value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} placeholder={'--print\n{prompt}\n--cwd\n{cwd}'} />
          </Field>
          <div className="settings-primary-actions">
            <Button onClick={() => createCustom.mutate()} disabled={!customPath.trim()} loading={createCustom.isPending}>创建自定义执行器</Button>
          </div>
        </div>
      </Card>

      <Card title="如何连接（接入流程）" className="section">
        <div style={{ marginBottom: '16px', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border-subtle, #eee)', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
          <img
            src="/images/executor_flow.jpg"
            alt="执行器接入四步流程：1.检测系统安装 2.API凭据配置 3.连通测试 4.绑定到员工"
            style={{ width: '100%', height: 'auto', display: 'block', maxHeight: '220px', objectFit: 'cover' }}
          />
        </div>
        <ol>
          <li><strong>CLI 类</strong>：点击「检测系统安装」。若未检测到，按卡片内官方命令安装并登录，完成后回到这里点「检测」→「绑定此安装」。</li>
          <li><strong>API 类</strong>：在「API 凭据执行器」填写 Base URL / 模型 / 环境变量名（如 <code>OPENAI_API_KEY</code>），创建档案。实际密钥需设置在系统环境变量中，Muster 不保存明文。</li>
          <li><strong>连通测试</strong>：在「已绑定执行器」点「联通测试」（验证 CLI 可执行 / API 可达）或「测试模型」（验证模型可用）。</li>
          <li><strong>绑定到员工</strong>：进入公司「组织架构」页，展开员工配置，在「固定执行器」下拉选择。员工复用执行器的测试结果，无需各自测试。</li>
        </ol>
        <ul className="muted">
          <li>CLI 登录、签名和自动更新沿用官方机制；Muster 只记录路径和版本。</li>
          <li>员工可共用同一执行器，但会话、工作目录、日志、记忆和中止状态仍按员工与 Task 隔离。</li>
        </ul>
      </Card>
    </div>
  );
}

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
        <Button onClick={() => onFill(proposal)}>填入下方表单</Button>
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
  if (!value) return <div className="diagnostic-text" aria-live="polite">正在启动测试…</div>;
  const kindLabel = value.kind === 'model' ? '指定模型' : value.kind === 'capability' ? '能力探针' : '基础联通';
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
 * 能力徽章：展示 API 执行器的能力矩阵（function calling / 工具循环 / 结构化输出 / 指令遵循），
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
