import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ProjectWorkNavigation, projectTaskMark } from '../../src/client/components/workbench/ProjectWorkNavigation';
import { companySectionOptions, projectSectionOptions } from '../../src/client/components/workbench/WorkbenchContextSwitcher';

describe('project calm workbench', () => {
  it('keeps one vertical work list and routes communication into the center surface', () => {
    render(<MemoryRouter><ProjectWorkNavigation projectId="pr_1" selectedId="pt_1" view="task" attentionCount={2} novel={false} onSelect={vi.fn()} tasks={[{ id:'pt_1',projectId:'pr_1',seq:1,title:'审批闭环',brief:'',state:'active',completedAt:null,archivedAt:null,createdAt:'',updatedAt:'' }]} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /审批闭环/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /项目群聊/ })).toHaveAttribute('href', '/projects/pr_1?view=chat&projectTask=pt_1');
    expect(screen.getByRole('link', { name: /等待处理/ })).toHaveTextContent('2');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('人物关系')).not.toBeInTheDocument();
  });

  it('uses a meaningful title mark and folds duplicate project-task names', () => {
    expect(projectTaskMark('修复执行器审批桥')).toBe('执行');
    render(<MemoryRouter><ProjectWorkNavigation projectId="pr_1" selectedId="pt_2" view="task" attentionCount={0} novel={false} onSelect={vi.fn()} tasks={[
      { id:'pt_2',projectId:'pr_1',seq:2,title:'[规划] 当前阶段工作拆解',brief:'',state:'active',completedAt:null,archivedAt:null,createdAt:'',updatedAt:'' },
      { id:'pt_1',projectId:'pr_1',seq:1,title:'[规划] 当前阶段工作拆解',brief:'',state:'active',completedAt:null,archivedAt:null,createdAt:'',updatedAt:'' },
    ]} /></MemoryRouter>);
    expect(screen.getAllByRole('button', { name: /当前阶段工作拆解/ })).toHaveLength(2);
    expect(screen.getByText('其余 1 个任务')).toBeInTheDocument();
  });

  it('builds direct company and project switcher destinations', () => {
    expect(companySectionOptions('co_1').find((item) => item.key === 'team')?.href).toBe('/companies/co_1?view=team');
    const projectItems = projectSectionOptions('pr_1', 'pt_1');
    expect(projectItems.find((item) => item.key === 'task')?.href).toBe('/projects/pr_1?projectTask=pt_1');
    expect(projectItems.find((item) => item.key === 'chat')?.href).toBe('/projects/pr_1?view=chat&projectTask=pt_1');
    expect(projectItems.some((item) => item.key === 'character')).toBe(false);
    expect(projectSectionOptions('pr_1', 'pt_1', true).some((item) => item.key === 'character')).toBe(true);
  });
});
