import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ProjectWorkNavigation } from '../../src/client/components/workbench/ProjectWorkNavigation';

describe('project calm workbench', () => {
  it('keeps one vertical work list and routes communication into the center surface', () => {
    render(<MemoryRouter><ProjectWorkNavigation projectId="pr_1" selectedId="pt_1" view="task" attentionCount={2} novel={false} onSelect={vi.fn()} tasks={[{ id:'pt_1',projectId:'pr_1',seq:1,title:'审批闭环',brief:'',state:'active',completedAt:null,archivedAt:null,createdAt:'',updatedAt:'' }]} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /审批闭环/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /项目群聊/ })).toHaveAttribute('href', '/projects/pr_1?view=chat&projectTask=pt_1');
    expect(screen.getByRole('link', { name: /等待处理/ })).toHaveTextContent('2');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('人物关系')).not.toBeInTheDocument();
  });
});
