import type React from 'react';
import { useState, useEffect } from 'react';
import { useSystemSettings, useSaveSystemSettings, useTestConnection } from '../hooks/queries';
import { Card } from '../components/Card';
import { Button, toast } from '../components/Button';
import { Input, Field, Select } from '../components/Form';
import { Badge } from '../components/Badge';

export function SettingsPage(): React.ReactElement {
  const { data: settings, isLoading } = useSystemSettings();
  const saveSettings = useSaveSystemSettings();
  const testConnection = useTestConnection();

  // 表单状态
  const [claudeBin, setClaudeBin] = useState('');
  const [model, setModel] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(600000);
  const [maxToolCalls, setMaxToolCalls] = useState(30);
  // Batch 14：多执行器配置
  const [defaultProvider, setDefaultProvider] = useState('claude-cli');
  const [openaiBaseURL, setOpenaiBaseURL] = useState('https://api.openai.com/v1');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash');

  // 测试结果状态
  const [testResult, setTestResult] = useState<any | null>(null);

  // 数据加载后初始化表单
  useEffect(() => {
    if (settings) {
      setClaudeBin(settings.claudeBin);
      setModel(settings.model ?? '');
      setSkipPermissions(settings.skipPermissions);
      setTimeoutMs(settings.timeoutMs);
      setMaxToolCalls(settings.maxToolCalls);
      setDefaultProvider(settings.defaultProvider ?? 'claude-cli');
      setOpenaiBaseURL(settings.openaiBaseURL ?? 'https://api.openai.com/v1');
      setOpenaiModel(settings.openaiModel ?? 'gpt-4o');
      setGeminiModel(settings.geminiModel ?? 'gemini-2.0-flash');
    }
  }, [settings]);

  const handleSave = () => {
    if (!claudeBin.trim()) {
      toast('error', 'Claude 可执行文件路径不能为空');
      return;
    }

    saveSettings.mutate(
      {
        claudeBin,
        model,
        skipPermissions,
        timeoutMs,
        maxToolCalls,
        defaultProvider,
        openaiBaseURL,
        openaiModel,
        geminiModel,
      },
      {
        onSuccess: () => {
          toast('success', '系统设置已成功保存并实时生效！');
        },
        onError: (err: any) => {
          toast('error', err.message ?? '保存设置失败');
        },
      }
    );
  };

  const handleTest = () => {
    testConnection.mutate(
      { claudeBin, model },
      {
        onSuccess: (res) => {
          setTestResult(res);
          if (res.overallSuccess) {
            toast('success', '连通性与桥接联调完全正常，测试通过！');
          } else {
            toast('error', '测试未完全通过，请检查错误输出。');
          }
        },
        onError: (err: any) => {
          toast('error', err.message ?? '测试执行失败');
        },
      }
    );
  };

  if (isLoading) {
    return <div className="loading">加载系统设置中…</div>;
  }

  return (
    <div className="settings-page" style={{ maxWidth: '960px', margin: '0 auto', padding: 'var(--space-4)' }}>
      <header className="page-header" style={{ marginBottom: 'var(--space-5)' }}>
        <div>
          <h1>系统配置与连通性测试</h1>
          <p className="subtitle">管理 Claude Code CLI 运行时参数并验证本地大模型管道的桥接状态</p>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>
        {/* 左侧：表单配置 */}
        <Card title="运行时核心配置">
          <div className="form-stack">
            <Field label="Claude 可执行文件路径" required hint="系统通过此路径调用 Claude CLI。通常为 claude，或 Mac 本地绝对路径。">
              <Input
                value={claudeBin}
                onChange={(e) => setClaudeBin(e.target.value)}
                placeholder="例如: /Users/username/.local/bin/claude"
              />
            </Field>

            <Field label="模型标识" hint="可留空以使用 Claude Code 默认模型；代理服务请填写其实际支持的模型标识。">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="例如: sonnet 或代理服务提供的模型名"
              />
            </Field>

            <Field label="权限控制" hint="开启后，Agent 执行工具将跳过二次授权弹窗。开发或可信本地项目建议开启。">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '4px 0' }}>
                <input
                  type="checkbox"
                  checked={skipPermissions}
                  onChange={(e) => setSkipPermissions(e.target.checked)}
                />
                <span style={{ fontSize: 'var(--text-sm)' }}>跳过 Agent 权限确认 (MUSTER_SKIP_PERMISSIONS)</span>
              </label>
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <Field label="单次 Task 超时时长 (毫秒)" required hint="超时后强制终止 CLI 进程。">
                <Input
                  type="number"
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                />
              </Field>
              <Field label="单任务最大工具调用数" required hint="超出限制后强行终止以防止死循环。">
                <Input
                  type="number"
                  value={maxToolCalls}
                  onChange={(e) => setMaxToolCalls(Number(e.target.value))}
                />
              </Field>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
              <Button onClick={handleSave} loading={saveSettings.isPending}>
                保存当前设置
              </Button>
            </div>
          </div>
        </Card>

        {/* 右侧：测试控制与结果 */}
        <Card title="管道联调与测试">
          <div className="form-stack">
            <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
              实时模拟调用配置的 Claude Bin 可执行文件。分别验证“可执行文件存在性”与“大模型推理管道的桥接响应”。
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '4px' }}>
              <Button variant="ghost" onClick={handleTest} loading={testConnection.isPending}>
                运行连通性与桥接测试
              </Button>
            </div>

            {testResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
                {/* 阶段 1：连通性测试 */}
                <div style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px',
                  background: 'var(--bg-input)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>阶段 1：命令行可执行测试</strong>
                    <Badge tone={testResult.versionTest.success ? 'ok' : 'err'}>
                      {testResult.versionTest.success ? '通过' : '失败'}
                    </Badge>
                  </div>
                  <div className="muted" style={{ fontSize: 'var(--text-xs)', marginBottom: '4px' }}>
                    消耗时间: {testResult.versionTest.durationMs}ms
                  </div>
                  {testResult.versionTest.success ? (
                    <code style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all', display: 'block', background: 'var(--bg-soft)', padding: '6px', borderRadius: '4px' }}>
                      {testResult.versionTest.output}
                    </code>
                  ) : (
                    <pre style={{ fontSize: 'var(--text-xs)', color: 'var(--err)', background: 'rgba(239,68,68,0.05)', padding: '6px', borderRadius: '4px', margin: 0, whiteSpace: 'pre-wrap' }}>
                      {testResult.versionTest.error}
                    </pre>
                  )}
                </div>

                {/* 阶段 2：桥接测试 */}
                <div style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px',
                  background: 'var(--bg-input)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>阶段 2：大模型桥接推理测试</strong>
                    <Badge tone={testResult.bridgeTest.success ? 'ok' : 'err'}>
                      {testResult.bridgeTest.success ? '通过' : '未执行/失败'}
                    </Badge>
                  </div>
                  <div className="muted" style={{ fontSize: 'var(--text-xs)', marginBottom: '4px' }}>
                    消耗时间: {testResult.bridgeTest.durationMs}ms
                  </div>
                  {testResult.bridgeTest.success ? (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', background: 'var(--bg-soft)', padding: '6px', borderRadius: '4px' }}>
                      <strong>模型回答:</strong> {testResult.bridgeTest.output}
                    </div>
                  ) : (
                    <pre style={{ fontSize: 'var(--text-xs)', color: 'var(--err)', background: 'rgba(239,68,68,0.05)', padding: '6px', borderRadius: '4px', margin: 0, whiteSpace: 'pre-wrap' }}>
                      {testResult.bridgeTest.error || '因阶段 1 失败，跳过大模型桥接测试。'}
                    </pre>
                  )}
                </div>

                {/* 总体结论 */}
                <div style={{
                  textAlign: 'center',
                  fontWeight: 'bold',
                  padding: '10px',
                  borderRadius: 'var(--radius-md)',
                  background: testResult.overallSuccess ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                  color: testResult.overallSuccess ? 'var(--ok)' : 'var(--err)',
                  border: `1px solid ${testResult.overallSuccess ? 'var(--ok)' : 'var(--err)'}`,
                  fontSize: 'var(--text-sm)'
                }}>
                  {testResult.overallSuccess
                    ? '系统连通性与大模型桥接调试成功！'
                    : '管道连通或桥接校验失败，请检查路径或 API 密钥配置。'}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Batch 14：多执行器配置 */}
      <Card title="多执行器配置" style={{ marginTop: 'var(--space-5)' }}>
        <div className="form-stack">
          <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
            配置默认执行器与各 provider 的全局默认。每个员工可在员工编辑里覆盖。
            API Key 通过环境变量注入（OPENAI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY），不在此处填写。
          </p>
          <Field label="默认执行器" hint="新建员工未指定 provider 时使用">
            <Select value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)}>
              <option value="claude-cli">Claude Code CLI（默认）</option>
              <option value="openai">OpenAI 兼容（GPT/DeepSeek/通义/智谱）</option>
              <option value="gemini">Gemini</option>
            </Select>
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="OpenAI 默认 baseURL">
              <Input value={openaiBaseURL} onChange={(e) => setOpenaiBaseURL(e.target.value)} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label="OpenAI 默认模型">
              <Input value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} placeholder="gpt-4o" />
            </Field>
          </div>
          <Field label="Gemini 默认模型">
            <Input value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} placeholder="gemini-2.0-flash" />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleSave} loading={saveSettings.isPending}>保存执行器配置</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
