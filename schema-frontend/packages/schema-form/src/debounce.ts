/**
 * 唯一性校验防抖（03FE §4 ④：输入停 500ms 再发远程探测）+ 提交防重。
 */

/** 500ms 防抖窗口（03FE 定版值）。 */
export const UNIQUE_DEBOUNCE_MS = 500;

/**
 * 防抖包装器：同一 fieldKey 的连续探测合并为末次调用；
 * 与 FormStore.validateUnique 的 last-call-wins 竞态防护叠加使用。
 */
export class DebouncedUniqueChecker {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 在途 Promise 的取消句柄（防抖取消时级联 resolve——不留悬挂 Promise）。 */
  private cancels = new Map<string, () => void>();

  constructor(
    private readonly checker: (fieldKey: string, value: unknown) => Promise<boolean>,
    private readonly waitMs: number = UNIQUE_DEBOUNCE_MS,
  ) {}

  /** 返回 Promise 在防抖到期后 resolve（组件卸载时 cancel 防泄漏）。 */
  check(fieldKey: string, value: unknown): Promise<boolean> {
    this.cancel(fieldKey);
    return new Promise<boolean>((resolve) => {
      // 取消句柄：被新调用顶替时立即 resolve(true)——旧探测结果作废，
      // 按可用处理（服务端提交时兜底校验）；不 resolve 则组件 .then 永挂
      this.cancels.set(fieldKey, () => resolve(true));
      const timer = setTimeout(async () => {
        this.timers.delete(fieldKey);
        this.cancels.delete(fieldKey);
        try {
          resolve(await this.checker(fieldKey, value));
        } catch {
          resolve(true); // 探测失败按可用处理——服务端提交时兜底校验
        }
      }, this.waitMs);
      this.timers.set(fieldKey, timer);
    });
  }

  cancel(fieldKey: string): void {
    const t = this.timers.get(fieldKey);
    if (t) {
      clearTimeout(t);
      this.timers.delete(fieldKey);
    }
    const cancelResolve = this.cancels.get(fieldKey);
    if (cancelResolve) {
      this.cancels.delete(fieldKey);
      cancelResolve(); // 级联取消——被顶替的旧探测不留悬挂 Promise
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const cancelResolve of this.cancels.values()) cancelResolve();
    this.cancels.clear();
  }
}

/** 提交防重护栏（03FE §5：进行中提交的按钮禁用语义由宿主消费）。 */
export class SubmitGuard {
  private submitting = false;

  /** 尝试进入提交态：已在提交中返回 false（重复点击拦截）。 */
  enter(): boolean {
    if (this.submitting) return false;
    this.submitting = true;
    return true;
  }

  /** 退出提交态（finally 必须调用——否则一次性死锁）。 */
  leave(): void {
    this.submitting = false;
  }

  get isSubmitting(): boolean {
    return this.submitting;
  }
}
