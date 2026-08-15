import { useState } from 'react';
import type React from 'react';

const GUIDE_KEY = 'muster:workbench-guide:v1';
const steps = [
  { label: '1 选择工作', detail: '从左边选择任务、对话或看板。' },
  { label: '2 完成工作', detail: '中间始终是当前要做的事。' },
  { label: '3 查看现场', detail: '右边自动显示智能体、运行和审批。' },
];

export function WorkbenchGuide(): React.ReactElement | null {
  const [step, setStep] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem(GUIDE_KEY) === 'done' ? -1 : 0);
  if (step < 0) return null;
  const finish = (): void => { localStorage.setItem(GUIDE_KEY, 'done'); setStep(-1); };
  return <div className={`workbench-guide guide-step-${step + 1}`} role="dialog" aria-label="工作台快速指引">
    <span>{steps[step]!.label}</span><p>{steps[step]!.detail}</p>
    <button type="button" className="guide-skip" onClick={finish}>跳过</button>
    <button type="button" className="guide-next" onClick={() => step === steps.length - 1 ? finish() : setStep(step + 1)}>{step === steps.length - 1 ? '知道了' : '下一步'}</button>
  </div>;
}
