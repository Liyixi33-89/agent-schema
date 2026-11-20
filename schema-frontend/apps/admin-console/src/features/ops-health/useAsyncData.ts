/**
 * 请求状态 Hook（阶段 C 范例）：状态迁移逻辑全部下沉 asyncMachine.ts 纯函数——
 * 本文件只做调度（发起请求/定时器/序号递增），行为锁定由 asyncMachine.test.ts 保证。
 */
import React from 'react';
import { ASYNC_INIT, begin, fail, shouldAccept, succeed, type AsyncState } from './asyncMachine';

export type { AsyncState } from './asyncMachine';

/** 轮询周期常量（健康页 30s——与既有行为一致）。 */
export const HEALTH_POLL_MS = 30000;

/**
 * 单区域数据加载 Hook（带竞态/卸载防护）。
 * @param loader 数据获取函数（返回 null 表示响应契约校验不过——按「不可用」处理不抛错）
 * @param deps 重载依赖（变化即重新加载；卸载/依赖变化使在途响应序号失效）
 * @param pollMs 轮询周期（0=不轮询）；卸载清理定时器
 */
export function useAsyncData<T>(
  loader: () => Promise<T | null>,
  deps: React.DependencyList,
  pollMs = 0,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = React.useState<AsyncState<T>>(ASYNC_INIT as AsyncState<T>);
  /** 请求序号（竞态防护——只认最新序号的响应）。 */
  const seq = React.useRef(0);
  /** 卸载标记（异步回调落地前经 shouldAccept 检查）。 */
  const alive = React.useRef(true);
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

  React.useEffect(() => {
    alive.current = true;
    const effectSeq = ++seq.current;
    const run = () => {
      const thisSeq = ++seq.current;
      setState((s) => begin(s));
      loaderRef.current()
        .then((data) => {
          if (shouldAccept(seq.current, thisSeq, alive.current)) setState((s) => succeed(s, data));
        })
        .catch((e: unknown) => {
          if (shouldAccept(seq.current, thisSeq, alive.current)) setState((s) => fail(s, e));
        });
    };
    void effectSeq;
    run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (pollMs > 0) timer = setInterval(run, pollMs);
    return () => {
      alive.current = false;
      seq.current++; // 使在途响应失效
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = React.useCallback(() => {
    const mySeq = ++seq.current;
    setState((s) => begin(s));
    loaderRef.current()
      .then((data) => {
        if (shouldAccept(seq.current, mySeq, alive.current)) setState((s) => succeed(s, data));
      })
      .catch((e: unknown) => {
        if (shouldAccept(seq.current, mySeq, alive.current)) setState((s) => fail(s, e));
      });
  }, []);

  return { ...state, reload };
}
