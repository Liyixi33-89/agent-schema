/**
 * 异步调度核心（框架无关——可脱离 React 单测）：
 * 负责请求发起、竞态序号、真实取消、非重叠轮询、查询身份重置。
 * useAsyncData 只是把本控制器接到 React state 上的薄壳。
 *
 * 关键约定：
 * - 轮询**不重叠**：上一次请求 settle 后才调度下一次（慢请求不会堆积）；
 * - 真实取消：新请求/停止时 abort 在途请求（不只是忽略响应）；
 * - 查询身份变化 → reset（旧数据属于另一个查询）；仅轮询周期变化 → 保留数据；
 * - 取消（AbortError）不迁移状态。
 */
import {
  begin, fail, isAbortError, reset, shouldAccept, succeed, type AsyncState,
} from './asyncMachine';

export interface AsyncControllerOptions<T> {
  loader: (signal: AbortSignal) => Promise<T>;
  /** 状态更新回调（React 侧传 setState；测试侧传收集器）。 */
  onState: (updater: (prev: AsyncState<T>) => AsyncState<T>) => void;
  /** 轮询周期（0=不轮询）。 */
  pollMs?: number;
  /** 定时器注入（测试用假定时器；默认全局 setTimeout/clearTimeout）。 */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export class AsyncController<T> {
  private seq = 0;
  private alive = false;
  private abort: AbortController | null = null;
  private timer: unknown = null;
  private identity: string | null = null;
  private readonly loader: (signal: AbortSignal) => Promise<T>;
  private readonly onState: AsyncControllerOptions<T>['onState'];
  private readonly pollMs: number;
  private readonly timers: NonNullable<AsyncControllerOptions<T>['timers']>;

  constructor(opts: AsyncControllerOptions<T>) {
    this.loader = opts.loader;
    this.onState = opts.onState;
    this.pollMs = opts.pollMs ?? 0;
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  /** 启动/切换查询身份：identity 变化 → 重置；相同 → 保留数据刷新。 */
  start(identity: string): void {
    this.alive = true;
    if (this.identity !== identity) {
      this.identity = identity;
      this.onState(() => reset<T>());
    }
    this.runOnce();
  }

  /** 手动重试（保留旧数据，标 refreshing）。 */
  reload(): void {
    if (!this.alive) return;
    this.runOnce();
  }

  /** 停止：使在途响应失效、真实取消、清定时器。 */
  stop(): void {
    this.alive = false;
    this.seq++;
    this.abort?.abort();
    this.abort = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private runOnce(): void {
    if (!this.alive) return;
    this.clearTimer();
    this.abort?.abort();               // 真实取消上一次在途请求
    const ctrl = new AbortController();
    this.abort = ctrl;
    const mySeq = ++this.seq;
    this.onState((s) => begin(s));
    this.loader(ctrl.signal)
      .then((data) => {
        if (shouldAccept(this.seq, mySeq, this.alive)) this.onState((s) => succeed(s, data));
      })
      .catch((e: unknown) => {
        if (isAbortError(e)) return;   // 取消不是失败
        if (shouldAccept(this.seq, mySeq, this.alive)) this.onState((s) => fail(s, e));
      })
      .finally(() => {
        // 仅最新请求负责调度下一次（旧请求晚回不重复排程 → 不重叠）
        if (!shouldAccept(this.seq, mySeq, this.alive)) return;
        if (this.pollMs > 0) this.timer = this.timers.setTimeout(() => this.runOnce(), this.pollMs);
      });
  }
}