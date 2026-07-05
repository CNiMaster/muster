/**
 * Metric · 指标卡
 *
 重写 UsagePage 那种数字展示。label + value + 可选 delta/子文本。
 */
import type React from 'react';
import { Card } from './Card';

export interface MetricProps {
  label: string;
  value: React.ReactNode;
  delta?: { value: string; tone: 'up' | 'down' | 'flat' };
  hint?: string;
}

export function Metric({ label, value, delta, hint }: MetricProps): React.ReactElement {
  return (
    <Card className="mu-metric">
      <div className="mu-metric-label">{label}</div>
      <div className="mu-metric-value">{value}</div>
      <div className="mu-metric-foot">
        {delta && <span className={`mu-metric-delta mu-metric-delta-${delta.tone}`}>{delta.value}</span>}
        {hint && <span className="mu-metric-hint">{hint}</span>}
      </div>
    </Card>
  );
}
