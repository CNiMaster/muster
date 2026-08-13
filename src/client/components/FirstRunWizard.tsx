/**
 * 首次启动引导（First-Run Setup Wizard）。
 *
 * 4 步：
 *   1. 程序目录：选路径或默认 ~/MusterWorkspace。空目录直接用；非空自动嵌套 MusterWorkspace 子文件夹。
 *   2. CLI 接入：一键检测本机已装的 CLI → 多选「绑定并测试」；可跳过，之后在「执行器中心」配置。
 *   3. API 接入：填表单创建 API 执行器 + 测试；可跳过，之后随时可配。
 *   4. 完成：进入工作台。
 *
 * 显示条件：服务端 setup_wizard_done 未标记 且 尚无公司。完成后不再弹出。
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge } from './Badge';
import { Button, toast } from './Button';
import { Field, Input, Select } from './Form';

interface SetupStatus {
  done: boolean;
  hasWorkspace: boolean;
  currentWorkspace: { id: string; rootDir: string } | null;
  suggested: { defaultDir: string; exists: boolean; isEmpty: boolean };
}

interface CliDetected {
  manifestId: string;
  displayName: string;
  found: boolean;
  path: string | null;
  version: string | null;
}

interface ExecutorProfile {
  id: string;
  name: string;
  manifestId: string;
}

interface ExecutorProbe {
  id: string;
  kind: string;
  status: 'queued' | 'testing' | 'ok' | 'failed';
  classification: string | null;
  stderr: string;
}

/** CLI 绑定进度：pending=未选 / binding=绑定中 / bound=已绑定 / failed=失败 */
type CliBindState = 'pending' | 'binding' | 'bound' | 'failed';

const STEP_LABELS = ['程序目录', '接入 CLI', '接入 API', '完成'];

