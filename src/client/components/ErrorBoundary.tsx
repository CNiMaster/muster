import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 区分边界，便于日志标识。 */
  label?: string;
  /** 自定义回退 UI；不传则使用默认。 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 全局/分块错误边界（PRD:346 体验完善项）。
 - 捕获子树渲染错误，避免整页白屏。
 - 提供"重试"（reset 边界）和"回首页"两个动作。
 - componentStack 仅在开发环境展示，避免泄露内部结构。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <DefaultFallback error={this.state.error} onReset={this.reset} label={this.props.label} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({
  error,
  onReset,
  label,
}: {
  error: Error;
  onReset: () => void;
  label?: string;
}): ReactNode {
  const isDev = import.meta.env.DEV;
  return (
    <div className="error-boundary">
      <div className="error-boundary-card">
        <h2>出错了{label ? `：${label}` : ''}</h2>
        <p className="muted">{error.message || '页面渲染时发生未知错误'}</p>
        {isDev && error.stack && (
          <details>
            <summary>堆栈信息（仅开发环境）</summary>
            <pre className="error-stack">{error.stack}</pre>
          </details>
        )}
        <div className="error-boundary-actions">
          <button type="button" className="mu-btn mu-btn-primary" onClick={onReset}>重试</button>
          <a className="mu-btn mu-btn-ghost" href="#/">回首页</a>
        </div>
      </div>
    </div>
  );
}
