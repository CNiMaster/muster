import type React from 'react';
import { useEffect, useState } from 'react';
import { useSaveSystemSettings, useSystemSettings, useTestConnection, useTools, useSyncTools, useUpdateTool } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import { Link, useSearchParams } from 'react-router-dom';
import { ToolRegistryPanel } from '../components/settings/ToolRegistryPanel';
import { CredentialStorePanel } from '../components/settings/CredentialStorePanel';

export function SettingsPage(): React.ReactElement {
  const { data: settings, isLoading } = useSystemSettings();
  const saveSettings = useSaveSystemSettings();
  const testConnection = useTestConnection();
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
  }, [settings]);

  const handleSave = (): void => {
    if (!claudeBin.trim()) {
      toast('error', 'Claude 可执行文件路径不能为空');
      return;
    }
    saveSettings.mutate(
      { claudeBin, model, skipPermissions, timeoutMs, maxToolCalls, defaultProvider, openaiBaseURL, openaiModel, geminiModel },
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
    'gemini-cli': 'Gemini CLI',
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

      <Card title="常用设置" actions={<Badge tone={testResult?.overallSuccess ? 'ok' : 'neutral'}>{testResult?.overallSuccess ? '连接正常' : '尚未测试'}</Badge>}>
        <div className="settings-basic-grid">
          <Field label="默认执行器" hint="员工没有单独指定执行器时使用">
            <Select value={defaultProvider} onChange={(event) => setDefaultProvider(event.target.value)}>
              <option value="claude-cli">Claude Code CLI</option>
              <option value="codex-cli">Codex CLI</option>
              <option value="gemini-cli">Gemini CLI</option>
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

        <details className="details-collapse">
          <summary>权限与运行限制</summary>
          <div className="form-stack">
            <p>权限现已按员工使用“审批策略 × 允许范围”配置。Turbo 也必须选择范围。</p>
            <div className="settings-primary-actions"><Link to="/permissions">打开权限与审批中心</Link><Link to="/executors">打开执行器接入中心</Link></div>
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
            <p className="muted">API Key 只从环境变量读取，不在此处保存明文。</p>
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

        <ToolRegistryPanel defaultOpen={focusTools} />
        <CredentialStorePanel defaultOpen={focusCredentials} />
      </div>
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
