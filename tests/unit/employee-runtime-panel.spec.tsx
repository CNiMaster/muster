import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { EmployeeRuntimePanel } from '../../src/client/components/agents/EmployeeRuntimePanel';

describe('EmployeeRuntimePanel', () => {
  it('explains lazy session creation when the employee has no project thread', () => {
    render(<MemoryRouter><EmployeeRuntimePanel runtime={{ profileId: 'ap_1', totals: { employments: 1, projects: 0, threads: 0, workOrders: 0, artifacts: 0 }, employments: [] }} /></MemoryRouter>);
    expect(screen.getByText('还没有项目运行记录')).toBeInTheDocument();
    expect(screen.getByText(/首次收到项目任务中的工作单/)).toBeInTheDocument();
  });
});
