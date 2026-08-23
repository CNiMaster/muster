import { useState } from 'react';
import type React from 'react';
import { api } from '../../api/client';
import { useSystemSettings } from '../../hooks/queries';

/**
 * 工作台快速指引（1-3 步浮层）。
 * 完成标记存服务端 system_setting（workbench_guide_done）——多浏览器/多设备共享，
 * 不再按浏览器 localStorage 识别"首次"（换浏览器/手机访问不再重复弹）。
 * 提交走轻量专用端点 /api/settings/workbench-guide（主批量端点 schema 必填全量，单键会被 422）。
 * 加载中不渲染（防先显示后消失的闪烁）；本会话完成即隐藏，落库异步。
 */
const steps = [
  { label: '1 选择工作', detail: '从左边选择任务、对话或看板。' },
  { label: '2 完成工作', detail: '中间始终是当前要做的事。' },
  { label: '3 查看现场', detail: '右边自动显示智能体、运行和审批。' },
];

export function WorkbenchGuide(): React.ReactElement | null {
  const { data: settings, isLoading } = useSystemSettings();
  const [step, setStep] = useState(0);
  const [finished, setFinished] = useState(false);
  if (isLoading || finished || settings?.workbenchGuideDone) return null;
  const finish = (): void => {
    setFinished(true);
    api.post('/api/settings/workbench-guide', { done: true }).catch(() => { /* 落库失败不打扰用户，下次再提示 */ });
  };
  return <div className={`workbench-guide guide-step-${step + 1}`} role="dialog" aria-label="工作台快速指引">
    <span>{steps[step]!.label}</span><p>{steps[step]!.detail}</p>
    <button type="button" className="guide-skip" onClick={finish}>跳过</button>
    <button type="button" className="guide-next" onClick={() => step === steps.length - 1 ? finish() : setStep(step + 1)}>{step === steps.length - 1 ? '知道了' : '下一步'}</button>
  </div>;
}
