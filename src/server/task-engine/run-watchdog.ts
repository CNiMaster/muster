export type RunFailureClassification = 'startup_timeout' | 'idle_timeout' | 'max_runtime' | 'network_errors' | 'empty_result' | 'approval_timeout' | 'process_exit' | 'auth_error';
export type RunWatchdogClassification = Extract<RunFailureClassification, 'startup_timeout' | 'idle_timeout' | 'max_runtime' | 'network_errors'>;

export class RunFailure extends Error {
  constructor(public readonly classification: RunFailureClassification, message: string = classification) {
    super(message);
    this.name = 'RunFailure';
  }
}

export class RunWatchdogTimeout extends RunFailure {
  constructor(classification: RunWatchdogClassification) {
    super(classification);
    this.name = 'RunWatchdogTimeout';
  }
}

export function classifyRunFailure(error: unknown): RunFailure {
  if (error instanceof RunFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  // 认证/凭据失效单独分类：不浪费重试，直接标记执行器不健康等用户修凭据（executor-failover）
  if (/\b40[13]\b|unauthorized|invalid[ _-]?(api[ _-]?key|token)|authentication|login[ _-]?(expired|required)|登录(已过期|失效)|凭据(无效|失效|错误)/i.test(message)) return new RunFailure('auth_error', message);
  if (/no valid AgentRunResult|empty result|undefined result|no result/i.test(message)) return new RunFailure('empty_result', message);
  if (/exited|exit code|signal|process.*closed|spawn.*failed/i.test(message)) return new RunFailure('process_exit', message);
  return new RunFailure('process_exit', message);
}

export interface RunWatchdogOptions {
  startupTimeoutMs: number;
  idleTimeoutMs: number;
  maxRuntimeMs: number;
  maxNetworkErrors?: number;
  abort: () => void | Promise<void>;
}

export class RunWatchdog {
  private startupTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private runtimeTimer?: ReturnType<typeof setTimeout>;
  private settled = false;
  private hasStarted = false;
  private networkErrors = 0;
  private rejectFailure!: (error: RunWatchdogTimeout) => void;
  readonly failure: Promise<never>;

  constructor(private readonly options: RunWatchdogOptions) {
    this.failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
    // 关键防御：failure 是被 Promise.race 竞态消费的 promise。一旦主路径（adapter.run）
    // 先 resolve/race 定型，race 不再监听本 promise，但已排队的 timer 回调仍可能在之后
    // 触发 rejectFailure，从而变成「未处理的 rejected promise」(Node 默认 throw 会杀进程)。
    // 这里挂一个永久的 no-op catch 吸收孤儿 rejection；engine 侧用 race 监听时仍能正常拿到错误。
    this.failure.catch(() => {});
    this.startupTimer = setTimeout(() => { void this.timeout('startup_timeout'); }, options.startupTimeoutMs);
    this.runtimeTimer = setTimeout(() => { void this.timeout('max_runtime'); }, options.maxRuntimeMs);
  }

  started(): void {
    if (this.settled || this.hasStarted) return;
    this.hasStarted = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.resetIdle();
  }

  activity(): void {
    if (this.settled) return;
    if (!this.hasStarted) this.started();
    this.networkErrors = 0;
    this.resetIdle();
  }

  networkError(): void {
    if (this.settled) return;
    this.networkErrors += 1;
    if (this.networkErrors >= (this.options.maxNetworkErrors ?? 3)) void this.timeout('network_errors');
  }

  complete(): void {
    this.settled = true;
    this.clearTimers();
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.timeout('idle_timeout'); }, this.options.idleTimeoutMs);
  }

  private async timeout(classification: RunWatchdogClassification): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    await this.options.abort();
    this.rejectFailure(new RunWatchdogTimeout(classification));
  }

  private clearTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
  }
}
