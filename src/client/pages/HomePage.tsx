import { useEffect, useState } from 'react';
import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects, useProject, useQuickProject, useWorkbench } from '../hooks/queries';
import { readRecentProjectId, writeRecentProjectId } from '../hooks/useRecentProject';
import { PromptComposer } from '../components/workbench/PromptComposer';
import { toast } from '../components/Button';

const SUGGESTIONS = [
  { icon: '💻', title: '全栈应用研发', prompt: '帮我设计并开发一个现代全栈 Web 应用，包含前端三栏交互和后端 REST 接口。' },
  { icon: '✍️', title: '小说大纲与正文', prompt: '我想构思一部赛博朋克科幻悬疑小说，请帮我设计核心世界观、主角人设与前三章大纲。' },
  { icon: '⚡', title: '代码重构与测试', prompt: '对当前代码库进行架构清理，优化组件层级结构并补全关键单元测试。' },
  { icon: '📊', title: '行业研报与方案', prompt: '针对当前 AI 智能体协作领域的最新技术路线，撰写一份深度调研与竞品分析报告。' },
];

export function HomePage(): React.ReactElement {
  const navigate = useNavigate();
  const { isLoading: companiesLoading } = useWorkbench();
  const { data: projects, isLoading: projectsLoading } = useProjects();

  const [recentProjectId, setRecentProjectId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readRecentProjectId(window.localStorage));
  const recentProject = useProject(recentProjectId ?? undefined);
  const quickProject = useQuickProject();

  const [currentModel, setCurrentModel] = useState<string>('claude-3-7-sonnet');
  const [thinkingDepth, setThinkingDepth] = useState<'off' | 'low' | 'med' | 'high'>('high');

  // 1. 如果有最近打开的项目且项目有效，直接进入该项目主工作台
  useEffect(() => {
    if (recentProject.data?.id) {
      navigate(`/projects/${recentProject.data.id}`, { replace: true });
    }
  }, [recentProject.data?.id, navigate]);

  // 2. 如果记录的最近项目失效，清理记录
  useEffect(() => {
    if (recentProject.isError && recentProjectId) {
      writeRecentProjectId(window.localStorage, null);
      setRecentProjectId(null);
    }
  }, [recentProject.isError, recentProjectId]);

  // 3. 如果没有最近项目记录，但系统内已有项目，自动进入第一个活跃项目的主工作台
  useEffect(() => {
    if (recentProjectId || companiesLoading || projectsLoading || !projects || projects.length === 0) return;
    const activeProject = projects.find((p) => p.state === 'active') ?? projects[0];
    if (activeProject?.id) {
      writeRecentProjectId(window.localStorage, activeProject.id);
      navigate(`/projects/${activeProject.id}`, { replace: true });
    }
  }, [recentProjectId, companiesLoading, projectsLoading, projects, navigate]);

  const handleStartWithPrompt = (promptText: string): void => {
    if (!promptText.trim()) return;
    const name = promptText.trim().slice(0, 30);
    quickProject.mutate(
      { name, description: promptText.trim() },
      {
        onSuccess: (p) => {
          writeRecentProjectId(window.localStorage, p.project.id);
          navigate(`/projects/${p.project.id}`, { replace: true });
          toast('success', '已理解目标，负责人与团队已就位');
        },
        onError: (err) => {
          toast('error', (err as Error).message || '创建项目失败');
        },
      },
    );
  };

  // 若正在加载或自动跳转中，显示极简微光
  if (companiesLoading || projectsLoading || recentProject.isLoading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ fontSize: '13px', color: 'var(--fg-subtle)', letterSpacing: '0.04em' }}>
          正在载入工作台…
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--fg)', overflow: 'hidden' }}>
      {/* 极简顶栏 */}
      <header style={{ height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elev)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)' }} />
          <strong style={{ fontSize: '13px', letterSpacing: '-0.01em' }}>Muster Studio</strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '12px', color: 'var(--fg-subtle)' }}>
          <span>自然语言项目工作台</span>
          <Link to="/projects/new" style={{ color: 'var(--fg-muted)', fontSize: '12px' }}>用表单新建项目 →</Link>
        </div>
      </header>

      {/* 沉浸式对话开工视口（无任何繁琐表单，纯自然语言对话） */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: '840px', width: '100%', margin: '0 auto', padding: '24px 20px', boxSizing: 'border-box', overflowY: 'auto' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '24px' }}>
          {/* 负责人欢迎卡片 */}
          <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', width: 'fit-content', padding: '4px 10px', background: 'var(--accent-subtle)', borderRadius: 'var(--radius-full)', color: 'var(--accent)', fontSize: '12px', fontWeight: 700 }}>
              <span>✨ 第一负责人在线</span>
            </div>
            <h1 style={{ fontSize: '28px', fontWeight: 750, letterSpacing: '-0.03em', margin: 0, lineHeight: 1.25 }}>
              你想开始什么新工作？
            </h1>
            <p className="muted" style={{ margin: 0, fontSize: '14px', lineHeight: 1.6, maxWidth: '640px' }}>
              直接交代你的目标或具体想法。无需填表，我将自动理解意图、拆解任务清单并调配最合适的智能体专家立即推进。
            </p>
          </div>

          {/* 灵感药丸推荐 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
            {SUGGESTIONS.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleStartWithPrompt(item.prompt)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '6px',
                  padding: '12px 14px',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  boxShadow: 'var(--shadow-1)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = 'var(--shadow-2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.boxShadow = 'var(--shadow-1)';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 650, fontSize: '13px', color: 'var(--fg)' }}>
                  <span>{item.icon}</span>
                  <span>{item.title}</span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--fg-subtle)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {item.prompt}
                </div>
              </button>
            ))}
          </div>

          {/* 居中簇收尾：全功能复合输入框（hero+药丸+输入框一体居中） */}
          <PromptComposer
            placeholder="告诉负责人你想做什么…（例如：帮我重构三栏工作台）"
            currentModel={currentModel}
            onSelectModel={setCurrentModel}
            thinkingDepth={thinkingDepth}
            onToggleThinking={setThinkingDepth}
            loading={quickProject.isPending}
            onSend={(text) => handleStartWithPrompt(text)}
          />
        </div>
      </main>
    </div>
  );
}
