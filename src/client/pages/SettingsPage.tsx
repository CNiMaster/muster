import type React from 'react';
import { useEffect, useState } from 'react';
import { useSaveSystemSettings, useSystemSettings, useTestConnection, useTools, useSyncTools, useUpdateTool, useExecutorProfiles } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import { Link, useSearchParams } from 'react-router-dom';
import { ToolRegistryPanel } from '../components/settings/ToolRegistryPanel';
import { CredentialStorePanel } from '../components/settings/CredentialStorePanel';
import { BackupCenterPanel } from '../components/settings/BackupCenterPanel';
import { SetupChecklist } from '../components/settings/SetupChecklist';

export function SettingsPage(): React.ReactElement {
  const { data: settings, isLoading } = useSystemSettings();
  const saveSettings = useSaveSystemSettings();
  const testConnection = useTestConnection();
  const { data: executorProfiles } = useExecutorProfiles();
  // 注意：所有 hook（含 useSearchParams）必须在任何早期 return 之前调用，
  // 否则 React 会抛 "Rendered fewer hooks than expected"。
  const [searchParams] = useSearchParams();
  const focusTools = searchParams.get('view') === 'tools';
  const focusCredentials = searchParams.get('view') === 'credentials';
  const [claudeBin, setClaudeBin] = useState('');
  const [model, setModel] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(600000);
  const [maxToolCalls, setMaxToolCalls] = useState(30);
  const [defaultProvider, setDefaultProvider] = useState('claude-cli');
  const [openaiBaseURL, setOpenaiBaseURL] = useState('https://api.openai.com/v1');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash');
  const [tierPrimary, setTierPrimary] = useState('');
  const [tierSecondary, setTierSecondary] = useState('');
  const [tierTertiary, setTierTertiary] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyBypass, setProxyBypass] = useState('');
  const [caCertPath, setCaCertPath] = useState('');
  const [egressTimeoutMs, setEgressTimeoutMs] = useState(30000);
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('system');
  const [fontFamily, setFontFamily] = useState('');
  const [fontSize, setFontSize] = useState(14);
  const [locale, setLocale] = useState<'zh' | 'en'>('zh');
  const [codeTheme, setCodeTheme] = useState('default');
  const [autonomousReflectionEnabled, setAutonomousReflectionEnabled] = useState(false);
  const [autonomousReflectionBudgetUSD, setAutonomousReflectionBudgetUSD] = useState(0);
  const [morningReportEnabled, setMorningReportEnabled] = useState(true);
  const [testResult, setTestResult] = useState<any | null>(null);

  useEffect(() => {
    if (!settings) return;
    setClaudeBin(settings.claudeBin);
    setModel(settings.model ?? '');
    setSkipPermissions(settings.skipPermissions);
    setTimeoutMs(settings.timeoutMs);
    setMaxToolCalls(settings.maxToolCalls);
    setDefaultProvider(settings.defaultProvider ?? 'claude-cli');
    setOpenaiBaseURL(settings.openaiBaseURL ?? 'https://api.openai.com/v1');
    setOpenaiModel(settings.openaiModel ?? 'gpt-4o');
    setGeminiModel(settings.geminiModel ?? 'gemini-2.0-flash');
    setTierPrimary(settings.executorTierPrimaryId ?? '');
    setTierSecondary(settings.executorTierSecondaryId ?? '');
    setTierTertiary(settings.executorTierTertiaryId ?? '');
    setProxyUrl(settings.proxyUrl ?? '');
    setProxyBypass(settings.proxyBypass ?? '');
    setCaCertPath(settings.caCertPath ?? '');
    setEgressTimeoutMs(settings.egressTimeoutMs ?? 30000);
    setTheme(settings.theme ?? 'system');
    setFontFamily(settings.fontFamily ?? '');
    setFontSize(settings.fontSize ?? 14);
    setLocale(settings.locale ?? 'zh');
    setCodeTheme(settings.codeTheme ?? 'default');
    setAutonomousReflectionEnabled(settings.autonomousReflectionEnabled ?? false);
    setAutonomousReflectionBudgetUSD(settings.autonomousReflectionBudgetUSD ?? 0);
    setMorningReportEnabled(settings.morningReportEnabled ?? true);
  }, [settings]);

  const handleSave = (): void => {
    if (!claudeBin.trim()) {
      toast('error', 'Claude 可执行文件路径不能为空');
      return;
    }
    saveSettings.mutate(
      { claudeBin, model, skipPermissions, timeoutMs, maxToolCalls, defaultProvider, openaiBaseURL, openaiModel, geminiModel, executorTierPrimaryId: tierPrimary, executorTierSecondaryId: tierSecondary, executorTierTertiaryId: tierTertiary, proxyUrl, proxyBypass, caCertPath, egressTimeoutMs, theme, fontFamily, fontSize, locale, codeTheme, autonomousReflectionEnabled, autonomousReflectionBudgetUSD, morningReportEnabled },
      {
        onSuccess: () => toast('success', '系统设置已保存并实时生效'),
        onError: (error: any) => toast('error', error.message ?? '保存设置失败'),
      },
    );
  };

  const handleTest = (): void => {
    testConnection.mutate(
      { claudeBin, model },
      {
        onSuccess: (result) => {
          setTestResult(result);
          toast(result.overallSuccess ? 'success' : 'error', result.overallSuccess ? '连接测试通过' : '连接测试未通过');
        },
        onError: (error: any) => toast('error', error.message ?? '测试执行失败'),
      },
    );
  };

  if (isLoading) return <div className="loading">加载系统设置中…</div>;

  const providerLabels: Record<string, string> = {
    'claude-cli': 'Claude Code CLI',
    'codex-cli': 'Codex CLI',
    'antigravity-cli': 'Antigravity CLI',
    openai: 'OpenAI 兼容 API',
    gemini: 'Gemini API',
  };

  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h1>系统设置</h1>
          <p className="subtitle">先确认默认执行器可以连接；需要时再展开高级参数。</p>
        </div>
      </header>

      {/* 优化⑤：就绪清单——动态提示下一步配什么（全就绪自动隐藏） */}
      <SetupChecklist />

      <Card title="常用设置" actions={<Badge tone={testResult?.overallSuccess ? 'ok' : 'neutral'}>{testResult?.overallSuccess ? '连接正常' : '尚未测试'}</Badge>}>
        <div className="settings-basic-grid">
          <Field label="默认执行器" hint="员工没有单独指定执行器时使用">
            <Select value={defaultProvider} onChange={(event) => setDefaultProvider(event.target.value)}>
              <option value="claude-cli">Claude Code CLI</option>
              <option value="codex-cli">Codex CLI</option>
              <option value="antigravity-cli">Antigravity CLI</option>
              <option value="openai">OpenAI 兼容 API</option>
              <option value="gemini">Gemini API</option>
            </Select>
          </Field>
          <div className="connection-summary">
            <span className="muted">当前连接</span>
            <strong>{providerLabels[defaultProvider] ?? defaultProvider}</strong>
            <span className="muted">{testResult ? (testResult.overallSuccess ? '最近测试成功' : '最近测试失败') : '运行测试以确认配置'}</span>
          </div>
        </div>
        <div className="settings-primary-actions">
          <Button variant="ghost" onClick={handleTest} loading={testConnection.isPending}>运行连接测试</Button>
          <Button onClick={handleSave} loading={saveSettings.isPending}>保存设置</Button>
        </div>
        {testResult && <TestResultPanel result={testResult} />}
      </Card>

      <div className="settings-advanced section">
        {/* 改版 B3：配置中心——执行器/能力/权限的入口归位到设置页（去 hub-of-hubs 弹跳） */}
        <details className="details-collapse" open>
          <summary>配置中心（执行器 / 能力 / 权限）</summary>
          <div className="form-stack">
            <p className="muted">员工的运行环境、可用工具与审批规则都在这里配置；公司按员工绑定。</p>
            <div className="settings-primary-actions">
              <Link to="/executors">执行器接入中心</Link>
              <Link to="/capabilities">能力中心</Link>
              <Link to="/permissions">权限与审批中心</Link>
            </div>
          </div>
        </details>

        <details className="details-collapse">
          <summary>CLI 运行时</summary>
          <div className="form-stack">
            <Field label="Claude 可执行文件路径" required hint="通常填写 claude；也可以使用本地绝对路径。">
              <Input value={claudeBin} onChange={(event) => setClaudeBin(event.target.value)} placeholder="例如: /Users/username/.local/bin/claude" />
            </Field>
            <Field label="模型标识" hint="留空使用执行器默认模型">
              <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如: sonnet" />
            </Field>
          </div>
        </details>

        {/* 改版 B3：执行器分级从常用卡移入折叠区（power-user 项不再默认裸露） */}
        <details className="details-collapse">
          <summary>执行器分级（大活 / 标准 / 小活）</summary>
          <div className="form-stack">
            <div className="settings-tier-grid">
              <Field label="大活默认执行器" hint="复杂/需要命令执行的任务（未配置时自动降级）">
                <Select value={tierPrimary} onChange={(event) => setTierPrimary(event.target.value)}>
                  <option value="">未配置（继承默认执行器）</option>
                  {(executorProfiles ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}{profile.connection?.status === 'connected' ? ' ✓' : profile.connection ? ' ⚠' : ''}</option>
                  ))}
                </Select>
              </Field>
              <Field label="标准默认执行器" hint="普通任务">
                <Select value={tierSecondary} onChange={(event) => setTierSecondary(event.target.value)}>
                  <option value="">未配置（继承默认执行器）</option>
                  {(executorProfiles ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}{profile.connection?.status === 'connected' ? ' ✓' : profile.connection ? ' ⚠' : ''}</option>
                  ))}
                </Select>
              </Field>
              <Field label="小活默认执行器" hint="讨论/咨询/轻量任务（低成本模型）">
                <Select value={tierTertiary} onChange={(event) => setTierTertiary(event.target.value)}>
                  <option value="">未配置（继承默认执行器）</option>
                  {(executorProfiles ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}{profile.connection?.status === 'connected' ? ' ✓' : profile.connection ? ' ⚠' : ''}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </details>

        <details className="details-collapse">
          <summary>权限与运行限制</summary>
          <div className="form-stack">
            <p>权限现已按员工使用“审批策略 × 允许范围”配置。Turbo 也必须选择范围。</p>
            <div className="settings-field-grid">
              <Field label="单次 Task 超时（毫秒）">
                <Input type="number" value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} />
              </Field>
              <Field label="单任务最大工具调用数">
                <Input type="number" value={maxToolCalls} onChange={(event) => setMaxToolCalls(Number(event.target.value))} />
              </Field>
            </div>
          </div>
        </details>

        <details className="details-collapse">
          <summary>Provider 与 API 默认值</summary>
          <div className="form-stack">
            <p className="muted">API Key 只从环境变量读取，不在此处保存明文。多供应商/多模型档案请在「执行器接入中心」创建，此处仅作为快速入门默认值。</p>
            <div className="settings-field-grid">
              <Field label="OpenAI 默认 baseURL">
                <Input value={openaiBaseURL} onChange={(event) => setOpenaiBaseURL(event.target.value)} placeholder="https://api.openai.com/v1" />
              </Field>
              <Field label="OpenAI 默认模型">
                <Input value={openaiModel} onChange={(event) => setOpenaiModel(event.target.value)} placeholder="gpt-4o" />
              </Field>
            </div>
            <Field label="Gemini 默认模型">
              <Input value={geminiModel} onChange={(event) => setGeminiModel(event.target.value)} placeholder="gemini-2.0-flash" />
            </Field>
          </div>
        </details>

        <details className="details-collapse">
          <summary>网络（代理 / 证书）</summary>
          <div className="form-stack">
            <p className="muted">模型、MCP、命令工具与应用渲染层的出口流量将经此代理。留空时直连，不读取系统环境变量。修改后需重启应用生效。</p>
            <div className="settings-field-grid">
              <Field label="HTTP 代理" hint="留空直连，例如 http://127.0.0.1:7890">
                <Input value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="http://127.0.0.1:7890" />
              </Field>
              <Field label="代理例外" hint="匹配这些主机的请求将直连，不经过代理。逗号分隔，例如 localhost,127.0.0.1,.example.com">
                <Input value={proxyBypass} onChange={(event) => setProxyBypass(event.target.value)} placeholder="localhost,127.0.0.1,.example.com" />
              </Field>
              <Field label="自定义证书（PEM 路径）" hint="作为 NODE_EXTRA_CA_CERTS 注入模型、MCP 与命令工具，并用于渲染层证书校验">
                <Input value={caCertPath} onChange={(event) => setCaCertPath(event.target.value)} placeholder="/Users/name/certs/root-ca.pem" />
              </Field>
              <Field label="出口请求超时（毫秒）">
                <Input type="number" value={egressTimeoutMs} onChange={(event) => setEgressTimeoutMs(Number(event.target.value))} />
              </Field>
            </div>
            <p className="muted">⚠ 以上网络配置修改后需重启应用生效（不实时热更）。</p>
          </div>
        </details>

        <details className="details-collapse">
          <summary>外观（主题 / 字体 / 语言）</summary>
          <div className="form-stack">
            <div className="settings-field-grid">
              <Field label="主题">
                <Select value={theme} onChange={(event) => setTheme(event.target.value as 'dark' | 'light' | 'system')}>
                  <option value="system">跟随系统</option>
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </Select>
              </Field>
              <Field label="界面语言">
                <Select value={locale} onChange={(event) => setLocale(event.target.value as 'zh' | 'en')}>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </Select>
              </Field>
              <Field label="界面字体" hint="留空使用默认字体">
                <Input value={fontFamily} onChange={(event) => setFontFamily(event.target.value)} placeholder="例如: Avenir Next, PingFang SC" />
              </Field>
              <Field label="主文本字号（px）">
                <Input type="number" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
              </Field>
              <Field label="代码块主题" hint="default / dark 等（简单映射）">
                <Select value={codeTheme} onChange={(event) => setCodeTheme(event.target.value)}>
                  <option value="default">default</option>
                  <option value="dark">dark</option>
                </Select>
              </Field>
            </div>
            <p className="muted">外观修改即时生效（主题/字体/字号/语言）。</p>
          </div>
        </details>

        <details className="details-collapse">
          <summary>定时与自动化</summary>
          <div className="form-stack">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={morningReportEnabled}
                onChange={(event) => setMorningReportEnabled(event.target.checked)}
              />
              晨醒：每天自动生成运营优化报告（进化与报告页）
            </label>
            <p className="muted">
              关闭后不再每日自动扫描生成优化建议；各项目/公司自己配置的定时工作不受影响。
            </p>
          </div>
        </details>

        <details className="details-collapse">
          <summary>自主进化（空闲反思）</summary>
          <div className="form-stack">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autonomousReflectionEnabled}
                onChange={(event) => setAutonomousReflectionEnabled(event.target.checked)}
              />
              公司空闲时自动补做任务反思（沉淀经验进记忆）
            </label>
            <Field label="每日自主反思预算（USD）" hint="公司当日总花费低于该值时才允许自动反思；0 = 关闭">
              <Input
                type="number"
                min={0}
                step={0.1}
                value={autonomousReflectionBudgetUSD}
                onChange={(event) => setAutonomousReflectionBudgetUSD(Number(event.target.value))}
              />
            </Field>
            <p className="muted">
              默认关闭（反思有 LLM 成本）。开启后：公司在线且无活跃任务时，对近期已完成/失败但未反思过的任务补排队反思；
              正式任务到达自动让位，单次最多补 2 条。
            </p>
          </div>
        </details>

        <ToolRegistryPanel defaultOpen={focusTools} />
        <CredentialStorePanel defaultOpen={focusCredentials} />
      </div>

      <BackupCenterPanel className="section" />
    </div>
  );
}

function TestResultPanel({ result }: { result: any }): React.ReactElement {
  return (
    <div className="test-result-stack diagnostic-text">
      <div className="test-result-box">
        <div className="test-result-head">
          <strong className="test-result-stage">命令行连接</strong>
          <Badge tone={result.versionTest.success ? 'ok' : 'err'}>{result.versionTest.success ? '通过' : '失败'}</Badge>
        </div>
        {result.versionTest.success
          ? <code className="test-result-code">{result.versionTest.output}</code>
          : <pre className="test-result-err">{result.versionTest.error}</pre>}
      </div>
      <div className="test-result-box">
        <div className="test-result-head">
          <strong className="test-result-stage">模型桥接</strong>
          <Badge tone={result.bridgeTest.success ? 'ok' : 'err'}>{result.bridgeTest.success ? '通过' : '未通过'}</Badge>
        </div>
        {result.bridgeTest.success
          ? <div className="test-result-out">{result.bridgeTest.output}</div>
          : <pre className="test-result-err">{result.bridgeTest.error || '命令行连接失败，未运行桥接测试。'}</pre>}
      </div>
    </div>
  );
}
