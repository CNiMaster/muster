import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge, StateBadge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import {
  concurrencyLabel,
  probeClassificationLabel,
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

  // 自定义 CLI
  const [customName, setCustomName] = useState('自定义 CLI');
  const [customPath, setCustomPath] = useState('');
  const [customArgs, setCustomArgs] = useState('{prompt}');

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
    mutationFn: ({ id, kind }: { id: string; kind: 'connectivity' | 'model' }) =>
      api.post<ExecutorProbe>(`/api/executors/profiles/${id}/probes`, { force: true, kind }),
    onSuccess: (probe, input) => setProbeIds((old) => ({ ...old, [`${input.id}:${input.kind}`]: probe.id })),
    onError: (e: unknown) => toast('error', (e as Error).message ?? '联通测试失败'),
  });
  const copy = async (command: string): Promise<void> => {
    await navigator.clipboard.writeText(command);
    toast('success', '命令已复制');
  };

  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h1>执行器接入中心</h1>
          <p className="subtitle">在此统一检测执行器连通性、配置 API 凭据。员工在公司组织架构页绑定执行器，复用这里的测试结果，无需逐个测试。</p>
        </div>
      </header>

      <Card title="执行器库（CLI）">
        <p className="muted">CLI 由官方安装到系统位置。Muster 只记录检测到的可执行文件路径和版本，不保存账号密码。</p>
        <div className="executor-grid">
          {(manifests.data ?? []).filter((m) => m.kind === 'cli').map((manifest) => {
            const detection = detections[manifest.id];
            const install = manifest.officialInstall;
            const bound = profiles.data?.some((profile) => profile.manifestId === manifest.id && (!detection?.path || profile.config.binaryPath === detection.path));
            return (
              <article className="executor-card" key={manifest.id}>
                <div className="executor-card-head">
                  <div>
                    <strong>{manifest.displayName}</strong>
                    <div className="muted">官方系统安装 · {concurrencyLabel(manifest.concurrency)}</div>
                  </div>
                  <Badge tone={bound ? 'ok' : detection?.found ? 'info' : 'neutral'}>{bound ? '已绑定' : detection?.found ? '已安装' : '待检测'}</Badge>
                </div>
                {detection?.found ? (
                  <div>
                    <p className="diagnostic-text">{detection.version}<br /><span className="muted">{detection.path}</span></p>
                    {install && (
                      <div className="install-command">
                        <code>{install.loginCommand}</code>
                        <Button size="sm" variant="ghost" onClick={() => void copy(install.loginCommand)}>复制登录命令</Button>
                      </div>
                    )}
                  </div>
                ) : install && (
                  <div className="official-install-guide">
                    <p className="muted">选择官方支持的安装方式：</p>
                    {install.commands.map((command: string) => (
                      <div className="install-command" key={command}>
                        <code>{command}</code>
                        <Button size="sm" variant="ghost" onClick={() => void copy(command)}>复制</Button>
                      </div>
                    ))}
                  </div>
                )}
                <a href={install?.guideUrl ?? manifest.officialSource} target="_blank" rel="noreferrer">打开官方安装说明</a>
                <div className="settings-primary-actions">
                  <Button variant="ghost" onClick={() => detect.mutate(manifest.id)} loading={detect.isPending}>检测系统安装</Button>
                  {detection?.found && !bound && <Button onClick={() => bind.mutate(manifest.id)} loading={bind.isPending}>绑定此安装</Button>}
                </div>
              </article>
            );
          })}
        </div>
      </Card>

      <Card title="API 凭据执行器" className="section">
        <p className="muted">OpenAI 兼容 / Gemini API 执行器。Muster 只存环境变量名（不存明文），实际密钥由系统环境变量提供。绑定到员工后即可使用。</p>
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
        <Button onClick={() => createApi.mutate()} loading={createApi.isPending} disabled={!apiName.trim() || !apiKeyEnv.trim()}>创建 API 执行器</Button>
      </Card>

      <Card title="已绑定执行器" className="section">
        <p className="muted">连通测试在这里做一次；员工绑定后复用结果。哪些员工在用某个执行器，请到对应公司的「组织架构」查看。</p>
        <ul className="entity-list">
          {profiles.data?.map((profile) => {
            const hasModel = typeof profile.config.model === 'string' && Boolean(String(profile.config.model).trim());
            return (
              <li key={profile.id} style={{ display: 'block' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{profile.name}</strong>
                    <div className="muted">{String(profile.config.binaryPath ?? profile.manifestId)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'connectivity' })} loading={testConnection.isPending}>联通测试</Button>
                  {hasModel && <Button size="sm" variant="ghost" onClick={() => testConnection.mutate({ id: profile.id, kind: 'model' })} loading={testConnection.isPending}>测试模型</Button>}
                </div>
                <ProbeResult probeId={probeIds[`${profile.id}:connectivity`]} />
                {hasModel && <ProbeResult probeId={probeIds[`${profile.id}:model`]} />}
              </li>
            );
          })}
          {profiles.data?.length === 0 && <li className="muted">还没有绑定的执行器。上方检测 CLI 或创建 API 执行器后，会出现在这里。</li>}
        </ul>
      </Card>

      <Card title="接入其他 CLI" className="section">
        <p className="muted">参数每行一项，只支持整项占位符：{'{prompt}'}、{'{cwd}'}、{'{taskId}'}、{'{sessionId}'}。Muster 使用参数数组启动，不经过 shell。</p>
        <div className="settings-field-grid">
          <Field label="档案名称"><Input value={customName} onChange={(e) => setCustomName(e.target.value)} /></Field>
          <Field label="可执行文件绝对路径"><Input value={customPath} onChange={(e) => setCustomPath(e.target.value)} placeholder="/usr/local/bin/my-agent" /></Field>
          <Field label="参数模板（每行一项）"><textarea value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} /></Field>
        </div>
        <Button onClick={() => createCustom.mutate()} disabled={!customPath.trim()} loading={createCustom.isPending}>创建自定义执行器</Button>
      </Card>

      <Card title="如何连接（接入流程）" className="section">
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
  return (
    <div className="diagnostic-text" aria-live="polite">
      <span>{value.kind === 'model' ? '指定模型' : '基础联通'}：</span>
      <StateBadge domain="probe" state={value.status} />
      {value.model && <span> {value.model}</span>}
      {value.classification && <><br />{probeClassificationLabel(value.classification)}{value.stderr ? `：${value.stderr}` : ''}</>}
      {value.completedAt && <><br /><span className="muted">{new Date(value.completedAt).toLocaleString()} · {value.durationMs}ms</span></>}
    </div>
  );
}
