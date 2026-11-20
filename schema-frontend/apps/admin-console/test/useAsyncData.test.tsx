/**
 * 异步调度核心测试（阶段 C 范例）：直接测 AsyncController（框架无关），
 * 真实覆盖：查询身份重置、相同查询刷新保留数据、轮询不重叠、真实取消、卸载停止。
 * 策略：注入假定时器 + 手动 resolve 的 Promise，零新增依赖（不引 jsdom）。
 */
import { describe, expect, it, vi } from 'vitest';
import { AsyncController } from '../src/shared/async/asyncController';
import { ASYNC_INIT, type AsyncState } from '../src/shared/async/asyncMachine';
import { HEALTH_POLL_MS } from '../src/shared/async/useAsyncData';

/** 收集状态迁移的宿主（模拟 React setState）。 */
function makeHost<T>() {
  let state: AsyncState<T> = { ...ASYNC_INIT } as AsyncState<T>;
  return {
    onState: (updater: (prev: AsyncState<T>) => AsyncState<T>) => { state = updater(state); },
    get: () => state,
  };
}

/** 假定时器（手动触发；用显式 cleared 标记，避免依赖函数 toString 的转译差异）。 */
function makeTimers() {
  const queue: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => { queue.push({ fn, ms, cleared: false }); return queue.length - 1; },
      clearTimeout: (h: unknown) => { const i = h as number; if (queue[i]) queue[i].cleared = true; },
    },
    pending: () => queue.filter((q) => !q.cleared).length,
    fire: () => { const q = queue.find((x) => !x.cleared); if (q) { q.cleared = true; q.fn(); } },
  };
}

/** 可手动控制的 Promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AsyncController · 查询身份', () => {
  it('身份变化 → 重置（旧数据不保留）', async () => {
    const host = makeHost<number>();
    const d1 = deferred<number>();
    const loader = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(Promise.resolve(2));
    const c = new AsyncController<number>({ loader, onState: host.onState });
    c.start('2026-11');
    d1.resolve(1);
    await flush();
    expect(host.get().data).toBe(1);
    // 切到另一个月份：重置后旧数据清空
    c.start('2026-12');
    expect(host.get().data).toBeNull();
    expect(host.get().loading).toBe(true);
    await flush();
    expect(host.get().data).toBe(2);
  });

  it('相同身份刷新 → 保留旧数据并标 refreshing', async () => {
    const host = makeHost<number>();
    const d2 = deferred<number>();
    const loader = vi.fn().mockReturnValueOnce(Promise.resolve(1)).mockReturnValueOnce(d2.promise);
    const c = new AsyncController<number>({ loader, onState: host.onState });
    c.start('same');
    await flush();
    expect(host.get().data).toBe(1);
    c.reload();
    expect(host.get().data).toBe(1);        // 旧数据保留
    expect(host.get().refreshing).toBe(true);
    d2.resolve(2);
    await flush();
    expect(host.get().data).toBe(2);
    expect(host.get().refreshing).toBe(false);
  });
});

describe('AsyncController · 轮询不重叠', () => {
  it('上一次未完成时不调度下一次', async () => {
    const host = makeHost<number>();
    const t = makeTimers();
    const d1 = deferred<number>();
    const loader = vi.fn().mockReturnValueOnce(d1.promise);
    const c = new AsyncController<number>({ loader, onState: host.onState, pollMs: 1000, timers: t.timers });
    c.start('x');
    await flush();
    expect(t.pending()).toBe(0);            // 请求未完成 → 无定时器
    d1.resolve(1);
    await flush();
    expect(t.pending()).toBe(1);            // 完成后才排下一次
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('AsyncController · 真实取消', () => {
  it('新请求发起时 abort 上一次在途请求', async () => {
    const host = makeHost<number>();
    const signals: AbortSignal[] = [];
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<number>(() => {}); // 永不 resolve
    });
    const c = new AsyncController<number>({ loader, onState: host.onState });
    c.start('x');
    c.reload();
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);  // 第一次被真实取消
    expect(signals[1].aborted).toBe(false);
  });

  it('stop 时 abort 在途请求并清定时器', async () => {
    const host = makeHost<number>();
    const t = makeTimers();
    let captured: AbortSignal | null = null;
    const loader = vi.fn((signal: AbortSignal) => { captured = signal; return Promise.resolve(1); });
    const c = new AsyncController<number>({ loader, onState: host.onState, pollMs: 1000, timers: t.timers });
    c.start('x');
    await flush();
    expect(t.pending()).toBe(1);
    c.stop();
    expect(captured!.aborted).toBe(true);
    expect(t.pending()).toBe(0);
  });

  it('取消（AbortError）不迁移为错误态', async () => {
    const host = makeHost<number>();
    const loader = vi.fn(() => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    });
    const c = new AsyncController<number>({ loader, onState: host.onState });
    c.start('x');
    await flush();
    expect(host.get().error).toBeNull();
    expect(host.get().forbidden).toBe(false);
  });
});

describe('常量基线', () => {
  it('健康页轮询 30s', () => {
    expect(HEALTH_POLL_MS).toBe(30000);
  });
});