export function FirstRunWizard(): React.ReactNode {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState(0);
  const [customDir, setCustomDir] = useState('');
  const [dirInfo, setDirInfo] = useState<{ rootDir: string; nested: boolean } | null>(null);

  // 步骤 2：CLI 多选 + 绑定状态
  const [detections, setDetections] = useState<CliDetected[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [selectedCli, setSelectedCli] = useState<Set<string>>(new Set());
  const [cliStates, setCliStates] = useState<Record<string, CliBindState>>({});
  const [cliProbes, setCliProbes] = useState<Record<string, string>>({});

  // 步骤 3：API 表单 + 测试
  const [apiKind, setApiKind] = useState<'openai-compatible-api' | 'gemini-api'>('openai-compatible-api');
  const [apiBaseURL, setApiBaseURL] = useState('https://api.openai.com/v1');
  const [apiModel, setApiModel] = useState('gpt-4o');
  const [apiKeyEnv, setApiKeyEnv] = useState('OPENAI_API_KEY');
  const [apiProfileId, setApiProfileId] = useState<string | null>(null);
  const [apiCreating, setApiCreating] = useState(false);
  const [apiTesting, setApiTesting] = useState(false);
  const [apiProbe, setApiProbe] = useState<ExecutorProbe | null>(null);

  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    void api.get<SetupStatus>('/api/setup/status').then(setStatus).catch(() => setStatus(null));
  }, []);

  // 未完成引导才渲染
  if (!status || status.done) return null;

  /** 步骤 1：设定程序目录。 */
  const handleSetDir = async (dir?: string): Promise<void> => {
    try {
      const r = await api.post<{ rootDir: string; nested: boolean }>('/api/setup/workspace', { rootDir: dir });
      setDirInfo(r);
      toast('success', r.nested ? `已创建子文件夹 ${r.rootDir}` : `已使用 ${r.rootDir}`);
    } catch (e) {
      toast('error', (e as Error).message ?? '设置目录失败');
    }
  };

  /** 步骤 2：一键检测 CLI，重置选择与绑定状态。 */
  const handleDetect = async (): Promise<void> => {
    setDetecting(true);
    try {
      const r = await api.post<CliDetected[]>('/api/executors/detect-all');
      setDetections(r);
      setSelectedCli(new Set(r.filter((d) => d.found).map((d) => d.manifestId)));
      setCliStates({});
      setCliProbes({});
    } catch (e) {
      toast('error', (e as Error).message ?? '检测失败');
    } finally {
      setDetecting(false);
    }
  };

  const toggleCli = (manifestId: string): void => {
    setSelectedCli((old) => {
      const next = new Set(old);
      if (next.has(manifestId)) next.delete(manifestId); else next.add(manifestId);
      return next;
    });
  };

  /** 步骤 2：绑定并测试所选 CLI（bind 后手动触发连通探针，拿到 probe id 轮询状态）。 */
  const handleBindSelected = async (): Promise<void> => {
    const targets = (detections ?? []).filter((d) => selectedCli.has(d.manifestId) && d.found);
    if (targets.length === 0) return;
    for (const cli of targets) {
      setCliStates((old) => ({ ...old, [cli.manifestId]: 'binding' }));
      try {
        const profile = await api.post<ExecutorProfile>(`/api/executors/${cli.manifestId}/bind-system`);
        // 手动触发一次连通探针（force=true），拿到 probe id 供轮询展示
        const probe = await api.post<ExecutorProbe>(`/api/executors/profiles/${profile.id}/probes`, { force: true, kind: 'connectivity' });
        setCliStates((old) => ({ ...old, [cli.manifestId]: 'bound' }));
        setCliProbes((old) => ({ ...old, [cli.manifestId]: probe.id }));
        toast('success', `已绑定并测试 ${cli.displayName}`);
      } catch (e) {
        setCliStates((old) => ({ ...old, [cli.manifestId]: 'failed' }));
        toast('error', `${cli.displayName} 绑定失败：${(e as Error).message}`);
      }
    }
  };

  /** 步骤 3：创建 API 执行器。 */
  const handleCreateApi = async (): Promise<void> => {
    if (!apiKeyEnv.trim()) {
      toast('info', '请填写 API Key 环境变量名（如 OPENAI_API_KEY）');
      return;
    }
    setApiCreating(true);
    try {
      const profile = await api.post<ExecutorProfile>('/api/executors/profiles', {
        name: apiKind === 'openai-compatible-api' ? 'OpenAI 兼容 API' : 'Gemini API',
        manifestId: apiKind,
        config: apiKind === 'openai-compatible-api'
          ? { provider: 'openai', baseURL: apiBaseURL.trim(), model: apiModel.trim() }
          : { provider: 'gemini', model: apiModel.trim() },
        credentialRef: { kind: 'env', reference: apiKeyEnv.trim() },
        concurrencyMode: 'profile-serial',
      });
      setApiProfileId(profile.id);
      toast('success', 'API 执行器已创建');
    } catch (e) {
      toast('error', (e as Error).message ?? '创建失败');
    } finally {
      setApiCreating(false);
    }
  };

  /** 步骤 3：测试 API 连接（连通性 + 模型）。 */
  const handleTestApi = async (): Promise<void> => {
    if (!apiProfileId) {
      toast('info', '请先创建 API 执行器再测试');
      return;
    }
    setApiTesting(true);
    try {
      const probe = await api.post<ExecutorProbe>(`/api/executors/profiles/${apiProfileId}/probes`, { force: true, kind: 'connectivity' });
      setApiProbe(probe);
      toast('success', '测试已启动，稍候查看结果');
    } catch (e) {
      toast('error', (e as Error).message ?? '测试失败');
    } finally {
      setApiTesting(false);
    }
  };

  /** 步骤 4：完成引导。 */
  const handleFinish = async (): Promise<void> => {
    setFinishing(true);
    try {
      await api.post('/api/setup/complete');
      window.location.reload();
    } catch (e) {
      toast('error', (e as Error).message ?? '完成失败');
      setFinishing(false);
    }
  };

  const defaultDir = status.suggested.defaultDir;
  const defaultInfo = status.suggested.exists
    ? (status.suggested.isEmpty ? `目录已存在且为空，将直接使用` : `目录已存在且有内容，将自动嵌套 ${defaultDir.split('/').pop()} 子文件夹`)
    : `目录不存在，将自动创建`;

  return (
    <div className="first-run-wizard">
      <div className="first-run-card">
        <header className="first-run-head">
          <span className="first-run-kicker">MUSTER · 首次启动</span>
          <h1>欢迎使用 Muster</h1>
          <p className="muted">先完成几个简单设置，就能开始组建你的 Agent 公司。</p>
        </header>

        <ol className="first-run-steps" aria-label="引导步骤">
          {STEP_LABELS.map((label, i) => (
            <li key={label} className={i === step ? 'is-active' : i < step ? 'is-done' : ''}>
              <span>{i + 1}</span>{label}
            </li>
          ))}
        </ol>

        <div className="first-run-body">
          {/* 步骤 1：程序目录 */}
          {step === 0 && (
            <div className="form-stack">
              <h2>1. 程序目录</h2>
              <p className="muted">你的公司文件（项目、产物、工作记录）存放在哪里？</p>
              <div className="first-run-option">
                <strong>使用推荐位置</strong>
                <code>{defaultDir}</code>
                <p className="muted" style={{ fontSize: 12 }}>{defaultInfo}</p>
                <Button onClick={() => void handleSetDir()} disabled={Boolean(dirInfo)}>使用此目录</Button>
              </div>
              <div className="first-run-option">
                <strong>自定义位置</strong>
                <p className="muted" style={{ fontSize: 12 }}>
                  输入一个文件夹路径。若该文件夹为空或不存在，Muster 直接用它存放公司文件；
                  若已有其他文件，Muster 会在其中新建 <code>MusterWorkspace</code> 子文件夹，不打扰你的现有内容。
                </p>
                <div className="settings-field-grid">
                  <input
                    className="mu-input"
                    value={customDir}
                    onChange={(e) => setCustomDir(e.target.value)}
                    placeholder="例如 /Users/you/MyCompanyFiles"
                  />
                </div>
                <Button onClick={() => void handleSetDir(customDir)} disabled={!customDir.trim() || Boolean(dirInfo)}>
                  使用此目录
                </Button>
              </div>
              {dirInfo && <p className="first-run-ok">✓ 目录已就绪：<code>{dirInfo.rootDir}</code></p>}
            </div>
          )}

          {/* 步骤 2：CLI 接入（检测 → 多选 → 绑定并测试，可跳过） */}
          {step === 1 && (
            <div className="form-stack">
              <h2>2. 接入 CLI</h2>
              <p className="muted">Muster 通过本机安装的 AI CLI（Claude Code / Codex 等）执行任务。检测后勾选要绑定的 CLI，绑定会自动测试连通性；可跳过，之后在「执行器中心」配置。</p>
              <div className="settings-primary-actions">
                <Button onClick={() => void handleDetect()} loading={detecting}>
                  {detecting ? '检测中…' : '一键检测'}
                </Button>
              </div>
              {detections && (
                <>
                  <ul className="entity-list">
                    {detections.map((d) => {
                      const bindState = cliStates[d.manifestId] ?? 'pending';
                      return (
                        <li key={d.manifestId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                            <input
                              type="checkbox"
                              disabled={!d.found || bindState === 'bound' || bindState === 'binding'}
                              checked={selectedCli.has(d.manifestId)}
                              onChange={() => toggleCli(d.manifestId)}
                            />
                            <span>
                              <strong>{d.displayName}</strong>
                              {d.found ? <span className="muted"> · {d.version}</span> : null}
                            </span>
                          </label>
                          {!d.found
                            ? <span className="muted">未检测到</span>
                            : bindState === 'bound'
                              ? <ProbeStatus probeId={cliProbes[d.manifestId]} />
                              : bindState === 'binding'
                                ? <span className="muted">绑定中…</span>
                                : bindState === 'failed'
                                  ? <Badge tone="err">绑定失败</Badge>
                                  : <span className="muted">已安装</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="settings-primary-actions">
                    <Button onClick={() => void handleBindSelected()} disabled={selectedCli.size === 0 || Object.values(cliStates).some((s) => s === 'binding')}>
                      绑定并测试所选（{selectedCli.size}）
                    </Button>
                  </div>
                  {detections.some((d) => !d.found) && (
                    <p className="muted" style={{ fontSize: 12 }}>
                      未检测到的 CLI 可在「执行器中心」一键安装（官方方式）。这里可以先跳过。
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* 步骤 3：API 接入（表单 + 测试，可跳过） */}
          {step === 2 && (
            <div className="form-stack">
              <h2>3. 接入 API（可选）</h2>
              <p className="muted">也可以用 OpenAI 兼容 / Gemini API 作为执行器。密钥只从环境变量读取，Muster 不保存明文。可跳过，之后在「执行器中心」随时配置。</p>
              <div className="form-row">
                <Field label="类型">
                  <Select value={apiKind} onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value as typeof apiKind;
                    setApiKind(v);
                    if (v === 'openai-compatible-api') { setApiBaseURL('https://api.openai.com/v1'); setApiModel('gpt-4o'); setApiKeyEnv('OPENAI_API_KEY'); }
                    else { setApiModel('gemini-2.0-flash'); setApiKeyEnv('GEMINI_API_KEY'); }
                  }}>
                    <option value="openai-compatible-api">OpenAI 兼容 API</option>
                    <option value="gemini-api">Gemini API</option>
                  </Select>
                </Field>
                {apiKind === 'openai-compatible-api' && (
                  <Field label="Base URL"><Input value={apiBaseURL} onChange={(e) => setApiBaseURL(e.target.value)} placeholder="https://api.openai.com/v1" /></Field>
                )}
              </div>
              <div className="form-row">
                <Field label="默认模型"><Input value={apiModel} onChange={(e) => setApiModel(e.target.value)} placeholder={apiKind === 'openai-compatible-api' ? 'gpt-4o' : 'gemini-2.0-flash'} /></Field>
                <Field label="API Key 环境变量名" hint="密钥从环境变量读取，不存明文">
                  <Input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder={apiKind === 'openai-compatible-api' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} />
                </Field>
              </div>
              <div className="settings-primary-actions">
                <Button onClick={() => void handleCreateApi()} loading={apiCreating} disabled={!apiKeyEnv.trim()}>创建执行器</Button>
                <Button variant="ghost" onClick={() => void handleTestApi()} loading={apiTesting} disabled={!apiProfileId}>测试连接</Button>
              </div>
              {apiProbe && <p><ProbeStatus probeId={apiProbe.id} /></p>}
            </div>
          )}

          {/* 步骤 4：完成 */}
          {step === 3 && (
            <div className="form-stack">
              <h2>4. 完成</h2>
              <p className="muted">设置已就绪。接下来可以：</p>
              <ul className="first-run-todo">
                <li>创建你的第一家公司（从团队蓝图开始）</li>
                <li>或先浏览员工库，看看可用的员工档案</li>
                <li>随时回「设置」调整目录、CLI 与 API</li>
              </ul>
              <div className="settings-primary-actions">
                <Button onClick={() => void handleFinish()} loading={finishing}>进入工作台</Button>
              </div>
            </div>
          )}
        </div>

        <footer className="first-run-foot">
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>上一步</Button>
          <Button
            onClick={() => setStep((s) => Math.min(3, s + 1))}
            disabled={step === 0 && !dirInfo}
            variant={step === 3 ? 'primary' : 'ghost'}
          >
            {step === 3 ? '完成' : '下一步'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/** 探针状态：按 probe id 轮询直到完成（queued/testing 时每 500ms 刷新）。 */
function ProbeStatus({ probeId }: { probeId?: string }): React.ReactElement | null {
  const [probe, setProbe] = useState<ExecutorProbe | null>(null);
  useEffect(() => {
    if (!probeId) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const p = await api.get<ExecutorProbe>(`/api/executors/probes/${probeId}`);
        if (cancelled) return;
        setProbe(p);
        if (p.status === 'queued' || p.status === 'testing') {
          setTimeout(() => void poll(), 500);
        }
      } catch {
        // 查询失败停止轮询
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [probeId]);

  if (!probe) return null;
  if (probe.status === 'ok') return <span className="first-run-ok">✓ 连通正常</span>;
  if (probe.status === 'failed') return <Badge tone="err">连通失败{probe.stderr ? `：${probe.stderr.slice(0, 80)}` : ''}</Badge>;
  return <span className="muted">测试中…</span>;
}
