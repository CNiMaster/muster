import { useEffect, useState } from 'react';
import type React from 'react';
import { useHealthStatus, useSaveSystemSettings, useSystemSettings, useTestConnection, useExecutorProfiles } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import { Link, useSearchParams } from 'react-router-dom';
import { ToolRegistryPanel } from '../components/settings/ToolRegistryPanel';
import { CredentialStorePanel } from '../components/settings/CredentialStorePanel';
import { BackupCenterPanel } from '../components/settings/BackupCenterPanel';

type SettingsTab = 'general' | 'models' | 'swarm' | 'network' | 'appearance' | 'credentials' | 'tools' | 'backup';

export function SettingsPage(): React.ReactElement {
  const { data: settings, isLoading } = useSystemSettings();
  const saveSettings = useSaveSystemSettings();
  const testConnection = useTestConnection();
  const { data: executorProfiles = [] } = useExecutorProfiles();
  const health = useHealthStatus();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = (searchParams.get('tab') as SettingsTab) || 'general';
  const setTab = (t: SettingsTab): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next);
  };

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
  // 执行器池统一（2026-08-17）：档位 = 执行器档案 id（高/标准/低，CLI+API 一个选择框）
  const [tierHigh, setTierHigh] = useState('');
  const [tierStandard, setTierStandard] = useState('');
  const [tierLow, setTierLow] = useState('');
  const [imageGenModel, setImageGenModel] = useState('');
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
  const [swarmMaxDepth, setSwarmMaxDepth] = useState(3);
  const [swarmMaxWidth, setSwarmMaxWidth] = useState(5);
  const [swarmMaxNodes, setSwarmMaxNodes] = useState(30);
  const [swarmBudgetUSD, setSwarmBudgetUSD] = useState(5);
  const [swarmRepairMax, setSwarmRepairMax] = useState(10);
  const [breadthDefaultTier, setBreadthDefaultTier] = useState<'light' | 'standard' | 'heavy'>('standard');
  // 批次 F.4：waiting_input 超时自动继续分钟数（0=一直等，默认）
  const [waitingAutoContinue, setWaitingAutoContinue] = useState(0);
  // 批次 G.5：防休眠三态（active=有活跃任务时保活，默认；always=常驻；off）
  const [preventSleep, setPreventSleep] = useState<'active' | 'always' | 'off'>('active');
  // 批次 H.5：运行中发送行为（queue=排队等本轮结束，默认；interrupt=打断插话）
  const [interruptMode, setInterruptMode] = useState<'queue' | 'interrupt'>('queue');
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
    setTierHigh(settings.executorTierHighId ?? (settings.executorTierPrimaryId ?? ''));
    setTierStandard(settings.executorTierStandardId ?? (settings.executorTierSecondaryId ?? ''));
    setTierLow(settings.executorTierLowId ?? (settings.executorTierTertiaryId ?? ''));
    setImageGenModel(settings.imageGenModel ?? '');
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
    setSwarmMaxDepth(settings.swarmMaxDepth ?? 3);
    setSwarmMaxWidth(settings.swarmMaxWidth ?? 5);
    setSwarmMaxNodes(settings.swarmMaxNodes ?? 30);
    setSwarmBudgetUSD(settings.swarmBudgetUSD ?? 5);
    setSwarmRepairMax(settings.swarmRepairMax ?? 10);
    setBreadthDefaultTier(settings.breadthDefaultTier ?? 'standard');
    setWaitingAutoContinue(settings.waitingAutoContinueMinutes ?? 0);
    setPreventSleep(settings.preventSleep ?? 'active');
    setInterruptMode(settings.interruptMode ?? 'queue');
  }, [settings]);

  const handleSave = (): void => {
    if (!claudeBin.trim()) {
      toast('error', 'Claude 可执行文件路径不能为空');
      return;
    }
    saveSettings.mutate(
      { claudeBin, model, skipPermissions, timeoutMs, maxToolCalls, defaultProvider, openaiBaseURL, openaiModel, geminiModel, executorTierPrimaryId: tierPrimary, executorTierSecondaryId: tierSecondary, executorTierTertiaryId: tierTertiary, executorTierHighId: tierHigh, executorTierStandardId: tierStandard, executorTierLowId: tierLow, imageGenModel, proxyUrl, proxyBypass, caCertPath, egressTimeoutMs, theme, fontFamily, fontSize, locale, codeTheme, autonomousReflectionEnabled, autonomousReflectionBudgetUSD, swarmMaxDepth, swarmMaxWidth, swarmMaxNodes, swarmBudgetUSD, swarmRepairMax, breadthDefaultTier, waitingAutoContinueMinutes: waitingAutoContinue, preventSleep, interruptMode },
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

  return (
    <div className="settings-page" style={{ maxWidth: '1100px', margin: '0 auto', padding: '16px 0' }}>
      <header className="page-header" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Link to="/" className="back-link" style={{ fontSize: '13px' }}>← 返回工作台</Link>
          <h1 style={{ margin: 0, fontSize: '22px' }}>系统设置</h1>
        </div>
        <div className="page-actions">
          <Button variant="ghost" size="sm" onClick={handleTest} loading={testConnection.isPending}>测试连接</Button>
          <Button size="sm" onClick={handleSave} loading={saveSettings.isPending}>保存修改</Button>
        </div>
      </header>

      <div className="settings-split">
        {/* 左侧分类导航 */}
        <nav className="settings-nav" aria-label="设置分组导航">
          {/* 批次 G.6：两层导航——常用三卡日常高频；高级五卡低频专业 */}
          <div className="settings-nav-group-label">常用</div>
          <button type="button" className={`settings-nav-item ${activeTab === 'general' ? 'is-active' : ''}`} onClick={() => setTab('general')}>
            <span>⚙️ 常规与执行器</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'appearance' ? 'is-active' : ''}`} onClick={() => setTab('appearance')}>
            <span>🎨 外观与主题</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'backup' ? 'is-active' : ''}`} onClick={() => setTab('backup')}>
            <span>💾 数据库与备份</span>
          </button>
          <div className="settings-nav-group-label">高级</div>
          <button type="button" className={`settings-nav-item ${activeTab === 'models' ? 'is-active' : ''}`} onClick={() => setTab('models')}>
            <span>🧠 模型与分级</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'swarm' ? 'is-active' : ''}`} onClick={() => setTab('swarm')}>
            <span>🐝 蜂群调度与反思</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'network' ? 'is-active' : ''}`} onClick={() => setTab('network')}>
            <span>🌐 网络与出站代理</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'credentials' ? 'is-active' : ''}`} onClick={() => setTab('credentials')}>
            <span>🔑 凭据金库</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'tools' ? 'is-active' : ''}`} onClick={() => setTab('tools')}>
            <span>🔧 工具与 MCP 注册</span>
          </button>
        </nav>

        {/* 右侧配置面板 */}
        <div className="settings-content-panel">
          {activeTab === 'general' && (
            <Card title="常规执行环境">
              <div className="form-stack">
                <Field label="默认执行引擎">
                  <Select value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)}>
                    <option value="claude-cli">Claude Code CLI</option>
                    <option value="codex-cli">Codex CLI</option>
                    <option value="antigravity-cli">Antigravity CLI</option>
                    <option value="openai">OpenAI 兼容 API</option>
                    <option value="gemini">Gemini API</option>
                  </Select>
                </Field>
                <Field label="Claude CLI 可执行路径" hint="系统检测或本地绝对路径">
                  <Input value={claudeBin} onChange={(e) => setClaudeBin(e.target.value)} />
                </Field>
                <Field label="显式模型标识 (留空使用默认)">
                  <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="留空使用执行器默认模型" />
                </Field>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                    <input type="checkbox" checked={skipPermissions} onChange={(e) => setSkipPermissions(e.target.checked)} />
                    <span>允许跳过 CLI 权限拦截 (--dangerously-skip-permissions)</span>
                  </label>
                </div>
                <Field label="运行中发送" hint="任务执行中你继续输入时的行为：排队等本轮结束自动送出（默认），或立即打断插话（任务回队列让位重跑）">
                  <Select value={interruptMode} onChange={(e) => setInterruptMode(e.target.value as 'queue' | 'interrupt')}>
                    <option value="queue">排队（本轮结束后送出）</option>
                    <option value="interrupt">插话（立即打断）</option>
                  </Select>
                </Field>
                <Field label="防休眠" hint="系统睡眠会让任务停摆、局域网连接断开。仅 macOS 生效（内建 caffeinate），其他平台随桌面版支持">
                  <Select value={preventSleep} onChange={(e) => setPreventSleep(e.target.value as 'active' | 'always' | 'off')}>
                    <option value="active">有任务在跑时保活（默认）</option>
                    <option value="always">常驻保活</option>
                    <option value="off">关闭</option>
                  </Select>
                </Field>
                <Field label="提问超时自动继续（分钟）" hint="任务提问后倒计时，到期未答复自动以「确认，请继续执行」续跑；0 = 一直等（默认）。等待卡上可按任务临时调整（重要 10 分钟 / 普通 5 分钟）">
                  <Input
                    type="number"
                    min={0}
                    max={1440}
                    value={waitingAutoContinue}
                    onChange={(e) => setWaitingAutoContinue(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
                  />
                </Field>
              </div>
            </Card>
          )}

          {activeTab === 'models' && (
            <Card title="模型参数与执行器分级">
              <div className="form-stack">
                <Field label="OpenAI API Base URL">
                  <Input value={openaiBaseURL} onChange={(e) => setOpenaiBaseURL(e.target.value)} />
                </Field>
                <Field label="OpenAI 模型名">
                  <Input value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} />
                </Field>
                <Field label="Gemini 模型名">
                  <Input value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} />
                </Field>
              </div>
            </Card>
          )}

          {activeTab === 'models' && (
            <Card title="执行器档位（成本-能力匹配，一个选择框选 CLI/API）">
              <div className="form-stack">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                  <Field label="高级档（计划/验收/裁决/蜂群请示）">
                    <Select value={tierHigh} onChange={(e) => setTierHigh(e.target.value)}>
                      <option value="">跟随系统默认</option>
                      {executorProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.manifestId})</option>)}
                    </Select>
                  </Field>
                  <Field label="标准档（普通任务）">
                    <Select value={tierStandard} onChange={(e) => setTierStandard(e.target.value)}>
                      <option value="">跟随系统默认</option>
                      {executorProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.manifestId})</option>)}
                    </Select>
                  </Field>
                  <Field label="低档（蜂群工蜂/辩手/咨询）">
                    <Select value={tierLow} onChange={(e) => setTierLow(e.target.value)}>
                      <option value="">跟随系统默认</option>
                      {executorProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.manifestId})</option>)}
                    </Select>
                  </Field>
                </div>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--fg-muted, #888)' }}>
                  档位 = 执行器档案（CLI agent 产品或 LLM API 均可）；任务按档位自动选档案，故障自动换健康备选。
                  员工绑定优先于档位；消息/工作单显式选模型为单次例外。API 档案自带 model，CLI 档案走该 CLI。
                </p>
                <Field label="图像生成模型（image_generate 工具）">
                  <Input value={imageGenModel} placeholder="如 gpt-image-1 / 兼容端点的生图模型，留空默认 gpt-image-1" onChange={(e) => setImageGenModel(e.target.value)} />
                </Field>
              </div>
            </Card>
          )}

          {activeTab === 'swarm' && (
            <Card title="蜂群并发与自动反思">
              <div className="form-stack">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <Field label="蜂群最大下探深度 (Max Depth)">
                    <Input type="number" value={swarmMaxDepth} onChange={(e) => setSwarmMaxDepth(Number(e.target.value))} />
                  </Field>
                  <Field label="单层最大并发工蜂 (Max Width)">
                    <Input type="number" value={swarmMaxWidth} onChange={(e) => setSwarmMaxWidth(Number(e.target.value))} />
                  </Field>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <Field label="单次任务最大节点数 (Max Nodes)">
                    <Input type="number" value={swarmMaxNodes} onChange={(e) => setSwarmMaxNodes(Number(e.target.value))} />
                  </Field>
                  <Field label="单群预算硬上限 ($ USD)">
                    <Input type="number" value={swarmBudgetUSD} onChange={(e) => setSwarmBudgetUSD(Number(e.target.value))} />
                  </Field>
                </div>
                <Field label="默认广深档位（新任务；任务级可覆盖）">
                  <select
                    value={breadthDefaultTier}
                    onChange={(e) => setBreadthDefaultTier(e.target.value as 'light' | 'standard' | 'heavy')}
                    style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'var(--bg-secondary, #1a1a2e)', color: 'inherit', border: '1px solid var(--border-color, #333)' }}
                  >
                    <option value="light">轻 · 快探/小修（1 专家 / 小蜂群 / 验收 1 轮）</option>
                    <option value="standard">中 · 常规迭代（默认）</option>
                    <option value="heavy">重 · 攻坚/高可靠（满配班组 / 大蜂群 / 验收 3 轮）</option>
                  </select>
                </Field>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input type="checkbox" checked={autonomousReflectionEnabled} onChange={(e) => setAutonomousReflectionEnabled(e.target.checked)} />
                  <span>白日梦：空闲时自动反思近期任务（沉淀记忆 + 进化蓝图，默认关）</span>
                </label>
                {autonomousReflectionEnabled && (
                  <Field label="白日梦当日预算上限 ($ USD，0 = 不限)">
                    <Input type="number" step="0.5" value={autonomousReflectionBudgetUSD} onChange={(e) => setAutonomousReflectionBudgetUSD(Number(e.target.value))} />
                  </Field>
                )}
              </div>
            </Card>
          )}

          {activeTab === 'network' && (
            <Card title="网络与出站代理配置">
              <div className="form-stack">
                <Field label="HTTP/HTTPS 代理地址 (Proxy URL)" hint="例如: http://127.0.0.1:7890">
                  <Input value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1:7890" />
                </Field>
                <Field label="代理白名单 (Bypass List)" hint="逗号分隔">
                  <Input value={proxyBypass} onChange={(e) => setProxyBypass(e.target.value)} placeholder="localhost, 127.0.0.1" />
                </Field>
                <Field label="出站超时时间 (毫秒)">
                  <Input type="number" value={egressTimeoutMs} onChange={(e) => setEgressTimeoutMs(Number(e.target.value))} />
                </Field>
              </div>
            </Card>
          )}

          {activeTab === 'appearance' && (
            <Card title="界面外观与显示">
              <div className="form-stack">
                <Field label="主题偏好">
                  <Select value={theme} onChange={(e) => setTheme(e.target.value as any)}>
                    <option value="system">跟随系统 (System)</option>
                    <option value="light">温暖纸质浅色 (Warm Paper Light)</option>
                    <option value="dark">沉浸深灰深色 (Slate Dark)</option>
                  </Select>
                </Field>
                <Field label="界面主字体大小 (px)">
                  <Input type="number" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
                </Field>
                <Field label="界面语言">
                  <Select value={locale} onChange={(e) => setLocale(e.target.value as any)}>
                    <option value="zh">简体中文 (Chinese)</option>
                    <option value="en">English</option>
                  </Select>
                </Field>
                <Field label="界面字体" hint="CSS font-family 值，留空使用默认字体栈">
                  <Input value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} placeholder="如 'PingFang SC', 'Microsoft YaHei', sans-serif" />
                </Field>
                <Field label="代码块主题" hint="编辑器与代码高亮主题名，默认 default">
                  <Input value={codeTheme} onChange={(e) => setCodeTheme(e.target.value)} placeholder="default" />
                </Field>
              </div>
            </Card>
          )}

          {activeTab === 'credentials' && (
            <CredentialStorePanel />
          )}

          {activeTab === 'tools' && (
            <ToolRegistryPanel />
          )}

          {activeTab === 'backup' && (
            <BackupCenterPanel />
          )}
        </div>
      </div>
      <footer className="settings-footer" style={{ marginTop: '16px', fontSize: '12px', color: 'var(--fg-muted, #888)', textAlign: 'center' }}>
        {health.data ? `muster v${health.data.version}` : 'muster'}
      </footer>
    </div>
  );
}
