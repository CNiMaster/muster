import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { desktopNotificationsEnabled, setDesktopNotificationsEnabled } from '../hooks/useTaskNotifications';
import type React from 'react';
import { useHealthStatus, useSaveSystemSettings, useSystemSettings, useTestConnection, useExecutorProfiles, useUiMode } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Input, Select } from '../components/Form';
import { useSearchParams } from 'react-router-dom';
import { SettingsRow, SettingsSectionLabel, SettingsFold, Toggle } from '../components/SettingsRow';
import { ToolRegistryPanel } from '../components/settings/ToolRegistryPanel';
import { SkillLibraryPanel } from '../components/settings/SkillLibraryPanel';
import { CredentialStorePanel } from '../components/settings/CredentialStorePanel';
import { BackupCenterPanel } from '../components/settings/BackupCenterPanel';
import { SpecialistReviewPanel } from '../components/settings/SpecialistReviewPanel';

type SettingsTab = 'general' | 'usage' | 'models' | 'swarm' | 'network' | 'appearance' | 'credentials' | 'tools' | 'backup' | 'specialists';

/** 界面字体预设：value=CSS font-family；__custom__=用户自填。 */
const FONT_PRESETS: Array<{ value: string; label: string }> = [
  { value: '', label: '系统默认（推荐）' },
  { value: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif", label: '系统界面同款' },
  { value: "'PingFang SC', sans-serif", label: '苹方（macOS）' },
  { value: "'Microsoft YaHei', sans-serif", label: '微软雅黑（Windows）' },
  { value: "'Noto Sans SC', sans-serif", label: '思源黑体' },
];
const FONT_CUSTOM = '__custom__';

/** 高级组标签（simple 模式默认折叠为一行入口；pro 全展开）。 */
const ADVANCED_TABS: SettingsTab[] = ['models', 'swarm', 'network', 'credentials', 'tools', 'specialists'];

export function SettingsPage(): React.ReactElement {
  const { data: settings, isLoading } = useSystemSettings();
  const saveSettings = useSaveSystemSettings();
  const testConnection = useTestConnection();
  const { data: executorProfiles = [] } = useExecutorProfiles();
  const health = useHealthStatus();
  const { isSimple } = useUiMode();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = (searchParams.get('tab') as SettingsTab) || 'general';
  const setTab = (t: SettingsTab): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next);
  };
  // simple 模式高级组默认收起；URL 直达高级 tab 或点开入口后保持展开
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const advancedVisible = !isSimple || advancedOpened || ADVANCED_TABS.includes(activeTab);

  const [claudeBin, setClaudeBin] = useState('');
  const [model, setModel] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  // 后端 schema 必填的兼容键（超时/工具上限的日常配置已由执行器档案接管）：
  // 不渲染 UI，仅随全量保存回传服务端加载值，避免 PUT 校验失败。
  const [, setTimeoutMs] = useState(600000);
  const [, setMaxToolCalls] = useState(30);
  const [defaultProvider, setDefaultProvider] = useState('claude-cli');
  const [openaiBaseURL, setOpenaiBaseURL] = useState('https://api.openai.com/v1');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash');
  // 执行器池统一（2026-08-17）：档位 = 执行器档案 id（高/标准/低，CLI+API 一个选择框）
  const [tierHigh, setTierHigh] = useState('');
  const [tierStandard, setTierStandard] = useState('');
  const [tierLow, setTierLow] = useState('');
  const [imageGenModel, setImageGenModel] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyBypass, setProxyBypass] = useState('');
  const [caCertPath, setCaCertPath] = useState('');
  const [egressTimeoutSec, setEgressTimeoutSec] = useState(30);
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('system');
  const [fontFamily, setFontFamily] = useState('');
  const [fontSize, setFontSize] = useState(14);
  const [locale, setLocale] = useState<'zh' | 'en'>('zh');
  const [codeTheme, setCodeTheme] = useState('default');
  const [codeFontSize, setCodeFontSize] = useState(0);
  const [wrapCode, setWrapCode] = useState(false);
  const [autonomousReflectionEnabled, setAutonomousReflectionEnabled] = useState(false);
  const [autonomousReflectionBudgetUSD, setAutonomousReflectionBudgetUSD] = useState(5);
  const [memoryHousekeepingEnabled, setMemoryHousekeepingEnabled] = useState(true);
  const [swarmMaxDepth, setSwarmMaxDepth] = useState(3);
  const [swarmMaxWidth, setSwarmMaxWidth] = useState(5);
  const [swarmMaxNodes, setSwarmMaxNodes] = useState(30);
  const [swarmBudgetUSD, setSwarmBudgetUSD] = useState(5);
  const [breadthDefaultTier, setBreadthDefaultTier] = useState<'light' | 'standard' | 'heavy'>('standard');
  const [waitingAutoContinueMin, setWaitingAutoContinueMin] = useState(0);
  const [archiveTaskAfterDays, setArchiveTaskAfterDays] = useState(30);
  const [preventSleep, setPreventSleep] = useState<'active' | 'always' | 'off'>('active');
  const [interruptMode, setInterruptMode] = useState<'queue' | 'interrupt'>('queue');
  const [stopGraceSec, setStopGraceSec] = useState(60);
  const [securityMode, setSecurityMode] = useState<'' | 'confirm-edits' | 'auto-edit' | 'plan' | 'full-access'>('');
  const [msgShowThinking, setMsgShowThinking] = useState(true);
  const [msgShowTodo, setMsgShowTodo] = useState(true);
  const [msgGroupExplore, setMsgGroupExplore] = useState(true);
  const [msgGroupTerminal, setMsgGroupTerminal] = useState(true);
  const [msgGroupChanges, setMsgGroupChanges] = useState(true);
  const [desktopNotify, setDesktopNotify] = useState(desktopNotificationsEnabled());

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
    setTierHigh(settings.executorTierHighId ?? (settings.executorTierPrimaryId ?? ''));
    setTierStandard(settings.executorTierStandardId ?? (settings.executorTierSecondaryId ?? ''));
    setTierLow(settings.executorTierLowId ?? (settings.executorTierTertiaryId ?? ''));
    setImageGenModel(settings.imageGenModel ?? '');
    setProxyUrl(settings.proxyUrl ?? '');
    setProxyBypass(settings.proxyBypass ?? '');
    setCaCertPath(settings.caCertPath ?? '');
    setEgressTimeoutSec(Math.round((settings.egressTimeoutMs ?? 30000) / 1000));
    setTheme(settings.theme ?? 'system');
    setFontFamily(settings.fontFamily ?? '');
    setFontSize(settings.fontSize ?? 14);
    setLocale(settings.locale ?? 'zh');
    setCodeTheme(settings.codeTheme ?? 'default');
    setCodeFontSize(settings.codeFontSize ?? 0);
    setWrapCode(settings.wrapCode === true);
    setAutonomousReflectionEnabled(settings.autonomousReflectionEnabled ?? false);
    setAutonomousReflectionBudgetUSD(settings.autonomousReflectionBudgetUSD || 5);
    setMemoryHousekeepingEnabled(settings.memoryHousekeepingEnabled ?? true);
    setSwarmMaxDepth(settings.swarmMaxDepth ?? 3);
    setSwarmMaxWidth(settings.swarmMaxWidth ?? 5);
    setSwarmMaxNodes(settings.swarmMaxNodes ?? 30);
    setSwarmBudgetUSD(settings.swarmBudgetUSD ?? 5);
    setBreadthDefaultTier(settings.breadthDefaultTier ?? 'standard');
    setWaitingAutoContinueMin(settings.waitingAutoContinueMinutes ?? 0);
    setArchiveTaskAfterDays(settings.archiveTaskAfterDays ?? 30);
    setPreventSleep(settings.preventSleep ?? 'active');
    setInterruptMode(settings.interruptMode ?? 'queue');
    setStopGraceSec(Math.round((settings.stopGraceMs ?? 60000) / 1000));
    setSecurityMode(settings.securityMode ?? '');
    setMsgShowThinking(settings.messageShowThinking !== false);
    setMsgShowTodo(settings.messageShowTodo !== false);
    setMsgGroupExplore(settings.messageGroupExplore !== false);
    setMsgGroupTerminal(settings.messageGroupTerminal !== false);
    setMsgGroupChanges(settings.messageGroupChanges !== false);
  }, [settings]);

  const handleSave = (): void => {
    if (!claudeBin.trim()) {
      toast('error', '执行工具路径不能为空');
      return;
    }
    saveSettings.mutate(
      // timeoutMs/maxToolCalls 回传服务端加载值（schema 必填、UI 已由执行器档案接管）
      { claudeBin, model, skipPermissions, timeoutMs: settings?.timeoutMs ?? 600000, maxToolCalls: settings?.maxToolCalls ?? 30, defaultProvider, openaiBaseURL, openaiModel, geminiModel, executorTierHighId: tierHigh, executorTierStandardId: tierStandard, executorTierLowId: tierLow, imageGenModel, proxyUrl, proxyBypass, caCertPath, egressTimeoutMs: egressTimeoutSec * 1000, theme, fontFamily, fontSize, locale, codeTheme, autonomousReflectionEnabled, autonomousReflectionBudgetUSD, memoryHousekeepingEnabled, swarmMaxDepth, swarmMaxWidth, swarmMaxNodes, swarmBudgetUSD, breadthDefaultTier, codeFontSize, wrapCode, waitingAutoContinueMinutes: waitingAutoContinueMin, archiveTaskAfterDays, preventSleep, interruptMode, stopGraceMs: stopGraceSec * 1000, securityMode, messageShowThinking: msgShowThinking, messageShowTodo: msgShowTodo, messageGroupExplore: msgGroupExplore, messageGroupTerminal: msgGroupTerminal, messageGroupChanges: msgGroupChanges },
      {
        onSuccess: () => toast('success', '设置已保存并实时生效'),
        onError: (error: any) => toast('error', error.message ?? '保存设置失败'),
      },
    );
  };

  const handleTest = (): void => {
    testConnection.mutate(
      { claudeBin, model },
      {
        onSuccess: (result) => toast(result.overallSuccess ? 'success' : 'error', result.overallSuccess ? '连接测试通过' : '连接测试未通过'),
        onError: (error: any) => toast('error', error.message ?? '测试执行失败'),
      },
    );
  };

  if (isLoading) return <div className="loading">加载系统设置中…</div>;

  return (
    <div className="settings-page">
      <header className="page-header" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{ margin: 0, fontSize: '22px' }}>系统设置</h1>
        </div>
        <div className="page-actions">
          <Button variant="ghost" size="sm" onClick={handleTest} loading={testConnection.isPending}>测试连接</Button>
          <Button size="sm" onClick={handleSave} loading={saveSettings.isPending}>保存修改</Button>
        </div>
      </header>

      <div className="settings-split">
        {/* 左侧分类导航：常用三项日常高频；高级组 simple 模式默认折叠为一行入口 */}
        <nav className="settings-nav" aria-label="设置分组导航">
          <div className="settings-nav-group-label">常用</div>
          <button type="button" className={`settings-nav-item ${activeTab === 'general' ? 'is-active' : ''}`} onClick={() => setTab('general')}>
            <span>⚙️ 基础与行为</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'appearance' ? 'is-active' : ''}`} onClick={() => setTab('appearance')}>
            <span>🎨 外观与消息流</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'backup' ? 'is-active' : ''}`} onClick={() => setTab('backup')}>
            <span>💾 数据库与备份</span>
          </button>
          <button type="button" className={`settings-nav-item ${activeTab === 'usage' ? 'is-active' : ''}`} onClick={() => setTab('usage')}>
            <span>📊 用量与花费</span>
          </button>
          {advancedVisible && (
            <>
              <div className="settings-nav-group-label">高级</div>
              <button type="button" className={`settings-nav-item ${activeTab === 'models' ? 'is-active' : ''}`} onClick={() => setTab('models')}>
                <span>🧠 模型与档位</span>
              </button>
              <button type="button" className={`settings-nav-item ${activeTab === 'swarm' ? 'is-active' : ''}`} onClick={() => setTab('swarm')}>
                <span>🐝 蜂群调度</span>
              </button>
              <button type="button" className={`settings-nav-item ${activeTab === 'network' ? 'is-active' : ''}`} onClick={() => setTab('network')}>
                <span>🌐 网络代理</span>
              </button>
              <button type="button" className={`settings-nav-item ${activeTab === 'credentials' ? 'is-active' : ''}`} onClick={() => setTab('credentials')}>
                <span>🔑 凭据金库</span>
              </button>
              <button type="button" className={`settings-nav-item ${activeTab === 'tools' ? 'is-active' : ''}`} onClick={() => setTab('tools')}>
                <span>🔧 工具与 MCP</span>
              </button>
              <button type="button" className={`settings-nav-item ${activeTab === 'specialists' ? 'is-active' : ''}`} onClick={() => setTab('specialists')}>
                <span>🧑‍🔬 专家盘点</span>
              </button>
            </>
          )}
          {isSimple && !advancedVisible && (
            <button type="button" className="settings-nav-advanced-toggle" onClick={() => setAdvancedOpened(true)}>
              ▸ 高级设置（模型 · 蜂群 · 网络 · 凭据 · 工具 · 盘点）
            </button>
          )}
        </nav>

        {/* 右侧配置面板 */}
        <div className="settings-content-panel">
          {activeTab === 'general' && (
            <Card title="基础与行为">
              <SettingsSectionLabel>首次使用 · 必须配置</SettingsSectionLabel>
              <SettingsRow badge="required" title="默认执行引擎" hint="装了哪个 AI 编码工具就选哪个；选 API 需到「模型与档位」配接口参数">
                <Select value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)}>
                  <option value="claude-cli">Claude Code CLI</option>
                  <option value="codex-cli">Codex CLI</option>
                  <option value="antigravity-cli">Antigravity CLI</option>
                  <option value="openai">OpenAI 兼容 API</option>
                  <option value="gemini">Gemini API</option>
                </Select>
              </SettingsRow>
              <SettingsRow badge="required" title="执行工具路径" hint="系统自动检测到的命令位置，一般不用改；连接测试失败时再调整">
                <Input value={claudeBin} onChange={(e) => setClaudeBin(e.target.value)} />
              </SettingsRow>

              <SettingsSectionLabel>日常习惯 · 建议看一眼</SettingsSectionLabel>
              <SettingsRow badge="recommended" title="动手前先问我" hint="AI 改文件、跑命令前要不要先征求你的同意；不设置则跟随每个任务自己的安全策略">
                <Select value={securityMode} onChange={(e) => setSecurityMode(e.target.value as typeof securityMode)}>
                  <option value="">跟随任务策略（推荐）</option>
                  <option value="plan">只读规划（什么都不改）</option>
                  <option value="confirm-edits">改文件前确认</option>
                  <option value="auto-edit">自动改文件，命令仍确认</option>
                  <option value="full-access">全自动（AI 自行判断）</option>
                </Select>
              </SettingsRow>
              <SettingsRow badge="recommended" title="执行中插话" hint="任务运行时你继续打字：排队等这轮结束自动送出，还是立即打断当前动作">
                <Select value={interruptMode} onChange={(e) => setInterruptMode(e.target.value as 'queue' | 'interrupt')}>
                  <option value="queue">排队等本轮结束（推荐）</option>
                  <option value="interrupt">立即打断插话</option>
                </Select>
              </SettingsRow>

              <SettingsFold summary="更多行为（防休眠 · 自动复盘 · 超时 · 权限跳过）">
                <SettingsRow title="防休眠" hint="电脑睡眠会中断任务和手机连接；有任务运行时自动保持唤醒（仅 macOS）">
                  <Select value={preventSleep} onChange={(e) => setPreventSleep(e.target.value as 'active' | 'always' | 'off')}>
                    <option value="active">有任务时保活（推荐）</option>
                    <option value="always">常驻保活</option>
                    <option value="off">关闭</option>
                  </Select>
                </SettingsRow>
                <SettingsRow title="任务桌面通知" hint="任务完成、失败或等你确认时弹系统通知；首次开启浏览器会请求通知权限">
                  <Toggle
                    checked={desktopNotify}
                    onChange={(next) => {
                      void setDesktopNotificationsEnabled(next).then(() => setDesktopNotify(next));
                    }}
                    label="任务桌面通知"
                  />
                </SettingsRow>
                <SettingsRow title="空闲自动复盘（白日梦）" hint="没事干的时候自动回顾近期任务：沉淀记忆、改进打法；默认关">
                  <Toggle checked={autonomousReflectionEnabled} onChange={setAutonomousReflectionEnabled} label="空闲自动复盘" />
                </SettingsRow>
                {autonomousReflectionEnabled && (
                  <SettingsRow title="复盘每日花费上限" hint="自动复盘每天最多花多少钱，防止空闲时段悄悄烧预算">
                    <Select value={String(autonomousReflectionBudgetUSD)} onChange={(e) => setAutonomousReflectionBudgetUSD(Number(e.target.value))}>
                      <option value="1">$1 / 天</option>
                      <option value="2">$2 / 天</option>
                      <option value="5">$5 / 天（推荐）</option>
                      <option value="0">不限</option>
                    </Select>
                  </SettingsRow>
                )}
                <SettingsRow title="记忆内务（自动整理）" hint="后台整理记忆库：去重、归并相似条目（纯规则零成本，默认开；与白日梦复盘互不影响）">
                  <Toggle checked={memoryHousekeepingEnabled} onChange={setMemoryHousekeepingEnabled} label="记忆内务" />
                </SettingsRow>
                <SettingsRow title="提问超时自动继续" hint="AI 向你提问后一直没回复，到时间自动按「请继续」往下走；也可在每张等待卡上单独调">
                  <Select value={String(waitingAutoContinueMin)} onChange={(e) => setWaitingAutoContinueMin(Number(e.target.value))}>
                    <option value="0">一直等（默认）</option>
                    <option value="10">10 分钟</option>
                    <option value="30">30 分钟</option>
                    <option value="60">1 小时</option>
                  </Select>
                </SettingsRow>
                <SettingsRow title="任务自动归档" hint="已完成的任务放满 N 天后自动收进归档区（左栏不再显示，归档页可还原）">
                  <Select value={String(archiveTaskAfterDays)} onChange={(e) => setArchiveTaskAfterDays(Number(e.target.value))}>
                    <option value="0">不自动归档</option>
                    <option value="7">7 天</option>
                    <option value="30">30 天（推荐）</option>
                    <option value="90">90 天</option>
                  </Select>
                </SettingsRow>
                <SettingsRow title="停止等待时间" hint="点「停止」后给当前动作留出安全收尾的时间，到点强制停并保留进度">
                  <Select value={String(stopGraceSec)} onChange={(e) => setStopGraceSec(Number(e.target.value))}>
                    <option value="30">30 秒</option>
                    <option value="60">60 秒（推荐）</option>
                    <option value="120">2 分钟</option>
                    <option value="300">5 分钟</option>
                  </Select>
                </SettingsRow>
                <SettingsRow title="跳过权限确认" hint="打开后 AI 完全不再弹权限确认，直接改文件、跑命令——仅在你完全信任的场景使用">
                  <Toggle checked={skipPermissions} onChange={setSkipPermissions} label="跳过权限确认" />
                </SettingsRow>
              </SettingsFold>
            </Card>
          )}

          {activeTab === 'models' && (
            <Card title="模型与档位">
              <p className="muted" style={{ fontSize: '12px', margin: '0 0 8px' }}>
                三档告诉系统「什么活派给哪个执行器」；都不设置就全部跟随系统默认。
              </p>
              <SettingsRow badge="recommended" title="高级档" hint="计划、验收、裁决这类重要环节用的执行器">
                <Select value={tierHigh} onChange={(e) => setTierHigh(e.target.value)}>
                  <option value="">跟随系统默认</option>
                  {executorProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </SettingsRow>
              <SettingsRow title="标准档" hint="普通任务的默认执行器">
                <Select value={tierStandard} onChange={(e) => setTierStandard(e.target.value)}>
                  <option value="">跟随系统默认</option>
                  {executorProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </SettingsRow>
              <SettingsRow title="低档" hint="蜂群工蜂、快速咨询这类轻活用的执行器">
                <Select value={tierLow} onChange={(e) => setTierLow(e.target.value)}>
                  <option value="">跟随系统默认</option>
                  {executorProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </SettingsRow>

              {/* 无关不显示：只在选了对应 API 引擎时才露出接口参数 */}
              {defaultProvider === 'openai' && (
                <>
                  <SettingsSectionLabel>OpenAI 兼容接口</SettingsSectionLabel>
                  <SettingsRow title="接口地址" hint="OpenAI 兼容服务的基础地址">
                    <Input value={openaiBaseURL} onChange={(e) => setOpenaiBaseURL(e.target.value)} />
                  </SettingsRow>
                  <SettingsRow title="模型名" hint="该接口下使用的模型标识">
                    <Input value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} />
                  </SettingsRow>
                </>
              )}
              {defaultProvider === 'gemini' && (
                <>
                  <SettingsSectionLabel>Gemini 接口</SettingsSectionLabel>
                  <SettingsRow title="模型名" hint="Gemini API 使用的模型标识">
                    <Input value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} />
                  </SettingsRow>
                </>
              )}
              {defaultProvider !== 'openai' && defaultProvider !== 'gemini' && (
                <p className="muted" style={{ fontSize: '12px', margin: '10px 0 0' }}>
                  当前使用命令行引擎，无需配置 API 接口参数。
                </p>
              )}

              <SettingsFold summary="更多模型（图像生成）">
                <SettingsRow title="图像生成模型" hint="画图工具用的模型，留空用内置默认 gpt-image-1">
                  <Input value={imageGenModel} placeholder="留空默认 gpt-image-1" onChange={(e) => setImageGenModel(e.target.value)} />
                </SettingsRow>
              </SettingsFold>
            </Card>
          )}

          {activeTab === 'swarm' && (
            <Card title="蜂群调度">
              <p className="muted" style={{ fontSize: '12px', margin: '0 0 8px' }}>
                蜂群的规模和花费由「广深档」自动控制；想手动收紧上限再展开专家微调。
              </p>
              <SettingsRow badge="recommended" title="默认广深档" hint="新任务的规模档位（单个任务可临时切换）：轻=快探小修；中=常规迭代；重=攻坚、班组满配、验收更严">
                <Select value={breadthDefaultTier} onChange={(e) => setBreadthDefaultTier(e.target.value as 'light' | 'standard' | 'heavy')}>
                  <option value="light">轻 · 快探/小修</option>
                  <option value="standard">中 · 常规迭代（推荐）</option>
                  <option value="heavy">重 · 攻坚/高可靠</option>
                </Select>
              </SettingsRow>
              <SettingsFold summary="专家微调 · 并发与预算上限（默认值已足够）">
                <SettingsRow title="最大下探深度" hint="子任务最多嵌套几层">
                  <Input type="number" min={1} max={5} value={swarmMaxDepth} onChange={(e) => setSwarmMaxDepth(Number(e.target.value))} />
                </SettingsRow>
                <SettingsRow title="单层并发工蜂" hint="一层最多同时派几只工蜂">
                  <Input type="number" min={1} max={20} value={swarmMaxWidth} onChange={(e) => setSwarmMaxWidth(Number(e.target.value))} />
                </SettingsRow>
                <SettingsRow title="单次节点上限" hint="一次蜂群最多拆多少个节点">
                  <Input type="number" min={1} max={300} value={swarmMaxNodes} onChange={(e) => setSwarmMaxNodes(Number(e.target.value))} />
                </SettingsRow>
                <SettingsRow title="单群预算上限" hint="一次蜂群最多花多少美元">
                  <Input type="number" min={0} step="0.5" value={swarmBudgetUSD} onChange={(e) => setSwarmBudgetUSD(Number(e.target.value))} />
                </SettingsRow>
              </SettingsFold>
            </Card>
          )}

          {activeTab === 'network' && (
            <Card title="网络代理">
              <p className="muted" style={{ fontSize: '12px', margin: '0 0 8px' }}>
                仅在使用网络代理或公司内网证书的环境才需要配置；平时保持默认即可。
              </p>
              <SettingsRow title="HTTP 代理地址" hint="例如 http://127.0.0.1:7890，不用代理就留空">
                <Input value={proxyUrl} placeholder="http://127.0.0.1:7890" onChange={(e) => setProxyUrl(e.target.value)} />
              </SettingsRow>
              <SettingsRow title="代理例外名单" hint="这些地址不走代理，逗号分隔">
                <Input value={proxyBypass} placeholder="localhost, 127.0.0.1" onChange={(e) => setProxyBypass(e.target.value)} />
              </SettingsRow>
              <SettingsFold summary="高级网络（证书 · 超时）">
                <SettingsRow title="自签名证书路径" hint="公司内网自签 HTTPS 证书的文件位置，不用则留空">
                  <Input value={caCertPath} placeholder="留空 = 不启用" onChange={(e) => setCaCertPath(e.target.value)} />
                </SettingsRow>
                <SettingsRow title="出站超时" hint="访问外部服务的最长等待时间">
                  <Select value={String(egressTimeoutSec)} onChange={(e) => setEgressTimeoutSec(Number(e.target.value))}>
                    <option value="10">10 秒</option>
                    <option value="30">30 秒（推荐）</option>
                    <option value="60">60 秒</option>
                  </Select>
                </SettingsRow>
              </SettingsFold>
            </Card>
          )}

          {activeTab === 'appearance' && (
            <Card title="外观">
              <SettingsRow badge="recommended" title="主题" hint="跟随系统自动切换明暗，或固定一种">
                <Select value={theme} onChange={(e) => setTheme(e.target.value as any)}>
                  <option value="system">跟随系统（推荐）</option>
                  <option value="light">浅色 · 温暖纸质</option>
                  <option value="dark">深色 · 沉浸深灰</option>
                </Select>
              </SettingsRow>
              <SettingsRow title="界面字号" hint="正文文字大小（像素）">
                <Select value={String(fontSize)} onChange={(e) => setFontSize(Number(e.target.value))}>
                  {[12, 13, 14, 15, 16, 17, 18].map((size) => (
                    <option key={size} value={size}>{size === 14 ? '14（推荐）' : String(size)}</option>
                  ))}
                </Select>
              </SettingsRow>
              <SettingsRow title="界面语言">
                <Select value={locale} onChange={(e) => setLocale(e.target.value as any)}>
                  <option value="zh">简体中文</option>
                  <option value="en">English</option>
                </Select>
              </SettingsRow>
              <SettingsSectionLabel>代码显示</SettingsSectionLabel>
              <SettingsRow title="代码字号" hint="代码块、文件预览里的文字大小；与界面字号互不影响">
                <Select value={String(codeFontSize)} onChange={(e) => setCodeFontSize(Number(e.target.value))}>
                  <option value="0">默认 13</option>
                  {[12, 14, 15, 16].map((px) => <option key={px} value={px}>{String(px)}</option>)}
                </Select>
              </SettingsRow>
              <SettingsRow title="长行自动换行" hint="过长的代码自动折行显示；关闭则横向滚动">
                <Toggle checked={wrapCode} onChange={setWrapCode} label="长行自动换行" />
              </SettingsRow>
              <SettingsFold summary="更多外观（字体 · 代码主题）">
                <SettingsRow title="界面字体" hint="预设选一个即可；都不满意再选「自定义」填写 CSS 字体族">
                  <Select
                    value={FONT_PRESETS.some((f) => f.value === fontFamily) ? fontFamily : FONT_CUSTOM}
                    onChange={(e) => setFontFamily(e.target.value === FONT_CUSTOM ? "'PingFang SC', sans-serif" : e.target.value)}
                  >
                    {FONT_PRESETS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    <option value={FONT_CUSTOM}>自定义…</option>
                  </Select>
                </SettingsRow>
                {fontFamily === FONT_CUSTOM || (!FONT_PRESETS.some((f) => f.value === fontFamily) && fontFamily !== '') && (
                  <SettingsRow title="自定义字体族" hint="CSS font-family 值">
                    <Input value={fontFamily} placeholder="如 'HarmonyOS Sans SC', sans-serif" onChange={(e) => setFontFamily(e.target.value)} />
                  </SettingsRow>
                )}
                <SettingsRow title="代码块主题" hint="代码高亮主题名，留空用默认">
                  <Input value={codeTheme} placeholder="default" onChange={(e) => setCodeTheme(e.target.value)} />
                </SettingsRow>
              </SettingsFold>
            </Card>
          )}

          {activeTab === 'appearance' && (
            <Card title="消息流展示">
              <p className="muted" style={{ fontSize: '12px', margin: '0 0 4px' }}>控制 AI 回复里各类工作块的显示方式，全部默认开启。</p>
              <SettingsRow title="显示思考过程" hint="展示模型的思考内容；关闭时每轮仍显示第一条思考">
                <Toggle checked={msgShowThinking} onChange={setMsgShowThinking} label="显示思考过程" />
              </SettingsRow>
              <SettingsRow title="显示待办卡片" hint="展示 AI 的待办清单卡片">
                <Toggle checked={msgShowTodo} onChange={setMsgShowTodo} label="显示待办卡片" />
              </SettingsRow>
              <SettingsRow title="合并探索记录" hint="连续的读取和搜索聚成一组，减少刷屏">
                <Toggle checked={msgGroupExplore} onChange={setMsgGroupExplore} label="合并探索记录" />
              </SettingsRow>
              <SettingsRow title="合并终端命令" hint="连续的终端命令聚成一组">
                <Toggle checked={msgGroupTerminal} onChange={setMsgGroupTerminal} label="合并终端命令" />
              </SettingsRow>
              <SettingsRow title="合并文件改动" hint="连续的写入和编辑聚成一组">
                <Toggle checked={msgGroupChanges} onChange={setMsgGroupChanges} label="合并文件改动" />
              </SettingsRow>
            </Card>
          )}

          {activeTab === 'usage' && <UsageCard />}

          {activeTab === 'credentials' && (
            <CredentialStorePanel />
          )}

          {activeTab === 'tools' && (
            <>
              <ToolRegistryPanel />
              <SkillLibraryPanel />
            </>
          )}

          {activeTab === 'specialists' && (
            <SpecialistReviewPanel />
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


/** 用量与花费（数据源 GET /api/workbench/usage，工作台级聚合）。 */
function UsageCard(): React.ReactElement {
  const usage = useQuery({ queryKey: ['workbench-usage'], queryFn: () => api.get<{
    totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number;
    totalCostUSD: number; totalToolCalls: number; totalDurationMs: number;
    byModel: Record<string, { tokens: number; costUSD: number }>;
  }>('/api/workbench/usage') });
  if (usage.isLoading) return <Card title="用量与花费"><p className="muted">加载中…</p></Card>;
  const d = usage.data;
  if (!d) return <Card title="用量与花费"><p className="muted">暂无数据。</p></Card>;
  const models = Object.entries(d.byModel ?? {}).sort((a, b) => b[1].costUSD - a[1].costUSD);
  const maxCost = Math.max(0.0001, ...models.map(([, v]) => v.costUSD));
  const fmtTokens = (n: number): string => n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n);
  return (
    <>
      <Card title="累计花费与 Token">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">总花费</span>
            <span className="settings-row-hint">所有任务、所有智能体的模型调用费用合计</span>
          </span>
          <span className="settings-row-control" style={{ justifyContent: 'flex-end', fontSize: 18, fontWeight: 600 }}>${d.totalCostUSD.toFixed(2)}</span>
        </div>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">输入 / 输出 Token</span>
            <span className="settings-row-hint">缓存读取另计 {fmtTokens(d.totalCacheReadTokens)}（缓存成本远低于直读）</span>
          </span>
          <span className="settings-row-control" style={{ justifyContent: 'flex-end', fontSize: 13 }}>{fmtTokens(d.totalInputTokens)} / {fmtTokens(d.totalOutputTokens)}</span>
        </div>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">工具调用次数</span>
            <span className="settings-row-hint">AI 执行动作（读写文件、跑命令等）的总次数</span>
          </span>
          <span className="settings-row-control" style={{ justifyContent: 'flex-end', fontSize: 13 }}>{d.totalToolCalls}</span>
        </div>
      </Card>
      <Card title="按模型的花费分布">
        {models.length === 0 ? (
          <p className="muted">还没有模型调用量。跑几个任务后这里会出现分布。</p>
        ) : (
          models.map(([name, v]) => (
            <div key={name} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span>{name}</span>
                <span className="muted">${v.costUSD.toFixed(2)} · {fmtTokens(v.tokens)} tokens</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-soft, rgba(128,128,128,.15))', marginTop: 4 }}>
                <div style={{ width: `${Math.max(2, (v.costUSD / maxCost) * 100)}%`, height: '100%', borderRadius: 3, background: 'var(--accent, #4a7dff)' }} />
              </div>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
