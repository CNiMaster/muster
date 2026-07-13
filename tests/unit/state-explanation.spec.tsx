import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BlockingIssues } from '../../src/client/components/BlockingIssues';
import { getStateExplanation, type StateDomain } from '../../src/client/components/StateExplanation';

describe('state explanations', () => {
  it.each<Array<[StateDomain,string]>>([
    ['company','draining'],['employee','off'],['project-task','archived'],['thread','rotating'],['probe','failed'],['approval','timed-out'],
  ])('%s.%s has a plain-language explanation and impact', (domain,state) => {
    expect(getStateExplanation(domain,state)).toMatchObject({title:expect.any(String),description:expect.any(String),impact:expect.any(String)});
  });

  it('renders every blocking issue with reason, impact and recovery link', () => {
    render(<MemoryRouter><BlockingIssues issues={[{id:'one',what:'员工不能运行',why:'执行器尚未联通',impact:'工作单不会启动',action:{label:'去修复',href:'/executors'}}]}/></MemoryRouter>);
    expect(screen.getByText('员工不能运行')).toBeInTheDocument();
    expect(screen.getByText(/原因：执行器尚未联通/)).toBeInTheDocument();
    expect(screen.getByText(/影响：工作单不会启动/)).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'去修复'})).toHaveAttribute('href','/executors');
  });
});
